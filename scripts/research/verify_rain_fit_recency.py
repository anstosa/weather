"""independently refit decayed ordinal heads and replay fixed rain gates."""

# ruff: noqa: E402
import argparse
import json
import os
from pathlib import Path

# pin deterministic native reductions
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import numpy as np
import xgboost as xgb
from rain_fit_recency import POLICY, SOURCE_FILES
from rain_search import POLICY as SEARCH_POLICY
from verify_rain_context import build_features, feature_sets, load_profiles
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
import evaluate_rain_goal as goal

PRIMARY = "hurdleDecay"
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
HEADS = (
    ("0.1", 0.1, "event-0.1.json"),
    ("1.0", 1.0, "event-1.0.json"),
    ("2.5", 2.5, "event-2.5.json"),
)
HALF_LIFE_DAYS = 183
ROUNDS = 160


# rebalance source vintages within dates before fixed half-year decay
def fit_weights(hours, stop):
    hours = np.asarray(hours)
    require(
        hours.ndim == 1
        and len(hours) > 0
        and np.issubdtype(hours.dtype, np.integer)
        and isinstance(stop, (int, np.integer))
        and not isinstance(stop, (bool, np.bool_))
        and stop % 24 == 0
        and np.all(hours < stop),
        "invalid decayed fit chronology",
    )
    age = stop // 24 - 1 - hours // 24
    mass = weights(hours) * np.exp2(-age.astype(np.float64) / HALF_LIFE_DAYS)
    mass *= len(hours) / float(mass.sum())
    require(
        np.isfinite(mass).all()
        and (mass > 0).all()
        and np.isclose(mass.sum(), len(hours), rtol=1e-12, atol=1e-10),
        "invalid decayed fit mass",
    )
    return mass


# calculate Kish support on forecast valid dates
def effective_dates(hours, mass):
    _, inverse = np.unique(hours // 24, return_inverse=True)
    date_mass = np.bincount(inverse, weights=mass)
    date_mass /= date_mass.sum()
    return float(1.0 / np.dot(date_mass, date_mass))


# describe both all-label and independently rebalanced gamma masses
def weight_state(actual, hours, stop):
    whole = fit_weights(hours, stop)
    wet = actual >= 0.1
    wet_mass = fit_weights(hours[wet], stop) if wet.any() else np.empty(0)
    return {
        "policy": "equal_date_hour_vintage_then_fixed_exponential_date_decay",
        "halfLifeDays": HALF_LIFE_DAYS,
        "normalization": "sum_equals_fitted_row_count_per_head",
        "rows": int(len(hours)),
        "weightSum": float(whole.sum()),
        "effectiveDates": effective_dates(hours, whole),
        "oldestDateAgeDays": int(stop // 24 - 1 - hours.min() // 24),
        "newestDateAgeDays": int(stop // 24 - 1 - hours.max() // 24),
        "wetRows": int(wet.sum()),
        "wetWeightSum": float(wet_mass.sum()),
        "wetEffectiveDates": effective_dates(hours[wet], wet_mass)
        if wet.any()
        else 0.0,
    }


# check new and inherited source/input freezes before touching outcomes
def check_freeze(root, old_names):
    freeze = json.loads((root / "fit-freeze.json").read_text())
    inherited = json.loads((root / "hurdle-freeze.json").read_text())
    cohort, _ = check_hurdle_freeze(root, inherited, old_names)
    require(
        freeze["policy"] == POLICY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["fitHalfLifeDays"] == HALF_LIFE_DAYS
        and POLICY["nativeModelsFit"] == 48
        and POLICY["nativeModelsReused"] == 0,
        "decayed fit policy changed",
    )
    require(
        freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == feature_sets(old_names)["full"]
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"]
        == sha(root / "hurdle-freeze.json")
        == POLICY["parentPins"]["hurdle-freeze.json"]
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False,
        "decayed fit freeze changed",
    )
    require(
        set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "decayed fit source scope changed",
    )
    # compare each live source with its pre-outcome snapshot
    for name, expected in freeze["sourceSha256"].items():
        path = Path(name)
        require(
            len(path.parts) == 1
            and path.suffix == ".py"
            and not path.is_absolute()
            and ".." not in path.parts,
            "unsafe decayed fit source name",
        )
        live, retained = Path(__file__).with_name(name), root / "fit-sources" / name
        require(
            live.is_file()
            and retained.is_file()
            and not live.is_symlink()
            and not retained.is_symlink()
            and sha(live) == expected
            and sha(retained) == expected,
            f"decayed fit source changed: {name}",
        )
    # verify every inherited artifact under its frozen relative path
    for name, expected in freeze["inputSha256"].items():
        path = Path(name)
        retained = root / path
        require(
            not path.is_absolute()
            and ".." not in path.parts
            and retained.is_file()
            and not retained.is_symlink()
            and sha(retained) == expected,
            f"decayed fit input changed: {name}",
        )
    prior_report = json.loads((root / "inputs/hurdle/report.json").read_text())
    prior_proof = json.loads(
        (
            root / "inputs/hurdle/final-evidence/independent-verification-final.json"
        ).read_text()
    )
    require(
        all(
            freeze["inputSha256"]["inputs/hurdle/" + name] == digest
            for name, digest in POLICY["parentPins"].items()
            if name != "hurdle-freeze.json"
        )
        and prior_report["freezeSha256"] == POLICY["parentPins"]["hurdle-freeze.json"]
        and prior_report["predictionsSha256"]
        == POLICY["parentPins"]["predictions.npz"],
        "decayed fit prior outcome changed",
    )
    require(
        prior_proof["verified"] is True
        and prior_proof["all49GatesVerified"] is True
        and prior_proof["nativeModelsRefit"] == 60
        and prior_proof["reportSha256"] == POLICY["parentPins"]["report.json"]
        and prior_proof["predictionsSha256"] == POLICY["parentPins"]["predictions.npz"]
        and prior_proof["productionEligible"] is False,
        "decayed fit prior independent proof changed",
    )
    return freeze, cohort


# refit every head from old rows but with the new fixed mass
def refit_heads(root, full, names, actual, hours, stop, month):
    directory = root / "fit-models" / month
    mass = fit_weights(hours, stop)
    state = {
        "featureNames": names,
        "rounds": ROUNDS,
        "heads": {},
        "trainingRows": int(len(hours)),
        "trainingMinimumActualHour": int(hours.min()),
        "trainingMaximumActualHour": int(hours.max()),
        "trainingMaximumValidHourExclusive": int(stop),
        "trainingWeight": weight_state(actual, hours, stop),
    }
    models = {}
    require(
        xgb.__version__ == POLICY["xgboostVersion"]
        and "base_score" not in SEARCH_POLICY["parameters"]
        and full.dtype == np.dtype(np.float32)
        and full.shape == (len(hours), len(names)),
        "decayed native schema or runtime changed",
    )
    # require exact original objective and support contract per binary event
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
        # never fit unsupported events
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
                f"unexpected unsupported decayed head: {month}:{name}",
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
    # fit gamma only on wet labels with separately normalized date decay
    if counts["positiveHours"] >= 100 and counts["positiveDates"] >= 20:
        matrix = xgb.DMatrix(
            full[wet],
            label=actual[wet],
            weight=fit_weights(hours[wet], stop),
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
            f"unexpected unsupported decayed gamma: {month}",
        )
    state["heads"]["amount"] = record
    return models, state


# infer probabilities and conditional wet amount without evaluation labels
def native_predict(models, full, names):
    matrix = xgb.DMatrix(full, feature_names=names, nthread=1)
    probability = np.full((len(full), 3), np.nan, dtype=np.float64)
    # preserve absent event heads as explicit nan raw fallbacks
    for index, (name, _, _) in enumerate(HEADS):
        if models[name] is not None:
            probability[:, index] = np.clip(models[name].predict(matrix), 0, 1)
    amount = np.full(len(full), np.nan, dtype=np.float64)
    # require supported gamma for all supported experiment months
    if models["amount"] is not None:
        amount[:] = np.clip(models["amount"].predict(matrix), 0.1, 30)
    return probability, amount


# replay one predetermined month on the original chronology and support
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
    # unsupported months preserve the exact previous ordinal control
    if not supported:
        require(
            not (root / "fit-models" / month).exists(),
            f"unexpected unsupported decayed fit: {month}",
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
            f"missing supported decayed gamma: {month}",
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
                "reason": "decayed_fit_hurdle_calibrated",
            }
        )
    same_tree(
        state,
        json.loads((root / "fit-states" / f"{month}.json").read_text()),
        f"decayedFitState.{month}",
    )
    return rows, predicted, state


# preserve exact original arms and append independently refitted forecasts
def replay_all(root, data, full, names, old_policy):
    with np.load(root / "inputs/hurdle/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        original = {name: old["amount::" + name] for name in ORIGINAL_ARMS}
        original["hurdleOriginal"] = old["amount::" + OLD_PRIMARY]
    indices, amounts, flags, states = [], [], [], {}
    offset = 0
    # retain every original month and each unsupported fallback row
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
            f"decayed fit month population changed: {month}",
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
        "decayed fit development population changed",
    )
    return indices, {**original, PRIMARY: np.concatenate(amounts)}, flags, states


# score all retained groups and independently derive the same fixed 49 gates
def expected_report(root, data, old_policy, indices, amounts, flags, states):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    screen = goal.fixed_gate.candidate_screen(
        goal.gate_view(scores, PRIMARY), data, indices, flags
    )
    same_tree(
        goal.independent_gate(goal.gate_view(scores, PRIMARY), data, indices, flags),
        screen,
        "decayedFitIndependentGate",
    )
    require(len(screen["gates"]) == 49, "decayed fit gate count changed")
    hours = data["hour"][indices]
    report = {
        "contractVersion": POLICY["contractVersion"],
        "policy": POLICY,
        "freezeSha256": sha(root / "fit-freeze.json"),
        **scores,
        "monthlyStates": states,
        "independentEvaluationPerformed": False,
        "productionEligible": False,
        "productionWrites": False,
        "treeFitPerformed": True,
        "nativeModelsReused": 0,
        "nativeModelsFit": sum(
            sum(
                head["modelFile"] is not None
                for head in state["model"]["heads"].values()
            )
            for state in states.values()
            if state["model"] is not None
        ),
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
        "featuresSha256": sha(root / "inputs/context/features.npz"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    return report


# bind 48 new native bytes, predictions, states, scores and fixed gates
def verify(root, evidence):
    root, evidence = Path(root), Path(evidence)
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(
        old_freeze["featureNames"] == old_names
        and root.name == "weather-moisture-research-rain-fit-recency-20260913-v1"
        and len(data["actual"]) > 32896,
        "decayed fit root or paired schema changed",
    )
    freeze, cohort = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"]
    profiles = load_profiles(root / "inputs/context/inputs/trajectory.jsonl", cohort)
    matrices, availability = build_features(data, profiles, old_names)
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(
            set(saved.files) == {"x", *availability}
            and np.array_equal(saved["x"], matrices["full"], equal_nan=True),
            "decayed fit 95-feature matrix changed",
        )
        # enforce source-only availability on every paired row
        for name, expected in availability.items():
            require(
                np.array_equal(saved[name], expected),
                f"decayed fit feature availability changed: {name}",
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
            "decayed fit prediction population changed",
        )
        # preserve exact controls and replay new native forecasts
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(
                observed.shape == expected.shape
                and np.isfinite(observed).all()
                and (observed >= 0).all(),
                f"decayed fit malformed predictions: {name}",
            )
            require(
                (
                    np.allclose(observed, expected, rtol=1e-8, atol=1e-9)
                    if name == PRIMARY
                    else np.array_equal(observed, expected)
                ),
                f"decayed fit prediction replay changed: {name}",
            )
    expected = expected_report(root, data, old_policy, indices, amounts, flags, states)
    reported = json.loads((root / "report.json").read_text())
    goal.recomputed_gates(
        reported,
        {
            name: expected[name]
            for name in (
                "overall",
                "byLeadBand",
                "bySeason",
                "byMonth",
                "byArchiveEra",
                "events",
                "accumulations",
                "invariants",
            )
        },
        data,
        indices,
        flags,
        PRIMARY,
    )
    same_tree(expected, reported, "decayedFitReport")
    require(
        expected["nativeModelsFit"] == 48 and len(states) == 12,
        "decayed fit native count changed",
    )
    receipt = {
        "contractVersion": "rain-fit-recency-independent-verification/v1",
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
        "freezeSha256": sha(root / "fit-freeze.json"),
        "reportSha256": sha(root / "report.json"),
        "predictionsSha256": sha(root / "predictions.npz"),
    }
    # keep independent proof separate from immutable experiment inputs
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# require explicit immutable root and exclusive evidence path
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
