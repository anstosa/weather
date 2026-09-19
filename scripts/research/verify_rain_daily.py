"""independently replay prequential daily rain calibration and fixed gates."""

# ruff: noqa: E402

import argparse
import datetime as dt
import json
import os
from pathlib import Path

# constrain native reductions before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import evaluate_rain_goal as goal
from rain_daily import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_context import (
    build_features as build_context,
    feature_sets,
    load_profiles,
)
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_hurdle import calibrate_hurdle, predict_hurdle
from verify_rain_recency import MONTHS, effective_support, recent_weights, sha
from verify_rain_search import checked_rules, month_masks, ordinal_rules, support
from verify_rain_sub24_model import metrics, require
from verify_rain_trajectory import (
    TENDENCY_NAMES,
    build_tendencies,
    check_freeze as check_trajectory_freeze,
    load_tendencies,
    native_predict,
    refit_heads,
)

PRIMARY = "hurdleDaily"
OLD_PRIMARY = "hurdleTrajectory"
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
    "hurdleOriginal",
    "trajectoryOriginal",
)
ARMS = (*ORIGINAL_ARMS, PRIMARY)
CALIBRATION_DAYS = 90
EMBARGO_DAYS = 7


# isolate a utc decision date and its earlier matured labels
def day_masks(data, decision_day):
    initialized = np.asarray(data["initialized"])
    lead = np.asarray(data["lead"])
    hours = np.asarray(data["hour"])
    require(
        type(decision_day) in (int, np.int64, np.int32)
        and initialized.ndim == 1
        and lead.shape == initialized.shape == hours.shape
        and all(
            np.issubdtype(value.dtype, np.integer)
            for value in (initialized, lead, hours)
        )
        and np.isin(lead, np.arange(1, 24)).all()
        and np.array_equal(hours, initialized + 8 + lead),
        "invalid daily paired geometry",
    )
    start = int(decision_day) * 24
    stop = start + 24
    calibration_stop = start - EMBARGO_DAYS * 24
    calibration_start = calibration_stop - CALIBRATION_DAYS * 24
    decision = initialized + 8
    calibration = (hours >= calibration_start) & (hours < calibration_stop)
    evaluation = (decision >= start) & (decision < stop)
    bounds = {
        "decisionDate": dt.datetime.fromtimestamp(start * 3600, dt.timezone.utc)
        .date()
        .isoformat(),
        "decisionDayStartHour": start,
        "calibrationStartHour": calibration_start,
        "calibrationMaximumValidHourExclusive": calibration_stop,
        "decisionStartHour": start,
        "decisionStopHourExclusive": stop,
    }
    return calibration, evaluation, bounds


# calibrate one day using only the earlier embargoed target window
def replay_day(data, probability, base, decision_day, fallback, policy):
    calibration, evaluation, bounds = day_masks(data, decision_day)
    rows = np.flatnonzero(evaluation)
    require(
        probability.shape == (len(evaluation), 3)
        and base.shape == evaluation.shape
        and fallback.shape == (len(rows),)
        and np.isfinite(fallback).all()
        and (fallback >= 0).all(),
        "invalid daily native forecast alignment",
    )
    actual, hours = data["actual"][calibration], data["hour"][calibration]
    require(
        np.isfinite(actual).all() and (actual >= 0).all(),
        "invalid prior daily calibration target",
    )
    counts = support(actual, hours)
    effective = {"effectiveDates": 0.0, "effectiveWetDates": 0.0}
    # require nonempty history before date-decayed support calculation
    if len(hours):
        mass = recent_weights(hours, bounds["calibrationMaximumValidHourExclusive"])
        effective = effective_support(actual, hours, mass)
    supported = all(
        counts[key] >= value for key, value in policy["calibrationSupport"].items()
    ) and all(
        effective[key] >= value for key, value in policy["effectiveSupport"].items()
    )
    state = {
        **bounds,
        "supported": bool(supported),
        "proposedRules": None,
        "uniformRules": None,
        "nestingSafetyFallback": None,
        "calibration": None,
        "reason": "insufficient_calibration_support",
        "support": counts,
        "effectiveSupport": effective,
    }
    # preserve exact monthly model output when daily calibration is unavailable
    if not supported or not len(rows):
        # distinguish missing decisions from unsupported prior labels
        if not len(rows):
            state["reason"] = "no_evaluation_rows"
            state["supported"] = False
        return rows, fallback.copy(), state
    raw_cal, raw_eval = (
        data["raw"][calibration].astype(float),
        data["raw"][evaluation].astype(float),
    )
    proposed = ordinal_rules(
        actual, raw_cal, probability[calibration], hours, SEARCH_POLICY
    )
    rules, nesting = checked_rules(
        actual, raw_cal, probability[calibration], hours, proposed, SEARCH_POLICY
    )
    fitted = calibrate_hurdle(
        actual,
        hours,
        raw_cal,
        probability[calibration],
        base[calibration],
        rules,
        bounds["calibrationMaximumValidHourExclusive"],
    )
    predicted = predict_hurdle(
        raw_eval, probability[evaluation], base[evaluation], fitted
    )
    state.update(
        {
            "proposedRules": proposed,
            "uniformRules": rules,
            "nestingSafetyFallback": nesting,
            "calibration": fitted,
            "reason": "daily_hurdle_calibrated",
        }
    )
    return rows, predicted, state


# bind inherited native bytes and independent parent proof
def check_freeze(root, old_names):
    inherited, cohort = check_trajectory_freeze(root, old_names)
    freeze = json.loads((root / "daily-freeze.json").read_text())
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES)
    require(
        freeze["policy"] == POLICY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["featureNames"] == names
        and POLICY["treeFitPerformed"] is False
        and POLICY["nativeModelsFit"] == 0
        and POLICY["nativeModelsReused"] == 48,
        "daily calibration policy changed",
    )
    require(
        freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == names
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"]
        == sha(root / "trajectory-freeze.json")
        == POLICY["parentPins"]["trajectory-freeze.json"]
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False,
        "daily calibration freeze changed",
    )
    require(
        set(freeze["sourceSha256"]) == set(SOURCE_FILES), "daily source scope changed"
    )
    # compare every live source with its pre-outcome snapshot
    for name, expected in freeze["sourceSha256"].items():
        relative = Path(name)
        live, saved = Path(__file__).with_name(name), root / "daily-sources" / name
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
            f"daily source changed: {name}",
        )
    # rehash all inherited features, models, states and receipts
    for name, expected in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        require(
            not relative.is_absolute()
            and ".." not in relative.parts
            and saved.is_file()
            and not saved.is_symlink()
            and sha(saved) == expected,
            f"daily inherited input changed: {name}",
        )
    prior_report = json.loads((root / "inputs/trajectory/report.json").read_text())
    prior_proof = json.loads(
        (
            root
            / "inputs/trajectory/final-evidence/independent-verification-final.json"
        ).read_text()
    )
    require(
        freeze["inputSha256"]["trajectory-freeze.json"]
        == POLICY["parentPins"]["trajectory-freeze.json"]
        and all(
            freeze["inputSha256"]["inputs/trajectory/" + name] == digest
            for name, digest in POLICY["parentPins"].items()
            if name != "trajectory-freeze.json"
        ),
        "daily parent identity changed",
    )
    require(
        prior_report["freezeSha256"] == POLICY["parentPins"]["trajectory-freeze.json"]
        and prior_report["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_report["productionEligible"] is False
        and inherited["policy"]["contractVersion"] == "rain-trajectory-development/v1",
        "daily parent report changed",
    )
    require(
        prior_proof["verified"] is True
        and prior_proof["all49GatesVerified"] is True
        and prior_proof["nativeModelsRefit"] == 48
        and prior_proof["reportSha256"] == POLICY["parentPins"]["report.json"]
        and prior_proof["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_proof["productionEligible"] is False,
        "daily prior independent proof changed",
    )
    return freeze, cohort


# refit fixed monthly heads before recalibrating any decision date
def replay_all(root, data, full, names, old_policy):
    with np.load(root / "inputs/trajectory/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        original = {name: old["amount::" + name] for name in ORIGINAL_ARMS[:-1]}
        original["trajectoryOriginal"] = old["amount::" + OLD_PRIMARY]
    require(
        len(reference_indices) == 32896
        and len(np.unique(reference_indices)) == len(reference_indices),
        "daily prior evaluation population changed",
    )
    fallback = np.full(len(full), np.nan)
    fallback[reference_indices] = original["trajectoryOriginal"]
    predicted = np.full(len(full), np.nan)
    supported = np.zeros(len(full), dtype=bool)
    visited = np.zeros(len(full), dtype=bool)
    monthly, daily, expected_indices = {}, {}, []
    # retain each monthly learner while updating only earlier calibration
    for month in MONTHS:
        fit, _, evaluation, bounds = month_masks(data, month, old_policy, SEARCH_POLICY)
        rows = np.flatnonzero(evaluation)
        expected_indices.append(rows)
        retained = json.loads(
            (root / "inputs/trajectory/trajectory-states" / f"{month}.json").read_text()
        )
        require(
            retained["supported"] is True
            and all(retained[name] == value for name, value in bounds.items()),
            f"daily parent fit chronology changed: {month}",
        )
        models, model_state = refit_heads(
            root / "inputs/trajectory",
            full[fit],
            names,
            data["actual"][fit],
            data["hour"][fit],
            month,
        )
        same_tree(model_state, retained["model"], f"dailyNativeModel.{month}")
        days = np.unique((data["initialized"][evaluation] + 8) // 24)
        needed = evaluation.copy()
        # restrict native inference to evaluation and earlier calibration rows
        for day in days:
            calibration, day_evaluation, daily_bounds = day_masks(data, int(day))
            require(
                daily_bounds["calibrationStartHour"]
                >= bounds["trainingMaximumValidHourExclusive"]
                and not (day_evaluation & ~evaluation).any(),
                f"daily calibration crosses model month: {month}",
            )
            needed |= calibration
        probability = np.full((len(full), 3), np.nan)
        base = np.full(len(full), np.nan)
        probability[needed], amount = native_predict(models, full[needed], names)
        require(np.isfinite(amount).all(), f"missing daily conditional amount: {month}")
        base[needed] = np.clip(
            0.25 * data["raw"][needed].astype(float) + 0.75 * amount, 0, 30
        )
        dates = []
        # calibrate each date only after native forecasts are frozen
        for day in days:
            _, day_evaluation, _ = day_masks(data, int(day))
            day_rows = np.flatnonzero(day_evaluation)
            rows_for_day, values, state = replay_day(
                data, probability, base, int(day), fallback[day_rows], POLICY
            )
            require(
                np.array_equal(rows_for_day, day_rows) and not visited[day_rows].any(),
                f"daily repeated or missing rows: {day}",
            )
            key = state["decisionDate"]
            state["modelMonth"] = month
            same_tree(
                state,
                json.loads((root / "daily-states" / f"{key}.json").read_text()),
                f"dailyState.{key}",
            )
            daily[key] = state
            dates.append(key)
            predicted[day_rows] = values
            supported[day_rows] = state["supported"]
            visited[day_rows] = True
        monthly[month] = {**bounds, "model": model_state, "dailyDates": dates}
    indices = np.concatenate(expected_indices)
    require(
        np.array_equal(indices, reference_indices)
        and len(indices) == 32896
        and visited[indices].all()
        and int(visited.sum()) == len(indices)
        and np.isfinite(predicted[indices]).all()
        and len(daily) == 365,
        "daily complete development population changed",
    )
    return (
        indices,
        {**original, PRIMARY: predicted[indices]},
        supported[indices],
        monthly,
        daily,
    )


# score complete prequential population under the fixed research gates
def expected_report(root, data, old_policy, indices, amounts, flags, monthly, daily):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    view = goal.gate_view(scores, PRIMARY)
    screen = goal.fixed_gate.candidate_screen(view, data, indices, flags)
    same_tree(
        goal.independent_gate(view, data, indices, flags),
        screen,
        "dailyIndependentGate",
    )
    require(len(screen["gates"]) == 49, "daily fixed gate count changed")
    hours = data["hour"][indices]
    report = {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "freezeSha256": sha(root / "daily-freeze.json"),
        **scores,
        "monthlyStates": monthly,
        "dailyStates": daily,
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "treeFitPerformed": False,
        "nativeModelsFit": 0,
        "nativeModelsReused": 48,
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
                **{name: name for name in ORIGINAL_ARMS[:-1]},
                "trajectoryOriginal": OLD_PRIMARY,
            },
        },
        "featuresSha256": sha(root / "inputs/trajectory/features.npz"),
        "dailyCalibrationCount": len(daily),
        "supportedDailyCalibrations": sum(
            state["supported"] for state in daily.values()
        ),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    return report


# verify 48 native bytes, 365 daily states, forecasts and all gates
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(
        old_freeze["featureNames"] == old_names
        and root.name == "weather-moisture-research-rain-daily-20260913-v1"
        and len(data["actual"]) > 32896,
        "daily root or paired schema changed",
    )
    freeze, cohort = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES)
    source = root / "inputs/context/inputs/trajectory.jsonl"
    base_profiles = load_profiles(source, cohort)
    context_matrices, old_availability = build_context(data, base_profiles, old_names)
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *old_availability}
            and np.array_equal(saved["x"], context_matrices["full"], equal_nan=True),
            "daily original context features changed",
        )
        # preserve each original source-only availability flag
        for name, expected in old_availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"daily context availability changed: {name}",
            )
    profiles = load_tendencies(source, base_profiles, cohort)
    full, availability = build_tendencies(
        data, context_matrices["full"], profiles, old_names
    )
    with np.load(root / "inputs/trajectory/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", "tendencyAvailable"}
            and np.array_equal(saved["x"], full, equal_nan=True)
            and np.array_equal(
                saved["tendencyAvailable"], availability["tendencyAvailable"]
            ),
            "daily original 101-feature matrix changed",
        )
    indices, amounts, flags, monthly, daily = replay_all(
        root, data, full, names, old_policy
    )
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(
            set(saved.files)
            == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS}
            and np.array_equal(saved["indices"], indices)
            and saved["candidateSupported"].dtype == np.dtype(bool)
            and np.array_equal(saved["candidateSupported"], flags),
            "daily prediction population changed",
        )
        # compare prior controls exactly and new daily forecasts numerically
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(
                observed.shape == expected.shape
                and np.isfinite(observed).all()
                and (observed >= 0).all(),
                f"daily malformed predictions: {name}",
            )
            require(
                (
                    np.allclose(observed, expected, rtol=1e-8, atol=1e-9)
                    if name == PRIMARY
                    else np.array_equal(observed, expected)
                ),
                f"daily prediction replay changed: {name}",
            )
    expected = expected_report(
        root, data, old_policy, indices, amounts, flags, monthly, daily
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
    same_tree(expected, reported, "dailyReport")
    receipt = {
        "contractVersion": "rain-daily-independent-verification/v1",
        "verified": True,
        "privateRoot": str(root),
        "verifierSourceSha256": sha(__file__),
        "sourceProfilesVerified": len(profiles),
        "featureRowsVerified": len(data["actual"]),
        "featureColumnsVerified": len(names),
        "monthlyNativeModelsRefit": 48,
        "dailyStatesVerified": len(daily),
        "developmentPredictionRows": len(indices),
        "all49GatesVerified": True,
        "referenceParityVerified": True,
        "selectedCandidate": expected["selectedCandidate"],
        "developmentPassed": expected["developmentPassed"],
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "freezeSha256": sha(root / "daily-freeze.json"),
        "reportSha256": sha(root / "report.json"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    # write independent proof outside frozen producer inputs
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# require explicit private root and exclusive receipt path
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
