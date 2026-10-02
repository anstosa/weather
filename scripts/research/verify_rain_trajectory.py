"""independently reconstruct forecast tendencies and replay rain gates."""

# ruff: noqa: E402

import argparse
import json
import os
from pathlib import Path

# constrain native reductions before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import xgboost as xgb
import evaluate_rain_goal as goal
from rain_trajectory import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_context import (
    build_features as build_context,
    feature_sets,
    hour,
    load_profiles,
)
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_hurdle import (
    calibrate_hurdle,
    check_freeze as check_hurdle_freeze,
    predict_hurdle,
)
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

PRIMARY = "hurdleTrajectory"
OLD_PRIMARY = "hurdleCategory"
ORIGINAL_ARMS = (
    "raw",
    "zero",
    "persistence",
    "volumeScale",
    "volume90",
    "volumeRecent",
    "ordinal90",
    "weightedContext",
    "ordinalRecentAmount",
    "ordinalRecentEvents",
    "ordinalRecent",
)
ARMS = (*ORIGINAL_ARMS, "hurdleOriginal", PRIMARY)
TENDENCY_NAMES = (
    "relativeHumidityChange3h",
    "relativeHumidityNext3hChange",
    "cloudCoverChange3h",
    "cloudCoverNext3hChange",
    "windSpeedChange3h",
    "windSpeedNext3hChange",
)
SOURCES = (
    ("humidity", "rawRelativeHumidityPercent", "rawHumidity", 0.0, 100.0),
    ("cloud", "rawCloudCoverPercent", "rawCloud", 0.0, 100.0),
    ("wind", "rawWindSpeedMps", "rawWind", 0.0, 150.0),
)
HEADS = (
    ("0.1", 0.1, "event-0.1.json"),
    ("1.0", 1.0, "event-1.0.json"),
    ("2.5", 2.5, "event-2.5.json"),
)
ROUNDS = 160


# retain nulls but reject malformed or physically invalid source fields
def measurement(record, field, minimum, maximum):
    value = record[field]
    # preserve explicit missing source values
    if value is None:
        return np.nan
    require(
        type(value) in (int, float)
        and np.isfinite(value)
        and minimum <= value <= maximum,
        f"invalid trajectory source field: {field}",
    )
    return float(value)


# parse three extra trajectories from the already pinned original profile file
def load_tendencies(path, base_profiles, cohort):
    require(sha(path) == cohort["sha256"], "trajectory source identity changed")
    profiles, counts = {}, {}
    rows = 0
    # validate every source lead and complete issued run independently
    with Path(path).open() as stream:
        for line in stream:
            row = json.loads(
                line,
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
            initialized = hour(row["runInitializedAt"])
            lead = row["targetLeadHours"]
            require(
                initialized in base_profiles
                and type(lead) is int
                and 1 <= lead <= 48
                and hour(row["validAt"]) == initialized + lead,
                "invalid trajectory source lead",
            )
            # allocate each issued run once
            if initialized not in profiles:
                profiles[initialized] = {
                    name: np.full(48, np.nan, dtype=np.float64)
                    for name, _, _, _, _ in SOURCES
                }
                counts[initialized] = set()
            require(lead not in counts[initialized], "duplicate trajectory source lead")
            counts[initialized].add(lead)
            # retain all three bounded source trajectories
            for name, field, _, minimum, maximum in SOURCES:
                profiles[initialized][name][lead - 1] = measurement(
                    row, field, minimum, maximum
                )
            rows += 1
    require(
        sha(path) == cohort["sha256"], "trajectory source changed during extraction"
    )
    require(
        rows == cohort["rows"]
        and set(profiles) == set(base_profiles)
        and all(len(leads) == 48 for leads in counts.values()),
        "incomplete trajectory source profiles",
    )
    return profiles


# derive only same-run forecast fields without accessing observed labels
def build_tendencies(data, full95, profiles, old_names):
    size = len(full95)
    require(
        full95.dtype == np.dtype(np.float32)
        and full95.shape == (size, 95)
        and all(
            data[name].shape == (size,) for name in ("initialized", "lead", "hour")
        ),
        "invalid trajectory paired feature shape",
    )
    extended = np.full((size, 101), np.nan, dtype=np.float32)
    extended[:, :95] = full95
    available = np.zeros(size, dtype=bool)
    paired_indices = {name: old_names.index(name) for _, _, name, _, _ in SOURCES}
    # retain every paired row, including source-missing tendencies
    for index in range(size):
        initialized, lead = (
            int(data["initialized"][index]),
            8 + int(data["lead"][index]),
        )
        require(
            9 <= lead <= 31 and initialized + lead == int(data["hour"][index]),
            "trajectory valid-hour pairing changed",
        )
        profile = profiles.get(initialized)
        # retain absent original runs as missing features
        if profile is None:
            continue
        values = []
        # evaluate current, three-hour-prior and three-hour-next source leads
        for name, _, paired_name, _, _ in SOURCES:
            series = profile[name]
            current = series[lead - 1]
            paired = full95[index, paired_indices[paired_name]]
            require(
                (np.isnan(current) and np.isnan(paired))
                or np.float32(current) == paired,
                f"paired trajectory source differs: {paired_name}",
            )
            values.extend((current - series[lead - 4], series[lead + 2] - current))
        extended[index, 95:] = np.asarray(values, dtype=np.float32)
        available[index] = bool(np.isfinite(values).all())
    return extended, {"tendencyAvailable": available}


# bind inherited independent proof and every new frozen source/input
def check_freeze(root, old_names):
    inherited = json.loads((root / "hurdle-freeze.json").read_text())
    cohort, _ = check_hurdle_freeze(root, inherited, old_names)
    freeze = json.loads((root / "trajectory-freeze.json").read_text())
    expected_names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES)
    require(
        freeze["policy"] == POLICY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["featureNames"] == expected_names
        and POLICY["tendencyFeatures"] == list(TENDENCY_NAMES)
        and POLICY["boostRounds"] == ROUNDS
        and POLICY["nativeModelsFit"] == 48,
        "trajectory policy changed",
    )
    require(
        freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == expected_names
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"]
        == sha(root / "hurdle-freeze.json")
        == POLICY["parentPins"]["hurdle-freeze.json"]
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False,
        "trajectory freeze changed",
    )
    require(
        set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "trajectory source scope changed",
    )
    # compare all live sources with their pre-outcome snapshots
    for name, expected in freeze["sourceSha256"].items():
        relative = Path(name)
        live, saved = Path(__file__).with_name(name), root / "trajectory-sources" / name
        require(
            len(relative.parts) == 1
            and relative.suffix == ".py"
            and not relative.is_absolute()
            and ".." not in relative.parts
            and live.is_file()
            and saved.is_file()
            and not live.is_symlink()
            and not saved.is_symlink()
            and sha(live) == expected
            and sha(saved) == expected,
            f"trajectory source changed: {name}",
        )
    # retain exact inherited input bytes and original evaluation evidence
    for name, expected in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        require(
            not relative.is_absolute()
            and ".." not in relative.parts
            and saved.is_file()
            and not saved.is_symlink()
            and sha(saved) == expected,
            f"trajectory inherited input changed: {name}",
        )
    prior_report = json.loads((root / "inputs/hurdle/report.json").read_text())
    prior_proof = json.loads(
        (
            root / "inputs/hurdle/final-evidence/independent-verification-final.json"
        ).read_text()
    )
    require(
        freeze["inputSha256"]["hurdle-freeze.json"]
        == POLICY["parentPins"]["hurdle-freeze.json"]
        and all(
            freeze["inputSha256"]["inputs/hurdle/" + name] == digest
            for name, digest in POLICY["parentPins"].items()
            if name != "hurdle-freeze.json"
        ),
        "trajectory parent identity changed",
    )
    require(
        prior_report["freezeSha256"] == POLICY["parentPins"]["hurdle-freeze.json"]
        and prior_report["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_report["productionEligible"] is False,
        "trajectory prior report changed",
    )
    require(
        prior_proof["verified"] is True
        and prior_proof["all49GatesVerified"] is True
        and prior_proof["nativeModelsRefit"] == 60
        and prior_proof["reportSha256"] == POLICY["parentPins"]["report.json"]
        and prior_proof["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_proof["productionEligible"] is False,
        "trajectory prior independent proof changed",
    )
    return freeze, cohort


# refit four uniform-weight original objectives on the new 101-column matrix
def refit_heads(root, full, names, actual, hours, month):
    require(
        xgb.__version__ == POLICY["xgboostVersion"]
        and full.dtype == np.dtype(np.float32)
        and full.shape == (len(hours), 101)
        and names == POLICY["featureNames"]
        and "base_score" not in SEARCH_POLICY["parameters"],
        "trajectory native schema or runtime changed",
    )
    directory = root / "trajectory-models" / month
    mass = weights(hours) * len(hours)
    state = {"featureNames": names, "rounds": ROUNDS, "heads": {}}
    models = {}
    # preserve each original event definition and absent-head fallback
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
        # fit only positively supported event heads
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
                f"unexpected unsupported trajectory head: {month}:{name}",
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
    # independently rebalance conditional gamma only within wet labels
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
        record.update(
            {"modelFile": "amount.json", "sha256": digest, "reason": "fitted"}
        )
        models["amount"] = booster
    else:
        require(
            not (directory / "amount.json").exists(),
            f"unexpected unsupported trajectory gamma: {month}",
        )
    state["heads"]["amount"] = record
    return models, state


# score all native heads without reading calibration or evaluation labels
def native_predict(models, full, names):
    matrix = xgb.DMatrix(full, feature_names=names, nthread=1)
    probability = np.full((len(full), 3), np.nan, dtype=np.float64)
    # leave absent event scores as explicit raw-rule fallbacks
    for index, (name, _, _) in enumerate(HEADS):
        # score only supported event models
        if models[name] is not None:
            probability[:, index] = np.clip(models[name].predict(matrix), 0, 1)
    amount = np.full(len(full), np.nan, dtype=np.float64)
    # retain missing gamma as an explicit fallback
    if models["amount"] is not None:
        amount[:] = np.clip(models["amount"].predict(matrix), 0.1, 30)
    return probability, amount


# replay one fixed month on original fit, calibration and decision masks
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
    # unsupported cells preserve the exact prior ordinal control
    if not supported:
        require(
            not (root / "trajectory-models" / month).exists(),
            f"unexpected unsupported trajectory fit: {month}",
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
            f"missing supported trajectory gamma: {month}",
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
                "reason": "trajectory_hurdle_calibrated",
            }
        )
    same_tree(
        state,
        json.loads((root / "trajectory-states" / f"{month}.json").read_text()),
        f"trajectoryState.{month}",
    )
    return rows, predicted, state


# append only the new primary after every identical prior forecast
def replay_all(root, data, full, names, old_policy):
    with np.load(root / "inputs/hurdle/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        original = {name: old["amount::" + name] for name in ORIGINAL_ARMS}
        original["hurdleOriginal"] = old["amount::" + OLD_PRIMARY]
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # retain all predetermined development months and unsupported rows
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
            f"trajectory month population changed: {month}",
        )
        indices.append(rows)
        amounts.append(predicted)
        flags.append(np.full(len(rows), state["supported"], dtype=bool))
        states[month] = state
        offset = end
    indices, flags = np.concatenate(indices), np.concatenate(flags)
    require(
        offset == 32896
        and len(indices) == len(np.unique(indices))
        and np.array_equal(indices, reference_indices),
        "trajectory development population changed",
    )
    return indices, {**original, PRIMARY: np.concatenate(amounts)}, flags, states


# score all groups and independently derive unchanged fixed gates
def expected_report(
    root, data, old_policy, indices, amounts, flags, states, availability
):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    view = goal.gate_view(scores, PRIMARY)
    screen = goal.fixed_gate.candidate_screen(view, data, indices, flags)
    same_tree(
        goal.independent_gate(view, data, indices, flags),
        screen,
        "trajectoryIndependentGate",
    )
    require(len(screen["gates"]) == 49, "trajectory fixed gate count changed")
    hours = data["hour"][indices]
    native_count = sum(
        sum(head["modelFile"] is not None for head in state["model"]["heads"].values())
        for state in states.values()
        if state["model"] is not None
    )
    report = {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "freezeSha256": sha(root / "trajectory-freeze.json"),
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
                "hurdleOriginal": OLD_PRIMARY,
            },
        },
        "featuresSha256": sha(root / "features.npz"),
        "originalFeaturesSha256": sha(root / "inputs/context/features.npz"),
        "tendencyAvailability": {
            "evaluationRows": int(availability["tendencyAvailable"][indices].sum()),
            "evaluationTotal": int(len(indices)),
            "featureColumns": 101,
        },
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    return report


# verify features, native bytes, states, forecasts, scores and 49 gates
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(
        old_freeze["featureNames"] == old_names
        and root.name == "weather-moisture-research-rain-trajectory-20260913-v1"
        and len(data["actual"]) > 32896,
        "trajectory root or paired schema changed",
    )
    freeze, cohort = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES)
    source = root / "inputs/context/inputs/trajectory.jsonl"
    base_profiles = load_profiles(source, cohort)
    matrices, old_availability = build_context(data, base_profiles, old_names)
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *old_availability}
            and np.array_equal(saved["x"], matrices["full"], equal_nan=True),
            "trajectory original 95-feature matrix changed",
        )
        # preserve original source-only availability definitions
        for name, expected in old_availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"trajectory old feature availability changed: {name}",
            )
    profiles = load_tendencies(source, base_profiles, cohort)
    full, availability = build_tendencies(data, matrices["full"], profiles, old_names)
    with np.load(root / "features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", "tendencyAvailable"}
            and saved["x"].dtype == np.dtype(np.float32)
            and np.array_equal(saved["x"], full, equal_nan=True)
            and np.array_equal(
                saved["tendencyAvailable"], availability["tendencyAvailable"]
            ),
            "trajectory 101-feature material changed",
        )
    indices, amounts, flags, states = replay_all(root, data, full, names, old_policy)
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(
            set(saved.files)
            == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS}
            and np.array_equal(saved["indices"], indices)
            and saved["candidateSupported"].dtype == np.dtype(bool)
            and np.array_equal(saved["candidateSupported"], flags),
            "trajectory prediction population changed",
        )
        # compare all prior controls exactly and the new forecasts numerically
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(
                observed.shape == expected.shape
                and np.isfinite(observed).all()
                and (observed >= 0).all(),
                f"trajectory malformed predictions: {name}",
            )
            require(
                (
                    np.allclose(observed, expected, rtol=1e-8, atol=1e-9)
                    if name == PRIMARY
                    else np.array_equal(observed, expected)
                ),
                f"trajectory prediction replay changed: {name}",
            )
    expected = expected_report(
        root, data, old_policy, indices, amounts, flags, states, availability
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
    same_tree(expected, reported, "trajectoryReport")
    require(
        expected["nativeModelsFit"] == 48 and len(states) == 12,
        "trajectory native model count changed",
    )
    receipt = {
        "contractVersion": "rain-trajectory-independent-verification/v1",
        "verified": True,
        "privateRoot": str(root),
        "verifierSourceSha256": sha(__file__),
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
        "freezeSha256": sha(root / "trajectory-freeze.json"),
        "reportSha256": sha(root / "report.json"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    # emit independent evidence outside the immutable experiment root
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# require explicit private root and exclusive evidence path
# require an explicit research root and evidence path
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
