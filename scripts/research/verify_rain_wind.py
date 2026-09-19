"""independently replay the matched wind-vector rain experiment."""


import argparse
import datetime as dt
import json
import math
import os
import struct
from pathlib import Path

# constrain native reductions before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import evaluate_rain_goal as goal
import numpy as np
import verify_rain_direction_recovery as recovery_audit
import verify_rain_direction_source as direction_audit
import verify_rain_wind_continuation as source_audit
import xgboost as xgb
from rain_search import POLICY as SEARCH_POLICY
from rain_wind import POLICY, SOURCE_FILES
from verify_rain_context import build_features as build_context
from verify_rain_context import feature_sets, load_profiles
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_hurdle import calibrate_hurdle, predict_hurdle
from verify_rain_recency import MONTHS, effective_support, recent_weights, sha
from verify_rain_search import (
    check_booster,
    checked_rules,
    head_support,
    month_masks,
    ordinal_rules,
    support,
)
from verify_rain_sub24_model import metrics, require, weights
from verify_rain_trajectory import (
    HEADS,
    ORIGINAL_ARMS,
    TENDENCY_NAMES,
    build_tendencies,
    load_tendencies,
    native_predict,
)
from verify_rain_trajectory import (
    check_freeze as check_trajectory_freeze,
)

PRIMARY = "hurdleWind"
PARENT_PRIMARY = "hurdleTrajectory"
ROOT_NAME = "weather-moisture-research-rain-wind-20260913-v1"
WIND_NAMES = (
    "windU",
    "windV",
    "windUChange3h",
    "windVChange3h",
    "windUNext3hChange",
    "windVNext3hChange",
)
ARMS = (*ORIGINAL_ARMS, "hurdleOriginal", "trajectoryOriginal", PRIMARY)
SOURCE_RELATIVE = "normalized/ecmwf_single_run_wind_direction.jsonl"
SOURCE_RUNS = 3301
SOURCE_ROWS = 158448
SOURCE_FIELDS = frozenset(
    (
        "cohort",
        "key",
        "runInitializedAt",
        "validAt",
        "targetLeadHours",
        "rawPrecipitationMm",
        "rawWindDirectionDegrees",
        "directionSourceStatus",
        "returnedGrid",
        "responseSha256",
        "responseReceivedAtUtc",
        "actualIssueAt",
    )
)
ROUNDS = 160


# derive an original source hour without accepting timezone aliases
def source_hour(value):
    instant = direction_audit.utc_time(value)
    require(
        value == instant.strftime("%Y-%m-%dT%H:%M:%SZ")
        and instant.minute == instant.second == instant.microsecond == 0,
        "wind source initialized hour changed",
    )
    return int(instant.timestamp() // 3600)


# preserve source nulls while rejecting invented or invalid measurements
def measurement(value, maximum):
    # keep explicit missing directions and original rain values distinct from zero
    if value is None:
        return math.nan
    require(
        type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum,
        "invalid wind supplement measurement",
    )
    return float(value)


# parse every normalized lead independently of the producer's join helper
def load_directions(path, expected_sha, originals, context, trajectory):
    path = Path(path)
    require(sha(path) == expected_sha, "wind supplement source bytes changed")
    body = path.read_bytes()
    lines = body.splitlines()
    require(
        len(lines) == SOURCE_ROWS
        and len(originals) == SOURCE_RUNS
        and set(context) == set(trajectory),
        "wind supplement source coverage changed",
    )
    profiles = {}
    # bind all forty-eight chronological leads to each original initialized run
    for run_index, original in enumerate(originals):
        initialized = source_hour(original["initialized"])
        require(
            initialized in context and initialized in trajectory,
            "wind supplement original run missing",
        )
        rain = context[initialized]["rain"]
        wind = trajectory[initialized]["wind"]
        require(
            rain.shape == wind.shape == (48,)
            and rain.dtype == wind.dtype == np.dtype(np.float64),
            "wind original profile shape changed",
        )
        directions = np.empty(48, dtype=np.float64)
        statuses = []
        response_sha = None
        received = None
        # validate every joined row and preserve nullable direction values
        for lead in range(1, 49):
            row = direction_audit.strict_json(lines[run_index * 48 + lead - 1])
            require(
                isinstance(row, dict)
                and set(row) == SOURCE_FIELDS
                and row["cohort"] == direction_audit.COHORT
                and row["runInitializedAt"] == original["initialized"]
                and row["key"]
                == f'{direction_audit.COHORT}|{original["run"]}|lead={lead}'
                and type(row["targetLeadHours"]) is int
                and row["targetLeadHours"] == lead
                and row["validAt"]
                == (
                    direction_audit.utc_time(original["initialized"])
                    + dt.timedelta(hours=lead)
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
                and row["returnedGrid"]
                == {"latitude": original["grid"][0], "longitude": original["grid"][1]}
                and row["actualIssueAt"] is None,
                "wind supplement lead identity changed",
            )
            # one initialized run must come from one retained raw response
            if response_sha is None:
                response_sha = row["responseSha256"]
                received = row["responseReceivedAtUtc"]
            require(
                row["responseSha256"] == response_sha
                and row["responseReceivedAtUtc"] == received,
                "wind supplement response provenance changed",
            )
            forecast = measurement(row["rawPrecipitationMm"], 2000)
            original_rain = float(rain[lead - 1])
            require(
                (math.isnan(forecast) and math.isnan(original_rain))
                or struct.pack(">d", forecast) == struct.pack(">d", original_rain),
                "wind supplement precipitation changed",
            )
            direction = measurement(row["rawWindDirectionDegrees"], 360)
            status = row["directionSourceStatus"]
            require(
                status in {"available", "providerNull", "notRequested", "transportUnresolved"}
                and (math.isfinite(direction) == (status == "available")),
                "wind direction value disagrees with source status",
            )
            directions[lead - 1] = direction
            statuses.append(status)
        observed = {"available", "providerNull"}
        # one run is full old source, short new source or explicit transport unknown
        require(
            all(status in observed for status in statuses)
            or (all(status in observed for status in statuses[:34]) and statuses[34:] == ["notRequested"] * 14)
            or statuses == ["transportUnresolved"] * 48,
            "wind direction source status pattern changed",
        )
        profiles[initialized] = {"wind": wind, "direction": directions}
    require(sha(path) == expected_sha, "wind supplement changed during extraction")
    return profiles


# convert meteorological wind-from direction into eastward and northward flow
def components(speed, direction):
    # a missing direction is not inferred from a calm reported speed
    if not math.isfinite(speed) or not math.isfinite(direction):
        return math.nan, math.nan
    radians = math.radians(direction % 360)
    return -speed * math.sin(radians), -speed * math.cos(radians)


# append six same-run vector features using only issued forecasts
def build_wind(data, full101, profiles, old_names):
    size = len(full101)
    require(
        full101.shape == (size, 101)
        and full101.dtype == np.dtype(np.float32)
        and all(data[name].shape == (size,) for name in ("initialized", "lead", "hour"))
        and isinstance(profiles, dict),
        "wind paired feature shape changed",
    )
    extended = np.empty((size, 107), dtype=np.float32)
    extended[:, :101] = full101
    available = np.zeros(size, dtype=bool)
    raw_wind_index = old_names.index("rawWind")
    # preserve every decision row even when one vector component is missing
    for index in range(size):
        initialized = int(data["initialized"][index])
        lead = 8 + int(data["lead"][index])
        require(
            9 <= lead <= 31 and initialized + lead == int(data["hour"][index]),
            "wind paired valid hour changed",
        )
        # the independently verified supplement must contain this exact run
        require(initialized in profiles, "missing original wind run")
        profile = profiles[initialized]
        speed = profile["wind"][lead - 1]
        paired = full101[index, raw_wind_index]
        require(
            (math.isnan(speed) and math.isnan(paired))
            or np.float32(speed) == paired,
            "wind speed differs from paired original feature",
        )
        past = components(profile["wind"][lead - 4], profile["direction"][lead - 4])
        current = components(speed, profile["direction"][lead - 1])
        future = components(profile["wind"][lead + 2], profile["direction"][lead + 2])
        values = (
            current[0],
            current[1],
            current[0] - past[0],
            current[1] - past[1],
            future[0] - current[0],
            future[1] - current[1],
        )
        # cast once after float64 trigonometry and differences
        extended[index, 101:] = np.asarray(values, dtype=np.float32)
        available[index] = bool(np.isfinite(values).all())
    return extended, {"windVectorAvailable": available}


# require the resumed source to qualify without laundering the failed parent
def check_source_result(source_result, source_report):
    require(
        source_result["contractVersion"] == "rain-wind-continuation-verification/v1"
        and source_result["verdict"] == "PASS"
        and source_result["sourceQualified"] is True
        and source_result["parentSourceQualified"] is False
        and source_result["parentTransportPolicyConformant"] is False
        and source_result["inheritedSpacingViolationCount"] == 25
        and source_result["uniqueRepresentedRuns"] == 3301
        and type(source_result["newUnresolvedRuns"]) is int
        and 0 <= source_result["newUnresolvedRuns"] <= 33
        and source_result["uniqueSuccessfulRuns"] == 3301 - source_result["newUnresolvedRuns"]
        and source_result["inheritedFullResponses"] == 113
        and source_result["inheritedShortResponses"] == 1600
        and source_result["newSuccessfulRuns"] == 1588 - source_result["newUnresolvedRuns"]
        and source_result["parentHttpAttempts"] == 1716
        and type(source_result["newHttpAttempts"]) is int
        and 1588 <= source_result["newHttpAttempts"] <= 3176
        and source_result["totalHttpAttempts"] == 1716 + source_result["newHttpAttempts"]
        and source_result["normalizedRows"] == 158448
        and source_result["responseLineageRows"] == 3301
        and source_result["historicalAsIssuedVerified"] is False
        and source_result["freshHoldoutVerified"] is False
        and source_result["modelGatesEvaluated"] is False
        and source_result["productionEligible"] is False
        and source_result["verifierSourceSha256"] == sha(source_audit.__file__)
        and source_report["contractVersion"] == "rain-wind-continuation/v1"
        and source_report["status"] == "complete"
        and source_report["sourceQualified"] is True
        and source_report["parentSourceQualified"] is False
        and source_report["parentTransportPolicyConformant"] is False
        and source_report["inheritedSpacingViolationCount"] == 25
        and source_report["newUnresolvedRuns"] == source_result["newUnresolvedRuns"]
        and source_report["perMonthCoverage"]
        and all(bucket["qualified"] is True for bucket in source_report["perMonthCoverage"].values()),
        "wind source audit incomplete",
    )
    # the source auditor has independently rebuilt this reported month coverage
    return {**source_result, "perMonthCoverage": source_report["perMonthCoverage"]}


# bind the new wind freeze to every inherited source and verified raw response
def check_freeze(root, old_names):
    parent_freeze, cohort = check_trajectory_freeze(root, old_names)
    freeze = json.loads((root / "wind-freeze.json").read_text())
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(WIND_NAMES)
    require(
        freeze["policy"] == POLICY
        and POLICY["contractVersion"] == "rain-wind-vector-development/v1"
        and POLICY["primary"] == PRIMARY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["featureNames"] == names
        and POLICY["windVectorFeatures"] == list(WIND_NAMES)
        and POLICY["boostRounds"] == ROUNDS
        and POLICY["nativeModelsFit"] == 48,
        "wind experiment policy changed",
    )
    require(
        freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == names
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"]
        == POLICY["parentPins"]["trajectory-freeze.json"]
        == sha(root / "trajectory-freeze.json")
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False
        and set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "wind experiment freeze changed",
    )
    # compare every current source against its pre-outcome retained bytes
    for name, digest in freeze["sourceSha256"].items():
        relative = Path(name)
        live = Path(__file__).with_name(name)
        saved = root / "wind-sources" / name
        require(
            len(relative.parts) == 1
            and relative.suffix == ".py"
            and live.is_file()
            and not live.is_symlink()
            and saved.is_file()
            and not saved.is_symlink()
            and sha(live) == digest
            and sha(saved) == digest,
            f"wind producer source changed: {name}",
        )
    # reject changed inherited inputs before reading a new outcome
    for name, digest in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        require(
            not relative.is_absolute()
            and ".." not in relative.parts
            and saved.is_file()
            and not saved.is_symlink()
            and sha(saved) == digest,
            f"wind inherited input changed: {name}",
        )
    require(
        freeze["inputSha256"]["trajectory-freeze.json"]
        == POLICY["parentPins"]["trajectory-freeze.json"]
        and freeze["inputSha256"]["inputs/trajectory/report.json"]
        == POLICY["parentPins"]["report.json"]
        and freeze["inputSha256"]["inputs/trajectory/predictions.npz"]
        == POLICY["parentPins"]["predictions.npz"],
        "wind parent control identity changed",
    )
    prior = json.loads((root / "inputs/trajectory/report.json").read_text())
    proof = json.loads(
        (
            root / "inputs/trajectory/final-evidence/independent-verification-final.json"
        ).read_text()
    )
    require(
        prior["freezeSha256"] == POLICY["parentPins"]["trajectory-freeze.json"]
        and prior["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and proof["verified"] is True
        and proof["all49GatesVerified"] is True
        and proof["nativeModelsRefit"] == 48
        and proof["reportSha256"] == POLICY["parentPins"]["report.json"]
        and proof["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and proof["productionEligible"] is False,
        "wind parent independent proof changed",
    )
    # replay all copied direction bodies before accepting joined predictors
    source_root = root / "inputs/direction"
    source_result = source_audit.audit_snapshot(source_root)
    source_report = json.loads((source_root / "report.json").read_text())
    source_proof = json.loads(
        (source_root / "final-evidence/independent-verification.json").read_text()
    )
    # the copied first-party audit and the new full replay must bind the same bytes
    require(set(source_proof) == set(source_result), "wind source proof schema changed")
    # the verification timestamp is new but every replayed source value is fixed
    for name in source_result:
        # compare all content, lineage and explicit nonqualification fields
        if name == "verifiedAtUtc":
            continue
        require(source_proof[name] == source_result[name], f"wind source proof changed: {name}")
    require(source_result["reportSha256"] == sha(source_root / "report.json")
            and source_result["freezeSha256"] == sha(source_root / "wind-continuation-freeze.json")
            and source_result["normalizedSha256"] == sha(source_root / SOURCE_RELATIVE)
            and source_result["responseLineageSha256"] == sha(source_root / "response-lineage.jsonl"),
            "wind source copied report or output changed")
    source_result = check_source_result(source_result, source_report)
    return freeze, parent_freeze, cohort, source_result


# refit every 107-feature native event and amount head independently
def refit_heads(root, full, names, actual, hours, month):
    require(
        xgb.__version__ == POLICY["xgboostVersion"]
        and full.dtype == np.dtype(np.float32)
        and full.shape == (len(hours), 107)
        and names == POLICY["featureNames"]
        and "base_score" not in SEARCH_POLICY["parameters"],
        "wind native schema or runtime changed",
    )
    directory = root / "wind-models" / month
    mass = weights(hours) * len(hours)
    state = {"featureNames": names, "rounds": ROUNDS, "heads": {}}
    models = {}
    # retain exact original event targets and their support fallbacks
    for name, threshold, filename in HEADS:
        counts = head_support(actual, hours, threshold)
        record = {
            "objective": "binary:logistic",
            "support": counts,
            "modelFile": None,
            "sha256": None,
            "reason": "insufficient_positive_support",
        }
        models[name] = None
        # fit each supported event using balanced original training mass
        if counts["positiveHours"] >= 10 and counts["positiveDates"] >= 3:
            matrix = xgb.DMatrix(
                full,
                label=(actual >= threshold).astype(np.float32),
                weight=mass,
                feature_names=names,
                nthread=1,
            )
            booster = xgb.train(
                {**SEARCH_POLICY["parameters"], "objective": "binary:logistic"},
                matrix,
                num_boost_round=ROUNDS,
            )
            path = directory / filename
            digest = sha(path)
            check_booster(booster, path, digest, "binary:logistic", ROUNDS, names)
            record.update({"modelFile": filename, "sha256": digest, "reason": "fitted"})
            models[name] = booster
        else:
            require(
                not (directory / filename).exists(),
                f"unexpected unsupported wind event head: {month}:{name}",
            )
        state["heads"][name] = record
    wet = actual >= 0.1
    counts = head_support(actual, hours, 0.1)
    record = {
        "objective": "reg:gamma",
        "support": counts,
        "modelFile": None,
        "sha256": None,
        "reason": "insufficient_wet_support",
    }
    models["amount"] = None
    # rebalance the wet-only gamma head within its own fitted subset
    if counts["positiveHours"] >= 100 and counts["positiveDates"] >= 20:
        matrix = xgb.DMatrix(
            full[wet],
            label=actual[wet],
            weight=weights(hours[wet]) * int(wet.sum()),
            feature_names=names,
            nthread=1,
        )
        booster = xgb.train(
            {**SEARCH_POLICY["parameters"], "objective": "reg:gamma"},
            matrix,
            num_boost_round=ROUNDS,
        )
        path = directory / "amount.json"
        digest = sha(path)
        check_booster(booster, path, digest, "reg:gamma", ROUNDS, names)
        record.update({"modelFile": "amount.json", "sha256": digest, "reason": "fitted"})
        models["amount"] = booster
    else:
        require(
            not (directory / "amount.json").exists(),
            f"unexpected unsupported wind gamma head: {month}",
        )
    state["heads"]["amount"] = record
    return models, state


# reconstruct monthly chronology, calibrations and unselected fallbacks
def replay_month(root, data, full, names, old_policy, month, old_ordinal):
    fit, calibration, evaluation, bounds = month_masks(
        data, month, old_policy, SEARCH_POLICY
    )
    actual, hours = data["actual"][calibration], data["hour"][calibration]
    counts = {
        "training": support(data["actual"][fit], data["hour"][fit]),
        "calibration": support(actual, hours),
    }
    mass = recent_weights(hours, bounds["calibrationMaximumValidHourExclusive"])
    effective = effective_support(actual, hours, mass)
    supported = (
        all(
            counts["training"][key] >= value
            for key, value in POLICY["trainingSupport"].items()
        )
        and all(
            counts["calibration"][key] >= value
            for key, value in POLICY["calibrationSupport"].items()
        )
        and all(
            effective[key] >= value for key, value in POLICY["effectiveSupport"].items()
        )
    )
    state = {
        **bounds,
        "support": counts,
        "effectiveSupport": effective,
        "supported": bool(supported),
        "model": None,
        "proposedRules": None,
        "uniformRules": None,
        "nestingSafetyFallback": None,
        "calibration": None,
        "reason": "insufficient_support",
    }
    rows = np.where(evaluation)[0]
    # unsupported months keep the exact old ordinal forecast for every row
    if not supported:
        require(
            not (root / "wind-models" / month).exists(),
            f"unexpected unsupported wind fit: {month}",
        )
        predicted = old_ordinal.copy()
    else:
        models, model_state = refit_heads(
            root, full[fit], names, data["actual"][fit], data["hour"][fit], month
        )
        pc, ac = native_predict(models, full[calibration], names)
        pe, ae = native_predict(models, full[evaluation], names)
        require(
            np.isfinite(ac).all() and np.isfinite(ae).all(),
            f"missing supported wind gamma: {month}",
        )
        raw_cal, raw_eval = (
            data["raw"][calibration].astype(float),
            data["raw"][evaluation].astype(float),
        )
        proposed = ordinal_rules(actual, raw_cal, pc, hours, SEARCH_POLICY)
        uniform, fallback = checked_rules(
            actual, raw_cal, pc, hours, proposed, SEARCH_POLICY
        )
        base_cal = np.clip(0.25 * raw_cal + 0.75 * ac, 0, 30)
        base_eval = np.clip(0.25 * raw_eval + 0.75 * ae, 0, 30)
        fitted = calibrate_hurdle(
            actual,
            hours,
            raw_cal,
            pc,
            base_cal,
            uniform,
            bounds["calibrationMaximumValidHourExclusive"],
        )
        predicted = predict_hurdle(raw_eval, pe, base_eval, fitted)
        state.update(
            {
                "model": model_state,
                "proposedRules": proposed,
                "uniformRules": uniform,
                "nestingSafetyFallback": fallback,
                "calibration": fitted,
                "reason": "wind_vector_hurdle_calibrated",
            }
        )
    same_tree(
        state,
        json.loads((root / "wind-states" / f"{month}.json").read_text()),
        f"windState.{month}",
    )
    return rows, predicted, state


# replay all original decision months and retain fourteen matched arms
def replay_all(root, data, full, names, old_policy):
    # retain every matched parent forecast without recalculating it
    with np.load(root / "inputs/trajectory/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        original = {name: old["amount::" + name] for name in ORIGINAL_ARMS}
        original["hurdleOriginal"] = old["amount::hurdleOriginal"]
        original["trajectoryOriginal"] = old["amount::" + PARENT_PRIMARY]
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # retain complete predetermined evaluation months and raw fallback rows
    for month in MONTHS:
        _, _, evaluation, _ = month_masks(data, month, old_policy, SEARCH_POLICY)
        end = offset + int(evaluation.sum())
        rows, predicted, state = replay_month(
            root,
            data,
            full,
            names,
            old_policy,
            month,
            original["ordinal90"][offset:end],
        )
        require(
            np.array_equal(rows, reference_indices[offset:end]),
            f"wind month population changed: {month}",
        )
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state["supported"], dtype=bool))
        states[month] = state
        offset = end
    indices, flags = np.concatenate(indices), np.concatenate(flags)
    require(
        offset == 32896
        and len(np.unique(indices)) == offset
        and np.array_equal(indices, reference_indices),
        "wind development population changed",
    )
    return indices, {**original, PRIMARY: np.concatenate(amounts)}, flags, states


# score every reported partition and derive the same fixed forty-nine gates
def expected_report(root, data, old_policy, indices, amounts, flags, states, availability, source_result):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    view = goal.gate_view(scores, PRIMARY)
    screen = goal.independent_gate(view, data, indices, flags)
    require(len(screen["gates"]) == 49, "wind fixed gate count changed")
    hours = data["hour"][indices]
    native_count = sum(
        sum(head["modelFile"] is not None for head in state["model"]["heads"].values())
        for state in states.values()
        if state["model"] is not None
    )
    return {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "freezeSha256": sha(root / "wind-freeze.json"),
        **scores,
        "monthlyStates": states,
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "treeFitPerformed": True,
        "nativeModelsReused": 0,
        "nativeModelsFit": native_count,
        "meanTargetSensitivity": {
            name: metrics(
                data["mean"][indices], value, (value >= 0.1).astype(float), hours
            )
            for name, value in amounts.items()
        },
        "candidateScreen": screen,
        "selectedCandidate": PRIMARY if screen["passed"] else None,
        "developmentPassed": bool(screen["passed"]),
        "decision": "prospective_hypothesis_only_not_qualified"
        if screen["passed"]
        else "no_candidate_selected_all_failures_retained",
        "referenceParity": {
            "exactPredictions": True,
            "arms": {
                **{name: name for name in ORIGINAL_ARMS},
                "hurdleOriginal": "hurdleOriginal",
                "trajectoryOriginal": PARENT_PRIMARY,
            },
        },
        "featuresSha256": sha(root / "features.npz"),
        "originalFeaturesSha256": sha(root / "inputs/trajectory/features.npz"),
        "directionSourceSha256": source_result["normalizedSha256"],
        "directionSourceCoverage": {
            "unresolvedRuns": source_result["newUnresolvedRuns"],
            "perMonthCoverage": source_result["perMonthCoverage"],
        },
        "windAvailability": {
            "evaluationRows": int(availability["windVectorAvailable"][indices].sum()),
            "evaluationTotal": len(indices),
            "featureColumns": 107,
        },
        "predictionsSha256": sha(root / "predictions.npz"),
    }


# prove source, features, forty-eight fits, every forecast and gate from bytes
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(
        root.name == ROOT_NAME
        and old_freeze["featureNames"] == old_names
        and len(data["actual"]) > 32896,
        "wind private root or original paired schema changed",
    )
    _, _, cohort, source_result = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(WIND_NAMES)
    original_source = root / "inputs/context/inputs/trajectory.jsonl"
    context = load_profiles(original_source, cohort)
    matrices, old_availability = build_context(data, context, old_names)
    # compare all original context values with their archived feature matrix
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *old_availability}
            and np.array_equal(saved["x"], matrices["full"], equal_nan=True),
            "wind original 95-feature matrix changed",
        )
        # compare all retained source-only availability flags
        for name, expected in old_availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"wind original availability changed: {name}",
            )
    trajectory = load_tendencies(original_source, context, cohort)
    full101, trajectory_availability = build_tendencies(
        data, matrices["full"], trajectory, old_names
    )
    # compare all retained trajectory values before adding new columns
    with np.load(root / "inputs/trajectory/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *trajectory_availability}
            and np.array_equal(saved["x"], full101, equal_nan=True),
            "wind inherited 101-feature matrix changed",
        )
        # compare retained same-run tendency missingness
        for name, expected in trajectory_availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"wind inherited tendency availability changed: {name}",
            )
    source_report = json.loads((root / "inputs/direction/report.json").read_text())
    require(
        source_report["normalizedFile"] == SOURCE_RELATIVE
        and source_report["normalizedSha256"] == source_result["normalizedSha256"]
        and source_report["responseLineageFile"] == "response-lineage.jsonl"
        and source_report["responseLineageSha256"]
        == source_result["responseLineageSha256"],
        "wind source supplement report changed",
    )
    # reconstruct original run identities only from the byte-copied source tree
    source_root = root / "inputs/direction"
    originals = recovery_audit.original_profiles(
        source_root / "inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root"
    )
    profiles = load_directions(
        root / "inputs/direction" / SOURCE_RELATIVE,
        source_result["normalizedSha256"],
        originals,
        context,
        trajectory,
    )
    full, availability = build_wind(data, full101, profiles, old_names)
    # bind every new vector and missingness flag to the frozen matrix
    with np.load(root / "features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *trajectory_availability, *availability}
            and saved["x"].dtype == np.dtype(np.float32)
            and np.array_equal(saved["x"], full, equal_nan=True),
            "wind 107-feature material changed",
        )
        # recompute all six-vector and inherited tendency support flags
        for name, expected in {**trajectory_availability, **availability}.items():
            require(np.array_equal(saved[name], expected), f"wind availability changed: {name}")
    indices, amounts, flags, states = replay_all(root, data, full, names, old_policy)
    # compare the entire fourteen-arm decision population
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(
            set(saved.files)
            == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS}
            and np.array_equal(saved["indices"], indices)
            and saved["candidateSupported"].dtype == np.dtype(bool)
            and np.array_equal(saved["candidateSupported"], flags),
            "wind prediction population changed",
        )
        # compare all matched controls exactly and only the new arm numerically
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(
                observed.shape == expected.shape
                and np.isfinite(observed).all()
                and (observed >= 0).all(),
                f"wind prediction malformed: {name}",
            )
            require(
                (
                    np.allclose(observed, expected, rtol=1e-8, atol=1e-9)
                    if name == PRIMARY
                    else np.array_equal(observed, expected)
                ),
                f"wind prediction replay changed: {name}",
            )
    expected = expected_report(
        root,
        data,
        old_policy,
        indices,
        amounts,
        flags,
        states,
        availability,
        source_result,
    )
    reported = json.loads((root / "report.json").read_text())
    sections = (
        "overall",
        "byLeadBand",
        "bySeason",
        "byMonth",
        "byArchiveEra",
        "events",
        "accumulations",
        "invariants",
    )
    goal.recomputed_gates(
        reported,
        {name: expected[name] for name in sections},
        data,
        indices,
        flags,
        PRIMARY,
    )
    same_tree(expected, reported, "windReport")
    require(
        expected["nativeModelsFit"] == 48
        and len(states) == 12
        and len(profiles) == 3301,
        "wind native fit or source run count changed",
    )
    receipt = {
        "contractVersion": "rain-wind-independent-verification/v1",
        "verified": True,
        "privateRoot": str(root),
        "verifierSourceSha256": sha(__file__),
        "sourceRawResponsesVerified": source_result["uniqueSuccessfulRuns"],
        "sourceHttpAttemptsVerified": source_result["totalHttpAttempts"],
        "sourceReusedRunsVerified": source_result["inheritedFullResponses"] + source_result["inheritedShortResponses"],
        "sourceUnresolvedRunsVerified": source_result["newUnresolvedRuns"],
        "sourceProfilesVerified": len(profiles),
        "featureRowsVerified": len(data["actual"]),
        "featureColumnsVerified": len(names),
        "monthlyStatesVerified": len(states),
        "nativeModelsRefit": expected["nativeModelsFit"],
        "developmentPredictionRows": len(indices),
        "all49GatesVerified": True,
        "referenceParityVerified": True,
        "selectedCandidate": expected["selectedCandidate"],
        "developmentPassed": expected["developmentPassed"],
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "freezeSha256": sha(root / "wind-freeze.json"),
        "reportSha256": sha(root / "report.json"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    # preserve previous verification attempts by requiring a new evidence path
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# require an explicit private experiment and exclusive proof destination
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
