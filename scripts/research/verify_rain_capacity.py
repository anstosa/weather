"""independently refit nested-capacity rain heads and replay all gates."""

# ruff: noqa: E402

import argparse
import json
import os
from pathlib import Path

# constrain native fits before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import xgboost as xgb
import evaluate_rain_goal as goal
from rain_capacity import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_context import build_features, feature_sets, load_profiles
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_fit_recency import (
    check_freeze as check_fit_freeze,
    fit_weights,
    native_predict,
)
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

PRIMARY = "hurdleCapacity"
OLD_PRIMARY = "hurdleDecay"
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
    "decayOriginal",
)
ARMS = (*ORIGINAL_ARMS, PRIMARY)
HEADS = (
    ("0.1", 0.1, "event-0.1.json", "binary:logistic"),
    ("1.0", 1.0, "event-1.0.json", "binary:logistic"),
    ("2.5", 2.5, "event-2.5.json", "binary:logistic"),
    ("amount", 0.1, "amount.json", "reg:gamma"),
)
MAXIMUM_ROUNDS = 320
FALLBACK_ROUNDS = 160
VALIDATION_DAYS = 120
EMBARGO_DAYS = 7


# keep inner labels strictly earlier than the outer fit cutoff
def inner_masks(hours, stop):
    hours = np.asarray(hours)
    require(
        hours.ndim == 1
        and len(hours) > 0
        and np.issubdtype(hours.dtype, np.integer)
        and isinstance(stop, (int, np.integer))
        and not isinstance(stop, (bool, np.bool_))
        and stop % 24 == 0
        and np.all(hours < stop),
        "invalid inner training chronology",
    )
    validation_start = stop - VALIDATION_DAYS * 24
    train_stop = validation_start - EMBARGO_DAYS * 24
    training = hours < train_stop
    validation = (hours >= validation_start) & (hours < stop)
    bounds = {
        "innerTrainingMaximumValidHourExclusive": int(train_stop),
        "innerValidationStartHour": int(validation_start),
        "innerValidationMaximumValidHourExclusive": int(stop),
        "innerEmbargoHours": EMBARGO_DAYS * 24,
    }
    return training, validation, bounds


# choose the first one-based round at the exact metric minimum
def earliest_minimum(losses):
    losses = np.asarray(losses, dtype=np.float64)
    require(
        losses.shape == (MAXIMUM_ROUNDS,) and np.isfinite(losses).all(),
        "invalid native validation history",
    )
    return int(np.argmin(losses) + 1)


# apply original inner and outer distinct-hour/date support floors
def head_supported(counts, objective, validation=False):
    if objective == "reg:gamma":
        minimum_hours, minimum_dates = (20, 5) if validation else (100, 20)
    else:
        minimum_hours, minimum_dates = (10, 5) if validation else (10, 3)
    return (
        counts["positiveHours"] >= minimum_hours
        and counts["positiveDates"] >= minimum_dates
    )


# freeze all producer sources and inherited independent proof bytes
def check_freeze(root, old_names):
    inherited, cohort = check_fit_freeze(root, old_names)
    freeze = json.loads((root / "capacity-freeze.json").read_text())
    require(
        freeze["policy"] == POLICY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["boostRounds"] is None
        and POLICY["selectionMaximumRounds"] == MAXIMUM_ROUNDS
        and POLICY["selectionFallbackRounds"] == FALLBACK_ROUNDS
        and POLICY["innerValidationDays"] == VALIDATION_DAYS
        and POLICY["innerEmbargoDays"] == EMBARGO_DAYS,
        "nested capacity policy changed",
    )
    require(
        freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == feature_sets(old_names)["full"]
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"]
        == sha(root / "fit-freeze.json")
        == POLICY["parentPins"]["fit-freeze.json"]
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False,
        "nested capacity freeze changed",
    )
    require(
        set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "nested capacity source scope changed",
    )
    # compare live sources to retained pre-outcome bytes
    for name, expected in freeze["sourceSha256"].items():
        relative = Path(name)
        live, saved = Path(__file__).with_name(name), root / "capacity-sources" / name
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
            f"nested capacity source changed: {name}",
        )
    # rehash each copied input, prior artifact and independent receipt
    for name, expected in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        require(
            not relative.is_absolute()
            and ".." not in relative.parts
            and saved.is_file()
            and not saved.is_symlink()
            and sha(saved) == expected,
            f"nested capacity inherited input changed: {name}",
        )
    prior_report = json.loads((root / "inputs/fit-recency/report.json").read_text())
    prior_proof = json.loads(
        (
            root
            / "inputs/fit-recency/final-evidence/independent-verification-final.json"
        ).read_text()
    )
    require(
        freeze["inputSha256"]["fit-freeze.json"]
        == POLICY["parentPins"]["fit-freeze.json"]
        and all(
            freeze["inputSha256"]["inputs/fit-recency/" + name] == expected
            for name, expected in POLICY["parentPins"].items()
            if name != "fit-freeze.json"
        )
        and inherited["policy"]["contractVersion"] == "rain-fit-recency-development/v1",
        "nested capacity parent identity changed",
    )
    require(
        prior_report["freezeSha256"] == POLICY["parentPins"]["fit-freeze.json"]
        and prior_report["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_report["productionEligible"] is False,
        "nested capacity prior report changed",
    )
    require(
        prior_proof["verified"] is True
        and prior_proof["all49GatesVerified"] is True
        and prior_proof["nativeModelsRefit"] == 48
        and prior_proof["reportSha256"] == POLICY["parentPins"]["report.json"]
        and prior_proof["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_proof["productionEligible"] is False,
        "nested capacity prior independent proof changed",
    )
    return freeze, cohort


# independently fit 320 native rounds and compare retained metric history
def fit_inner(
    root,
    month,
    name,
    filename,
    objective,
    x_train,
    labels_train,
    hours_train,
    x_validation,
    labels_validation,
    hours_validation,
    cutoff,
    names,
):
    training = xgb.DMatrix(
        x_train,
        label=labels_train.astype(np.float32),
        weight=fit_weights(hours_train, cutoff),
        feature_names=names,
        nthread=1,
    )
    validation = xgb.DMatrix(
        x_validation,
        label=labels_validation.astype(np.float32),
        weight=weights(hours_validation) * len(hours_validation),
        feature_names=names,
        nthread=1,
    )
    metric = "gamma-deviance" if objective == "reg:gamma" else "logloss"
    parameters = {
        **SEARCH_POLICY["parameters"],
        "objective": objective,
        "eval_metric": metric,
    }
    history = {}
    booster = xgb.train(
        parameters,
        training,
        num_boost_round=MAXIMUM_ROUNDS,
        evals=[(validation, "validation")],
        evals_result=history,
        verbose_eval=False,
    )
    losses = [float(value) for value in history["validation"][metric]]
    selected = earliest_minimum(losses)
    path = root / "capacity-models" / month / f"inner-{filename}"
    digest = sha(path)
    check_booster(booster, path, digest, objective, MAXIMUM_ROUNDS, names)
    require(
        json.loads(booster.save_config())["learner"]["metrics"][0]["name"] == metric,
        f"inner metric changed: {month}:{name}",
    )
    return selected, losses, metric, digest


# independently fit inner selection and full outer booster for each head
def refit_heads(root, full, names, actual, hours, stop, month):
    require(
        xgb.__version__ == POLICY["xgboostVersion"]
        and "base_score" not in SEARCH_POLICY["parameters"]
        and full.dtype == np.dtype(np.float32)
        and full.shape == (len(hours), len(names)),
        "nested native schema or runtime changed",
    )
    inner_train, inner_validation, bounds = inner_masks(hours, stop)
    state = {
        "featureNames": names,
        "rounds": None,
        "selectionMaximumRounds": MAXIMUM_ROUNDS,
        "fallbackRounds": FALLBACK_ROUNDS,
        "heads": {},
        "trainingRows": int(len(hours)),
        "trainingMinimumActualHour": int(hours.min()),
        "trainingMaximumActualHour": int(hours.max()),
        "trainingMaximumValidHourExclusive": int(stop),
        "innerBounds": bounds,
        "innerTrainingRows": int(inner_train.sum()),
        "innerValidationRows": int(inner_validation.sum()),
        "trainingWeight": {
            "policy": "equal_date_hour_vintage_then_fixed_exponential_date_decay",
            "halfLifeDays": 183,
        },
    }
    models = {}
    # preserve all four native heads and their chronological support diagnostics
    for name, threshold, filename, objective in HEADS:
        outer = head_support(actual, hours, threshold)
        train = head_support(actual[inner_train], hours[inner_train], threshold)
        validation = head_support(
            actual[inner_validation], hours[inner_validation], threshold
        )
        record = {
            "objective": objective,
            "support": outer,
            "modelFile": None,
            "sha256": None,
            "reason": "insufficient_wet_support"
            if objective == "reg:gamma"
            else "insufficient_positive_support",
            "selectedRound": None,
            "selectionReason": "unsupported_outer_fit",
            "innerTrainingSupport": train,
            "innerValidationSupport": validation,
            "innerModelFile": None,
            "innerSha256": None,
            "validationMetric": None,
            "validationLossByRound": None,
            "innerBounds": bounds,
        }
        models[name] = None
        # do not train on unsupported outer labels
        if not head_supported(outer, objective):
            require(
                not (root / "capacity-models" / month / filename).exists()
                and not (
                    root / "capacity-models" / month / f"inner-{filename}"
                ).exists(),
                f"unexpected unsupported capacity head: {month}:{name}",
            )
            state["heads"][name] = record
            continue
        selected = FALLBACK_ROUNDS
        record["selectionReason"] = (
            "insufficient_inner_training_support"
            if not head_supported(train, objective)
            else "insufficient_inner_validation_support"
        )
        # only supported inner labels can choose capacity
        if head_supported(train, objective) and head_supported(
            validation, objective, validation=True
        ):
            selected_train = (
                inner_train & (actual >= threshold)
                if objective == "reg:gamma"
                else inner_train
            )
            selected_validation = (
                inner_validation & (actual >= threshold)
                if objective == "reg:gamma"
                else inner_validation
            )
            labels_train = (
                actual[selected_train]
                if objective == "reg:gamma"
                else (actual[selected_train] >= threshold).astype(np.float64)
            )
            labels_validation = (
                actual[selected_validation]
                if objective == "reg:gamma"
                else (actual[selected_validation] >= threshold).astype(np.float64)
            )
            selected, losses, metric, digest = fit_inner(
                root,
                month,
                name,
                filename,
                objective,
                full[selected_train],
                labels_train,
                hours[selected_train],
                full[selected_validation],
                labels_validation,
                hours[selected_validation],
                bounds["innerTrainingMaximumValidHourExclusive"],
                names,
            )
            record.update(
                {
                    "selectionReason": "earliest_minimum_inner_validation",
                    "innerModelFile": f"inner-{filename}",
                    "innerSha256": digest,
                    "validationMetric": metric,
                    "validationLossByRound": losses,
                }
            )
        else:
            require(
                not (root / "capacity-models" / month / f"inner-{filename}").exists(),
                f"unexpected inner capacity fit: {month}:{name}",
            )
        selected_outer = (
            actual >= threshold
            if objective == "reg:gamma"
            else np.ones(len(actual), dtype=bool)
        )
        labels_outer = (
            actual[selected_outer]
            if objective == "reg:gamma"
            else (actual[selected_outer] >= threshold).astype(np.float64)
        )
        matrix = xgb.DMatrix(
            full[selected_outer],
            label=labels_outer.astype(np.float32),
            weight=fit_weights(hours[selected_outer], stop),
            feature_names=names,
            nthread=1,
        )
        booster = xgb.train(
            {**SEARCH_POLICY["parameters"], "objective": objective},
            matrix,
            num_boost_round=selected,
        )
        path = root / "capacity-models" / month / filename
        digest = sha(path)
        check_booster(booster, path, digest, objective, selected, names)
        record.update(
            {
                "modelFile": filename,
                "sha256": digest,
                "reason": "fitted",
                "selectedRound": selected,
            }
        )
        models[name] = booster
        state["heads"][name] = record
    return models, state


# replay one month without borrowing outer calibration or evaluation labels
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
    # leave an unsupported month at the exact original ordinal forecast
    if not supported:
        require(
            not (root / "capacity-models" / month).exists(),
            f"unexpected unsupported capacity model: {month}",
        )
        predicted = old_ordinal.copy()
    else:
        models, model_state = refit_heads(
            root,
            full[fit],
            names,
            data["actual"][fit],
            data["hour"][fit],
            bounds["trainingMaximumValidHourExclusive"],
            month,
        )
        pc, ac = native_predict(models, full[calibration], names)
        pe, ae = native_predict(models, full[evaluation], names)
        require(
            np.isfinite(ac).all() and np.isfinite(ae).all(),
            f"missing supported capacity gamma: {month}",
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
                "reason": "nested_capacity_hurdle_calibrated",
            }
        )
    same_tree(
        state,
        json.loads((root / "capacity-states" / f"{month}.json").read_text()),
        f"capacityState.{month}",
    )
    return rows, predicted, state


# keep all prior predictions bitwise and append one new primary
def replay_all(root, data, full, names, old_policy):
    with np.load(
        root / "inputs/fit-recency/predictions.npz", allow_pickle=False
    ) as old:
        reference_indices = old["indices"]
        original = {name: old["amount::" + name] for name in ORIGINAL_ARMS[:-1]}
        original["decayOriginal"] = old["amount::" + OLD_PRIMARY]
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # preserve every original decision month and population
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
            f"capacity month population changed: {month}",
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
        "capacity development population changed",
    )
    return indices, {**original, PRIMARY: np.concatenate(amounts)}, flags, states


# score all groups and apply two independently implemented gate paths
def expected_report(root, data, old_policy, indices, amounts, flags, states):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    view = goal.gate_view(scores, PRIMARY)
    screen = goal.fixed_gate.candidate_screen(view, data, indices, flags)
    same_tree(
        goal.independent_gate(view, data, indices, flags),
        screen,
        "capacityIndependentGate",
    )
    require(len(screen["gates"]) == 49, "capacity gate count changed")
    hours = data["hour"][indices]
    outer_count = sum(
        sum(head["modelFile"] is not None for head in state["model"]["heads"].values())
        for state in states.values()
        if state["model"] is not None
    )
    inner_count = sum(
        sum(
            head["innerModelFile"] is not None
            for head in state["model"]["heads"].values()
        )
        for state in states.values()
        if state["model"] is not None
    )
    report = {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "freezeSha256": sha(root / "capacity-freeze.json"),
        **scores,
        "monthlyStates": states,
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "treeFitPerformed": True,
        "nativeModelsReused": 0,
        "nativeModelsFit": outer_count,
        "nativeSelectionModelsFit": inner_count,
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
                "decayOriginal": OLD_PRIMARY,
            },
        },
        "featuresSha256": sha(root / "inputs/context/features.npz"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    return report


# verify native bytes, histories, states, forecasts, scores and gates
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(
        old_freeze["featureNames"] == old_names
        and root.name == "weather-moisture-research-rain-capacity-20260913-v1"
        and len(data["actual"]) > 32896,
        "capacity root or paired schema changed",
    )
    freeze, cohort = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"]
    profiles = load_profiles(root / "inputs/context/inputs/trajectory.jsonl", cohort)
    matrices, availability = build_features(data, profiles, old_names)
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *availability}
            and np.array_equal(saved["x"], matrices["full"], equal_nan=True),
            "capacity 95-feature matrix changed",
        )
        # preserve source-only availability for every paired row
        for name, expected in availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"capacity feature availability changed: {name}",
            )
    indices, amounts, flags, states = replay_all(
        root, data, matrices["full"], names, old_policy
    )
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(
            set(saved.files)
            == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS}
            and np.array_equal(saved["indices"], indices)
            and saved["candidateSupported"].dtype == np.dtype(bool)
            and np.array_equal(saved["candidateSupported"], flags),
            "capacity prediction population changed",
        )
        # require exact controls and independently replayed new forecasts
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(
                observed.shape == expected.shape
                and np.isfinite(observed).all()
                and (observed >= 0).all(),
                f"capacity malformed predictions: {name}",
            )
            require(
                (
                    np.allclose(observed, expected, rtol=1e-8, atol=1e-9)
                    if name == PRIMARY
                    else np.array_equal(observed, expected)
                ),
                f"capacity prediction replay changed: {name}",
            )
    expected = expected_report(root, data, old_policy, indices, amounts, flags, states)
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
    same_tree(expected, reported, "capacityReport")
    require(
        expected["nativeModelsFit"] == 48 and len(states) == 12,
        "capacity outer model count changed",
    )
    receipt = {
        "contractVersion": "rain-capacity-independent-verification/v1",
        "verified": True,
        "privateRoot": str(root),
        "verifierSourceSha256": sha(__file__),
        "sourceProfilesVerified": len(profiles),
        "featureRowsVerified": len(data["actual"]),
        "featureColumnsVerified": len(names),
        "monthlyStatesVerified": len(states),
        "nativeOuterModelsRefit": expected["nativeModelsFit"],
        "nativeInnerModelsRefit": expected["nativeSelectionModelsFit"],
        "nativeModelsRefit": expected["nativeModelsFit"]
        + expected["nativeSelectionModelsFit"],
        "developmentPredictionRows": len(indices),
        "all49GatesVerified": True,
        "referenceParityVerified": True,
        "selectedCandidate": expected["selectedCandidate"],
        "developmentPassed": expected["developmentPassed"],
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "freezeSha256": sha(root / "capacity-freeze.json"),
        "reportSha256": sha(root / "report.json"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    # write proof outside immutable producer root
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# require explicit private root and exclusive proof path
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
