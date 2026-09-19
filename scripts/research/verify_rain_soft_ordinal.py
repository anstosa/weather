"""independently replay the fixed soft-ordinal wind experiment."""

import argparse
import json
import os
from pathlib import Path

# constrain native reductions before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import evaluate_rain_goal as goal
import numpy as np
import verify_rain_direction_recovery as recovery_audit
import verify_rain_wind as wind
import verify_rain_wind_continuation as source_audit
import xgboost as xgb
from rain_soft_ordinal import POLICY, SOURCE_FILES
from verify_rain_context import build_features as build_context
from verify_rain_context import feature_sets, load_profiles
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_recency import MONTHS, effective_support, recent_weights, sha
from verify_rain_search import month_masks, support
from verify_rain_sub24_model import metrics, require, weights
from verify_rain_trajectory import TENDENCY_NAMES, build_tendencies, load_tendencies
from verify_rain_trajectory import check_freeze as check_trajectory_freeze

PRIMARY = "softOrdinalWind"
ROOT_NAME = "weather-moisture-research-rain-soft-ordinal-20260913-v1"
PARENT_PINS = {
    "wind-freeze.json": "b80c0c6b18b9c026978e1947db734cdbf5ac2b6ae3dc1ff7dce0974493c5d9b8",
    "report.json": "f3d6c2d570b2029093b288f21e9e62ce0c896f0956b2f06ce6ada9673dfda56a",
    "predictions.npz": "ff2f2040acd674ba3881e58b9e3337eaf393ce73f71185fd102992c9f0368f1e",
}
ARMS = (*wind.ARMS[:-1], "windOriginal", PRIMARY)
THRESHOLDS = np.array((.1, 1., 2.5), dtype=np.float64)
OFFSETS = tuple(index / 20 for index in range(-30, 31))
LIMITS = ((0., .1), (.1, np.nextafter(1., 0.)), (1., np.nextafter(2.5, 0.)), (2.5, 30.))


# preserve the original full-fit date/hour/vintage mass inside each bin
def bin_means(actual, hours):
    require(actual.ndim == hours.ndim == 1 and len(actual) == len(hours) > 0 and np.isfinite(actual).all() and (actual >= 0).all(), "invalid soft-ordinal fit labels")
    mass = weights(hours)
    classes = np.searchsorted(THRESHOLDS, actual, side="right")
    bins = []
    # the dry bin is a fixed zero point mass even when it has no examples
    for index, (lower, upper) in enumerate(LIMITS):
        selected = classes == index
        distinct = np.unique(hours[selected])
        dates = np.unique(distinct // 24)
        weight_mass = float(mass[selected].sum())
        record = {
            "index": index, "lowerMm": float(lower),
            "upperMmExclusive": float(THRESHOLDS[index]) if index < 3 else None,
            "rows": int(selected.sum()), "uniqueHours": len(distinct),
            "uniqueDates": len(dates), "weightMass": weight_mass,
            "supported": index == 0, "mean": 0. if index == 0 else None,
        }
        # each wet bin needs enough distinct fitted hours and dates
        if index and len(distinct) >= 10 and len(dates) >= 3:
            record["mean"] = float(np.clip(float(mass[selected] @ actual[selected]) / weight_mass, lower, upper))
            record["supported"] = True
        bins.append(record)
    supported = all(record["supported"] for record in bins)
    return {"supported": supported, "means": [record["mean"] for record in bins] if supported else None, "bins": bins}


# project three calibrated event tails onto coherent disjoint bin mass
def class_mass(probabilities, offset):
    require(probabilities.ndim == 2 and probabilities.shape[1] == 3 and np.isfinite(probabilities).all() and ((probabilities >= 0) & (probabilities <= 1)).all() and offset in OFFSETS, "invalid soft-ordinal event scores")
    clipped = np.clip(probabilities.astype(np.float64), 1e-6, 1. - 1e-6)
    nested = np.minimum.accumulate(clipped, axis=1)
    logit = np.log(nested) - np.log1p(-nested) + offset
    tails = 1. / (1. + np.exp(-logit))
    return np.column_stack((1. - tails[:, 0], tails[:, 0] - tails[:, 1], tails[:, 1] - tails[:, 2], tails[:, 2]))


# select only a common odds offset by full-calibration proper log loss
def calibrate(actual, hours, probabilities):
    require(actual.ndim == hours.ndim == 1 and len(actual) == len(hours) == len(probabilities) and len(actual) > 0 and np.isfinite(actual).all() and (actual >= 0).all(), "invalid soft-ordinal calibration labels")
    classes = np.searchsorted(THRESHOLDS, actual, side="right")
    mass = weights(hours)
    rows = np.arange(len(actual))
    scores = []
    # every one of the sixty-one fixed offsets sees identical calibration rows
    for offset in OFFSETS:
        probabilities_by_class = class_mass(probabilities, offset)
        scores.append(float(-mass @ np.log(np.maximum(probabilities_by_class[rows, classes], 1e-12))))
    selected = min(range(len(scores)), key=lambda index: (scores[index], abs(OFFSETS[index]), OFFSETS[index]))
    return {"contractVersion": "rain-soft-ordinal-calibration/v1", "selectedOffset": OFFSETS[selected], "selectedIndex": selected, "selectedScore": scores[selected], "gridOffsets": list(OFFSETS), "gridScores": scores, "calibrationRows": len(actual), "calibrationDates": len(np.unique(hours // 24))}


# return the forecast mean without labels or hard category floors
def predict(probabilities, means, state):
    require(len(means) == 4 and means[0] == 0. and all(lower <= value <= upper for value, (lower, upper) in zip(means[1:], LIMITS[1:])) and state["selectedOffset"] == OFFSETS[state["selectedIndex"]], "invalid soft-ordinal predictive state")
    return np.clip(class_mass(probabilities, state["selectedOffset"]) @ np.asarray(means, dtype=np.float64), 0., 30.)


# score only the three retained binary heads and never use gamma amount
def native_tails(models, features, names):
    require(features.ndim == 2 and features.shape[1] == len(names) and features.dtype == np.dtype(np.float32), "invalid soft-ordinal feature matrix")
    matrix = xgb.DMatrix(features, feature_names=names, nthread=1)
    # one missing binary head cannot form a four-category distribution
    return np.column_stack([np.clip(models[name].predict(matrix), 0, 1) for name in ("0.1", "1.0", "2.5")])


# rebind the parent wind model and the new source after its exact-root copy
def check_freeze(root, old_names):
    _, cohort = check_trajectory_freeze(root, old_names)
    old = json.loads((root / "wind-freeze.json").read_text())
    freeze = json.loads((root / "soft-ordinal-freeze.json").read_text())
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(wind.WIND_NAMES)
    require(
        old["policy"] == wind.POLICY
        and old["contextFeatureNames"] == names
        and old["featureNames"] == old_names
        and old["newCandidateOutcomesRead"] is False
        and old["productionWrites"] is False
        and freeze["policy"] == POLICY
        and POLICY["contractVersion"] == "rain-soft-ordinal-development/v1"
        and POLICY["primary"] == PRIMARY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["nativeModelsFit"] == 0
        and POLICY["nativeModelsReused"] == 36
        and POLICY["nativeModelsUnused"] == 12
        and freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == names
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"] == PARENT_PINS["wind-freeze.json"] == sha(root / "wind-freeze.json")
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False
        and set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "soft-ordinal freeze or method changed",
    )
    # each original wind input remains bound by the new private snapshot
    require(
        all(freeze["inputSha256"].get(name) == digest for name, digest in old["inputSha256"].items())
        and freeze["inputSha256"]["wind-freeze.json"] == PARENT_PINS["wind-freeze.json"]
        and freeze["inputSha256"]["inputs/wind/report.json"] == PARENT_PINS["report.json"]
        and freeze["inputSha256"]["inputs/wind/predictions.npz"] == PARENT_PINS["predictions.npz"],
        "soft-ordinal inherited wind lineage changed",
    )
    # compare every live and saved source byte before reading new candidate scores
    for name, digest in freeze["sourceSha256"].items():
        relative = Path(name)
        live, saved = Path(__file__).with_name(name), root / "soft-ordinal-sources" / name
        # no path escape, link or changed executable source may qualify
        require(len(relative.parts) == 1 and relative.suffix == ".py" and live.is_file() and saved.is_file() and not live.is_symlink() and not saved.is_symlink() and sha(live) == digest and sha(saved) == digest, f"soft-ordinal source changed: {name}")
    # a saved feature, model or source file may not change after preparation
    for name, digest in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        # no inherited member may escape or alias the private root
        require(not relative.is_absolute() and ".." not in relative.parts and saved.is_file() and not saved.is_symlink() and sha(saved) == digest, f"soft-ordinal input changed: {name}")
    parent_report = json.loads((root / "inputs/wind/report.json").read_text())
    parent_proof = json.loads((root / "inputs/wind/final-evidence/independent-verification-final.json").read_text())
    # parent outcome is known but cannot be replaced by an unchecked control
    require(
        sha(root / "inputs/wind/report.json") == PARENT_PINS["report.json"]
        and sha(root / "inputs/wind/predictions.npz") == PARENT_PINS["predictions.npz"]
        and parent_report["freezeSha256"] == PARENT_PINS["wind-freeze.json"]
        and parent_report["predictionsSha256"] == PARENT_PINS["predictions.npz"]
        and parent_report["productionEligible"] is False
        and parent_proof["verified"] is True
        and parent_proof["all49GatesVerified"] is True
        and parent_proof["nativeModelsRefit"] == 48
        and parent_proof["reportSha256"] == PARENT_PINS["report.json"]
        and parent_proof["predictionsSha256"] == PARENT_PINS["predictions.npz"]
        and parent_proof["productionEligible"] is False,
        "soft-ordinal parent independent proof changed",
    )
    expected_root = Path.home() / ".weather/research-work" / ROOT_NAME
    source_root = root / "inputs/direction"
    # a copied source is reaudited here without weakening its exact snapshot gate
    require(root == expected_root and not root.is_symlink() and root.resolve() == expected_root and source_root == expected_root / "inputs/direction" and not source_root.is_symlink(), "soft-ordinal source scope changed")
    replayed = source_audit.audit_root(source_root)
    saved_proof = json.loads((source_root / "final-evidence/independent-verification.json").read_text())
    # only the new verifier timestamp may differ from its retained receipt
    require(set(replayed) == set(saved_proof) and all(replayed[key] == saved_proof[key] for key in replayed if key != "verifiedAtUtc"), "soft-ordinal copied source proof changed")
    source_report = json.loads((source_root / "report.json").read_text())
    source = wind.check_source_result(replayed, source_report)
    require(replayed["reportSha256"] == sha(source_root / "report.json") and replayed["normalizedSha256"] == sha(source_root / wind.SOURCE_RELATIVE), "soft-ordinal source bytes changed")
    return cohort, source


# reconstruct all one-hundred-seven predictor columns from copied raw profiles
def reconstruct_features(root, data, old_names, cohort, source):
    original_path = root / "inputs/context/inputs/trajectory.jsonl"
    context = load_profiles(original_path, cohort)
    matrices, context_flags = build_context(data, context, old_names)
    # original full-context matrix and support flags are unchanged controls
    with np.load(root / "inputs/context/features.npz", allow_pickle=False) as saved:
        require(set(saved.files) == {"x", *context_flags} and np.array_equal(saved["x"], matrices["full"], equal_nan=True) and all(np.array_equal(saved[name], value) for name, value in context_flags.items()), "soft-ordinal original context features changed")
    trajectories = load_tendencies(original_path, context, cohort)
    full101, tendency_flags = build_tendencies(data, matrices["full"], trajectories, old_names)
    # the six inherited tendency columns must remain byte-identical
    with np.load(root / "inputs/trajectory/features.npz", allow_pickle=False) as saved:
        require(set(saved.files) == {"x", *tendency_flags} and np.array_equal(saved["x"], full101, equal_nan=True) and all(np.array_equal(saved[name], value) for name, value in tendency_flags.items()), "soft-ordinal original trajectory features changed")
    source_root = root / "inputs/direction"
    originals = recovery_audit.original_profiles(source_root / "inputs/interrupted-source/inputs/previous-recovery/inputs/parent-root")
    joined = wind.load_directions(source_root / wind.SOURCE_RELATIVE, source["normalizedSha256"], originals, context, trajectories)
    full107, wind_flags = wind.build_wind(data, full101, joined, old_names)
    expected_keys = {"x", *tendency_flags, *wind_flags}
    # both the verified parent feature file and the new exact copy bind all rows
    for path in (root / "inputs/wind/features.npz", root / "features.npz"):
        with np.load(path, allow_pickle=False) as saved:
            require(set(saved.files) == expected_keys and saved["x"].dtype == np.dtype(np.float32) and np.array_equal(saved["x"], full107, equal_nan=True) and all(np.array_equal(saved[name], value) for name, value in {**tendency_flags, **wind_flags}.items()), "soft-ordinal 107-feature matrix changed")
    require(sha(root / "features.npz") == sha(root / "inputs/wind/features.npz"), "soft-ordinal parent feature bytes changed")
    return full107, wind_flags, len(joined)


# replay one original monthly fit, one bin estimate and one calibration grid
def replay_month(root, data, full, names, old_policy, month, old_ordinal):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, wind.SEARCH_POLICY)
    actual_cal, hours_cal = data["actual"][calibration], data["hour"][calibration]
    counts = {"training": support(data["actual"][fit], data["hour"][fit]), "calibration": support(actual_cal, hours_cal)}
    recent = recent_weights(hours_cal, bounds["calibrationMaximumValidHourExclusive"])
    effective = effective_support(actual_cal, hours_cal, recent)
    supported = all(counts["training"][key] >= minimum for key, minimum in POLICY["trainingSupport"].items()) and all(counts["calibration"][key] >= minimum for key, minimum in POLICY["calibrationSupport"].items()) and all(effective[key] >= minimum for key, minimum in POLICY["effectiveSupport"].items())
    parent_path = root / "wind-states" / f"{month}.json"
    retained = json.loads(parent_path.read_text())
    # copied parent masks, support and final booster provenance must agree
    require(all(retained[key] == value for key, value in bounds.items()) and retained["support"] == counts and retained["supported"] is supported, f"soft-ordinal parent chronology changed: {month}")
    same_tree(effective, retained["effectiveSupport"], f"windEffective.{month}")
    models, model_state = wind.refit_heads(root, full[fit], names, data["actual"][fit], data["hour"][fit], month)
    same_tree(model_state, retained["model"], f"windModel.{month}")
    state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": False, "model": retained["model"], "inheritedStateSha256": sha(parent_path), "binFit": None, "calibration": None, "reason": "insufficient_support"}
    rows = np.where(evaluation)[0]
    # an unsupported old month remains its exact ordinal control forecast
    if not supported:
        predicted = old_ordinal.copy()
    else:
        fitted = bin_means(data["actual"][fit], data["hour"][fit])
        state["binFit"] = fitted
        # one sparse wet bin invalidates the entire transformed month
        if not fitted["supported"]:
            state["reason"] = "insufficient_bin_support"
            predicted = old_ordinal.copy()
        elif any(models[name] is None for name in ("0.1", "1.0", "2.5")):
            # no probability head may be silently replaced by another month
            state["reason"] = "missing_probability_head"
            predicted = old_ordinal.copy()
        else:
            pc = native_tails(models, full[calibration], names)
            pe = native_tails(models, full[evaluation], names)
            calibrated = calibrate(actual_cal, hours_cal, pc)
            predicted = predict(pe, fitted["means"], calibrated)
            state.update({"supported": True, "calibration": calibrated, "reason": "soft_ordinal_calibrated"})
    reported = json.loads((root / "soft-ordinal-states" / f"{month}.json").read_text())
    same_tree(state, reported, f"softOrdinalState.{month}")
    return rows, predicted, state


# retain all fourteen parent arms and each fixed development decision row
def replay_all(root, data, full, names, old_policy):
    with np.load(root / "inputs/wind/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        controls = {name: old["amount::" + name] for name in wind.ARMS[:-1]}
        controls["windOriginal"] = old["amount::" + wind.PRIMARY]
    indices, new_amounts, flags, states = [], [], [], {}
    offset = 0
    # all twelve evaluation partitions are replayed in frozen order
    for month in MONTHS:
        _, _, evaluation, _ = month_masks(data, month, old_policy, wind.SEARCH_POLICY)
        end = offset + int(evaluation.sum())
        rows, predicted, state = replay_month(root, data, full, names, old_policy, month, controls["ordinal90"][offset:end])
        require(np.array_equal(rows, reference_indices[offset:end]), f"soft-ordinal month population changed: {month}")
        indices.append(rows)
        new_amounts.append(predicted)
        flags.append(np.full(len(rows), state["supported"], dtype=bool))
        states[month] = state
        offset = end
    indices, flags = np.concatenate(indices), np.concatenate(flags)
    require(offset == 32896 and len(np.unique(indices)) == offset and np.array_equal(indices, reference_indices), "soft-ordinal fixed evaluation population changed")
    return indices, {**controls, PRIMARY: np.concatenate(new_amounts)}, flags, states


# score all fifteen retained arms and independently derive the fixed gates
def expected_report(root, data, old_policy, indices, amounts, flags, states, wind_flags, source):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    screen = goal.independent_gate(goal.gate_view(scores, PRIMARY), data, indices, flags)
    require(len(screen["gates"]) == 49, "soft-ordinal gate set changed")
    hours = data["hour"][indices]
    return {
        "contractVersion": POLICY["contractVersion"], "policy": POLICY,
        "freezeSha256": sha(root / "soft-ordinal-freeze.json"), **scores,
        "monthlyStates": states, "independentEvaluationPerformed": False,
        "productionEligible": False, "productionWrites": False,
        "treeFitPerformed": False, "nativeModelsFit": 0,
        "nativeModelsReused": 36, "nativeModelsUnused": 12,
        "meanTargetSensitivity": {name: metrics(data["mean"][indices], value, (value >= .1).astype(float), hours) for name, value in amounts.items()},
        "candidateScreen": screen,
        "selectedCandidate": PRIMARY if screen["passed"] else None,
        "developmentPassed": bool(screen["passed"]),
        "decision": "prospective_hypothesis_only_not_qualified" if screen["passed"] else "no_candidate_selected_all_failures_retained",
        "referenceParity": {"exactPredictions": True, "arms": {**{name: name for name in wind.ARMS[:-1]}, "windOriginal": wind.PRIMARY}},
        "featuresSha256": sha(root / "features.npz"),
        "originalFeaturesSha256": sha(root / "inputs/wind/features.npz"),
        "directionSourceSha256": source["normalizedSha256"],
        "directionSourceCoverage": {"unresolvedRuns": source["newUnresolvedRuns"], "perMonthCoverage": source["perMonthCoverage"]},
        "windAvailability": {"evaluationRows": int(wind_flags["windVectorAvailable"][indices].sum()), "evaluationTotal": len(indices), "featureColumns": 107},
        "predictionsSha256": sha(root / "predictions.npz"),
    }


# prove all source bytes, parent boosters, bins, forecasts and gate outcomes
def verify(root, evidence):
    root, evidence = Path(root).absolute(), Path(evidence)
    expected_root = Path.home() / ".weather/research-work" / ROOT_NAME
    # only the new registered private experiment can receive this proof
    require(root == expected_root and not root.is_symlink() and root.resolve() == expected_root, "soft-ordinal private root changed")
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(old_freeze["featureNames"] == old_names and len(data["actual"]) > 32896, "soft-ordinal paired input changed")
    cohort, source = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(wind.WIND_NAMES)
    full, wind_flags, source_runs = reconstruct_features(root, data, old_names, cohort, source)
    indices, amounts, flags, states = replay_all(root, data, full, names, old_policy)
    # exact parent control bytes and one numerically reproduced new arm are retained
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(set(saved.files) == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS} and np.array_equal(saved["indices"], indices) and saved["candidateSupported"].dtype == np.dtype(bool) and np.array_equal(saved["candidateSupported"], flags), "soft-ordinal prediction population changed")
        # only the new expected amount is allowed floating native tolerance
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(observed.shape == expected.shape and np.isfinite(observed).all() and (observed >= 0).all() and (np.allclose(observed, expected, rtol=1e-8, atol=1e-9) if name == PRIMARY else np.array_equal(observed, expected)), f"soft-ordinal prediction changed: {name}")
    expected = expected_report(root, data, old_policy, indices, amounts, flags, states, wind_flags, source)
    reported = json.loads((root / "report.json").read_text())
    sections = ("overall", "byLeadBand", "bySeason", "byMonth", "byArchiveEra", "events", "accumulations", "invariants")
    goal.recomputed_gates(reported, {name: expected[name] for name in sections}, data, indices, flags, PRIMARY)
    same_tree(expected, reported, "softOrdinalReport")
    require(len(states) == 12 and source_runs == 3301 and len(names) == 107 and sum(sum(head["modelFile"] is not None for head in state["model"]["heads"].values()) for state in states.values()) == 48, "soft-ordinal inherited native model population changed")
    receipt = {
        "contractVersion": "rain-soft-ordinal-independent-verification/v1", "verified": True,
        "privateRoot": str(root), "verifierSourceSha256": sha(__file__),
        "sourceRawResponsesVerified": source["uniqueSuccessfulRuns"],
        "sourceHttpAttemptsVerified": source["totalHttpAttempts"],
        "sourceReusedRunsVerified": source["inheritedFullResponses"] + source["inheritedShortResponses"],
        "sourceUnresolvedRunsVerified": source["newUnresolvedRuns"],
        "sourceProfilesVerified": source_runs, "featureRowsVerified": len(data["actual"]),
        "featureColumnsVerified": len(names), "monthlyStatesVerified": len(states),
        "nativeModelsRefit": 48, "nativeModelsReused": 36, "nativeModelsUnused": 12,
        "developmentPredictionRows": len(indices), "all49GatesVerified": True,
        "referenceParityVerified": True, "selectedCandidate": expected["selectedCandidate"],
        "developmentPassed": expected["developmentPassed"], "independentEvaluationPerformed": False,
        "productionEligible": False, "productionWrites": False,
        "freezeSha256": sha(root / "soft-ordinal-freeze.json"),
        "reportSha256": sha(root / "report.json"), "predictionsSha256": sha(root / "predictions.npz"),
    }
    # one exclusive private receipt leaves all candidate artifacts untouched
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# accept explicit private source and evidence paths without network access
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
