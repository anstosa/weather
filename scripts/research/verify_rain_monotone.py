"""independently replay the fixed monotone wind-vector rain experiment."""

import argparse
import json
import os
from pathlib import Path

# constrain native reductions before numerical imports
for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_name] = "1"

import evaluate_rain_goal as goal
import numpy as np
import verify_rain_soft_ordinal as inherited_audit
import verify_rain_wind as wind
import verify_rain_wind_continuation as source_audit
import xgboost as xgb
from rain_monotone import POLICY, SOURCE_FILES
from verify_rain_context import feature_sets
from verify_rain_event_guard import load_inputs, same_tree
from verify_rain_recency import MONTHS, effective_support, recent_weights, sha
from verify_rain_search import check_booster, head_support, month_masks, support
from verify_rain_sub24_model import metrics, require, weights
from verify_rain_trajectory import HEADS, TENDENCY_NAMES, native_predict
from verify_rain_trajectory import check_freeze as check_trajectory_freeze

PRIMARY = "hurdleWindMonotoneRaw"
ROOT_NAME = "weather-moisture-research-rain-monotone-20260913-v1"
PARENT_PINS = {
    "wind-freeze.json": "b80c0c6b18b9c026978e1947db734cdbf5ac2b6ae3dc1ff7dce0974493c5d9b8",
    "report.json": "f3d6c2d570b2029093b288f21e9e62ce0c896f0956b2f06ce6ada9673dfda56a",
    "predictions.npz": "ff2f2040acd674ba3881e58b9e3337eaf393ce73f71185fd102992c9f0368f1e",
    "retention-manifest.json": "2a2739f9d72b9d9fef29c3108764dcc70a124c683f6fe28dd4232f60561440eb",
}
ARMS = (*wind.ARMS[:-1], "windOriginal", PRIMARY)
CONSTRAINTS = tuple(1 if index in (5, 6) else 0 for index in range(107))
LIVE_CONSTRAINT_CONFIG = "(" + ",".join(str(value) for value in CONSTRAINTS) + ")"
ROUNDS = 160


# prove the new source only adds two positive raw-rain constraints
def check_freeze(root, old_names):
    _, cohort = check_trajectory_freeze(root, old_names)
    old = json.loads((root / "wind-freeze.json").read_text())
    freeze = json.loads((root / "monotone-freeze.json").read_text())
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(wind.WIND_NAMES)
    require(
        old["policy"] == wind.POLICY
        and old["contextFeatureNames"] == names
        and old["featureNames"] == old_names
        and old["newCandidateOutcomesRead"] is False
        and old["productionWrites"] is False
        and names[5:7] == ["rawRain", "log1pRawRain"]
        and len(names) == 107
        and freeze["policy"] == POLICY
        and POLICY["contractVersion"] == "rain-wind-monotone-exploratory/v1"
        and POLICY["primary"] == PRIMARY
        and POLICY["candidates"] == [PRIMARY]
        and POLICY["arms"] == list(ARMS)
        and POLICY["parameters"] == {**wind.POLICY["parameters"], "monotone_constraints": list(CONSTRAINTS)}
        and POLICY["monotoneConstraints"] == list(CONSTRAINTS)
        and POLICY["monotoneFeatureNames"] == names[5:7]
        and POLICY["monotoneHeads"] == ["0.1", "1.0", "2.5", "amount"]
        and POLICY["boostRounds"] == ROUNDS
        and POLICY["nativeModelsFit"] == 48
        and POLICY["nativeModelsReused"] == 0
        and POLICY["exploratoryOnly"] is True
        and POLICY["productionEligible"] is False
        and freeze["featureNames"] == old_names
        and freeze["contextFeatureNames"] == names
        and freeze["inputSchemaFreezeSha256"] == sha(root / "freeze.json")
        and freeze["parentFreezeSha256"] == PARENT_PINS["wind-freeze.json"] == sha(root / "wind-freeze.json")
        and freeze["newCandidateOutcomesRead"] is False
        and freeze["priorOutcomesAlreadyKnown"] is True
        and freeze["productionWrites"] is False
        and set(freeze["sourceSha256"]) == set(SOURCE_FILES),
        "monotone freeze or sole learner change invalid",
    )
    # every copied wind input must match the old frozen source envelope
    require(
        all(freeze["inputSha256"].get(name) == digest for name, digest in old["inputSha256"].items())
        and freeze["inputSha256"]["wind-freeze.json"] == PARENT_PINS["wind-freeze.json"]
        and freeze["inputSha256"]["inputs/wind/report.json"] == PARENT_PINS["report.json"]
        and freeze["inputSha256"]["inputs/wind/predictions.npz"] == PARENT_PINS["predictions.npz"]
        and freeze["inputSha256"]["inputs/wind/retention-manifest.json"] == PARENT_PINS["retention-manifest.json"],
        "monotone inherited wind lineage changed",
    )
    # compare every current producer dependency with its pre-outcome copy
    for name, digest in freeze["sourceSha256"].items():
        relative = Path(name)
        live, saved = Path(__file__).with_name(name), root / "monotone-sources" / name
        require(
            len(relative.parts) == 1
            and relative.suffix == ".py"
            and live.is_file()
            and saved.is_file()
            and not live.is_symlink()
            and not saved.is_symlink()
            and sha(live) == digest
            and sha(saved) == digest,
            f"monotone source changed: {name}",
        )
    # reject changed feature, native control or prior source bytes
    for name, digest in freeze["inputSha256"].items():
        relative = Path(name)
        saved = root / relative
        require(
            not relative.is_absolute()
            and ".." not in relative.parts
            and saved.is_file()
            and not saved.is_symlink()
            and sha(saved) == digest,
            f"monotone input changed: {name}",
        )
    parent_report = json.loads((root / "inputs/wind/report.json").read_text())
    parent_proof = json.loads((root / "inputs/wind/final-evidence/independent-verification-final.json").read_text())
    # the inherited failed control needs an independent complete replay
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
        "monotone parent independent proof changed",
    )
    expected_root = Path.home() / ".weather/research-work" / ROOT_NAME
    source_root = root / "inputs/direction"
    # replay the copied source through a new exact-root wrapper
    require(
        root == expected_root
        and not root.is_symlink()
        and root.resolve() == expected_root
        and source_root == expected_root / "inputs/direction"
        and not source_root.is_symlink(),
        "monotone private source scope changed",
    )
    replayed = source_audit.audit_root(source_root)
    saved_proof = json.loads((source_root / "final-evidence/independent-verification.json").read_text())
    # only an independent source verification timestamp may change
    require(
        set(replayed) == set(saved_proof)
        and all(replayed[key] == saved_proof[key] for key in replayed if key != "verifiedAtUtc"),
        "monotone copied source proof changed",
    )
    source_report = json.loads((source_root / "report.json").read_text())
    source = wind.check_source_result(replayed, source_report)
    require(
        replayed["reportSha256"] == sha(source_root / "report.json")
        and replayed["normalizedSha256"] == sha(source_root / wind.SOURCE_RELATIVE),
        "monotone source bytes changed",
    )
    return cohort, source


# refit each constrained native head with original weights and no tuning
def refit_heads(root, full, names, actual, hours, month):
    require(
        xgb.__version__ == POLICY["xgboostVersion"]
        and full.dtype == np.dtype(np.float32)
        and full.shape == (len(hours), 107)
        and names == POLICY["featureNames"]
        and names[5:7] == ["rawRain", "log1pRawRain"]
        and len(CONSTRAINTS) == len(names)
        and POLICY["parameters"] == {**wind.POLICY["parameters"], "monotone_constraints": list(CONSTRAINTS)}
        and "base_score" not in wind.SEARCH_POLICY["parameters"],
        "monotone native inputs or fixed parameters changed",
    )
    directory = root / "monotone-models" / month
    mass = weights(hours) * len(hours)
    parameters = {**wind.POLICY["parameters"], "monotone_constraints": CONSTRAINTS}
    state = {"featureNames": names, "rounds": ROUNDS, "monotoneConstraints": list(CONSTRAINTS), "heads": {}}
    models = {}
    # preserve each original occurrence target and minimum support
    for name, threshold, filename in HEADS:
        counts = head_support(actual, hours, threshold)
        record = {"objective": "binary:logistic", "support": counts, "modelFile": None, "sha256": None, "reason": "insufficient_positive_support", "liveMonotoneConstraints": None}
        models[name] = None
        # supported heads use the full original fit population
        if counts["positiveHours"] >= 10 and counts["positiveDates"] >= 3:
            matrix = xgb.DMatrix(full, label=(actual >= threshold).astype(np.float32), weight=mass, feature_names=names, nthread=1)
            booster = xgb.train({**parameters, "objective": "binary:logistic"}, matrix, num_boost_round=ROUNDS)
            live = json.loads(booster.save_config())["learner"]
            observed = live["gradient_booster"]["tree_train_param"]["monotone_constraints"]
            # the live fit, not a reloaded model, proves the training constraint
            require(observed == LIVE_CONSTRAINT_CONFIG and live["gradient_booster"]["tree_train_param"]["max_bin"] == "256", f"monotone event constraint not applied: {month}:{name}")
            path = directory / filename
            digest = sha(path)
            check_booster(booster, path, digest, "binary:logistic", ROUNDS, names)
            record.update({"modelFile": filename, "sha256": digest, "reason": "fitted", "liveMonotoneConstraints": observed})
            models[name] = booster
        else:
            require(not (directory / filename).exists(), f"unexpected unsupported monotone event head: {month}:{name}")
        state["heads"][name] = record
    wet = actual >= .1
    counts = head_support(actual, hours, .1)
    record = {"objective": "reg:gamma", "support": counts, "modelFile": None, "sha256": None, "reason": "insufficient_wet_support", "liveMonotoneConstraints": None}
    models["amount"] = None
    # the conditional gamma keeps only previously supported wet labels
    if counts["positiveHours"] >= 100 and counts["positiveDates"] >= 20:
        matrix = xgb.DMatrix(full[wet], label=actual[wet], weight=weights(hours[wet]) * int(wet.sum()), feature_names=names, nthread=1)
        booster = xgb.train({**parameters, "objective": "reg:gamma"}, matrix, num_boost_round=ROUNDS)
        live = json.loads(booster.save_config())["learner"]
        observed = live["gradient_booster"]["tree_train_param"]["monotone_constraints"]
        # gamma receives the same two positive feature constraints
        require(observed == LIVE_CONSTRAINT_CONFIG and live["gradient_booster"]["tree_train_param"]["max_bin"] == "256", f"monotone gamma constraint not applied: {month}")
        path = directory / "amount.json"
        digest = sha(path)
        check_booster(booster, path, digest, "reg:gamma", ROUNDS, names)
        record.update({"modelFile": "amount.json", "sha256": digest, "reason": "fitted", "liveMonotoneConstraints": observed})
        models["amount"] = booster
    else:
        require(not (directory / "amount.json").exists(), f"unexpected unsupported monotone gamma head: {month}")
    state["heads"]["amount"] = record
    return models, state


# replay one month's causal fit, earlier calibration and fixed ordinal fallback
def replay_month(root, data, full, names, old_policy, month, old_ordinal):
    fit, calibration, evaluation, bounds = month_masks(data, month, old_policy, wind.SEARCH_POLICY)
    actual, hours = data["actual"][calibration], data["hour"][calibration]
    counts = {"training": support(data["actual"][fit], data["hour"][fit]), "calibration": support(actual, hours)}
    mass = recent_weights(hours, bounds["calibrationMaximumValidHourExclusive"])
    effective = effective_support(actual, hours, mass)
    supported = (
        all(counts["training"][key] >= minimum for key, minimum in POLICY["trainingSupport"].items())
        and all(counts["calibration"][key] >= minimum for key, minimum in POLICY["calibrationSupport"].items())
        and all(effective[key] >= minimum for key, minimum in POLICY["effectiveSupport"].items())
    )
    parent_path = root / "wind-states" / f"{month}.json"
    retained = json.loads(parent_path.read_text())
    # only the new native fit may differ from this known wind month
    require(
        all(retained[key] == value for key, value in bounds.items())
        and retained["support"] == counts
        and retained["supported"] is supported,
        f"monotone parent chronology changed: {month}",
    )
    same_tree(effective, retained["effectiveSupport"], f"windEffective.{month}")
    state = {**bounds, "support": counts, "effectiveSupport": effective, "supported": bool(supported), "model": None, "parentStateSha256": sha(parent_path), "proposedRules": None, "uniformRules": None, "nestingSafetyFallback": None, "calibration": None, "reason": "insufficient_support"}
    rows = np.where(evaluation)[0]
    # unsupported original months never receive a new native fit
    if not supported:
        require(not (root / "monotone-models" / month).exists(), f"unexpected unsupported monotone fit: {month}")
        predicted = old_ordinal.copy()
    else:
        models, model_state = refit_heads(root, full[fit], names, data["actual"][fit], data["hour"][fit], month)
        pc, ac = native_predict(models, full[calibration], names)
        pe, ae = native_predict(models, full[evaluation], names)
        require(np.isfinite(ac).all() and np.isfinite(ae).all(), f"missing supported monotone gamma: {month}")
        raw_cal, raw_eval = data["raw"][calibration].astype(float), data["raw"][evaluation].astype(float)
        proposed = wind.ordinal_rules(actual, raw_cal, pc, hours, wind.SEARCH_POLICY)
        uniform, fallback = wind.checked_rules(actual, raw_cal, pc, hours, proposed, wind.SEARCH_POLICY)
        base_cal = np.clip(.25 * raw_cal + .75 * ac, 0, 30)
        base_eval = np.clip(.25 * raw_eval + .75 * ae, 0, 30)
        fitted = wind.calibrate_hurdle(actual, hours, raw_cal, pc, base_cal, uniform, bounds["calibrationMaximumValidHourExclusive"])
        predicted = wind.predict_hurdle(raw_eval, pe, base_eval, fitted)
        state.update({"model": model_state, "proposedRules": proposed, "uniformRules": uniform, "nestingSafetyFallback": fallback, "calibration": fitted, "reason": "monotone_wind_hurdle_calibrated"})
    reported = json.loads((root / "monotone-states" / f"{month}.json").read_text())
    same_tree(state, reported, f"monotoneState.{month}")
    return rows, predicted, state


# preserve all fourteen exact wind controls and fixed evaluation rows
def replay_all(root, data, full, names, old_policy):
    with np.load(root / "inputs/wind/predictions.npz", allow_pickle=False) as old:
        reference_indices = old["indices"]
        controls = {name: old["amount::" + name] for name in wind.ARMS[:-1]}
        controls["windOriginal"] = old["amount::" + wind.PRIMARY]
    indices, new_amounts, flags, states = [], [], [], {}
    offset = 0
    # each of the twelve month partitions retains its old raw fallback rows
    for month in MONTHS:
        _, _, evaluation, _ = month_masks(data, month, old_policy, wind.SEARCH_POLICY)
        end = offset + int(evaluation.sum())
        rows, predicted, state = replay_month(root, data, full, names, old_policy, month, controls["ordinal90"][offset:end])
        require(np.array_equal(rows, reference_indices[offset:end]), f"monotone month population changed: {month}")
        indices.append(rows)
        new_amounts.append(predicted)
        flags.append(np.full(len(rows), state["supported"], dtype=bool))
        states[month] = state
        offset = end
    indices, flags = np.concatenate(indices), np.concatenate(flags)
    require(offset == 32896 and len(np.unique(indices)) == offset and np.array_equal(indices, reference_indices), "monotone fixed evaluation population changed")
    return indices, {**controls, PRIMARY: np.concatenate(new_amounts)}, flags, states


# recompute all fifteen arm metrics and the unchanged forty-nine safety gates
def expected_report(root, data, old_policy, indices, amounts, flags, states, wind_flags, source):
    scores = goal.recomputed_scores(data, old_policy, indices, amounts)
    screen = goal.independent_gate(goal.gate_view(scores, PRIMARY), data, indices, flags)
    require(len(screen["gates"]) == 49, "monotone fixed gate set changed")
    hours = data["hour"][indices]
    fitted_count = sum(sum(head["modelFile"] is not None for head in state["model"]["heads"].values()) for state in states.values() if state["model"] is not None)
    return {
        "contractVersion": POLICY["contractVersion"], "policy": POLICY,
        "freezeSha256": sha(root / "monotone-freeze.json"), **scores,
        "monthlyStates": states, "independentEvaluationPerformed": False,
        "productionEligible": False, "productionWrites": False,
        "treeFitPerformed": True, "nativeModelsFit": fitted_count,
        "nativeModelsReused": 0, "exploratoryOnly": True,
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


# prove the native shape constraint, copied source, metrics and gate outcome
def verify(root, evidence):
    root, evidence = Path(root).absolute(), Path(evidence)
    expected_root = Path.home() / ".weather/research-work" / ROOT_NAME
    # only this preregistered private root may receive a PASS receipt
    require(root == expected_root and not root.is_symlink() and root.resolve() == expected_root, "monotone private root changed")
    old_freeze, old_policy, old_names, data = load_inputs(root)
    require(old_freeze["featureNames"] == old_names and len(data["actual"]) > 32896, "monotone paired input changed")
    cohort, source = check_freeze(root, old_names)
    names = feature_sets(old_names)["full"] + list(TENDENCY_NAMES) + list(wind.WIND_NAMES)
    full, wind_flags, source_runs = inherited_audit.reconstruct_features(root, data, old_names, cohort, source)
    indices, amounts, flags, states = replay_all(root, data, full, names, old_policy)
    # controls must be byte-exact; the new native result may differ only by float tolerance
    with np.load(root / "predictions.npz", allow_pickle=False) as saved:
        require(set(saved.files) == {"indices", "candidateSupported"} | {"amount::" + name for name in ARMS} and np.array_equal(saved["indices"], indices) and saved["candidateSupported"].dtype == np.dtype(bool) and np.array_equal(saved["candidateSupported"], flags), "monotone prediction population changed")
        # compare every old arm without rounding away an altered baseline
        for name, expected in amounts.items():
            observed = saved["amount::" + name]
            require(observed.shape == expected.shape and np.isfinite(observed).all() and (observed >= 0).all() and (np.allclose(observed, expected, rtol=1e-8, atol=1e-9) if name == PRIMARY else np.array_equal(observed, expected)), f"monotone prediction changed: {name}")
    expected = expected_report(root, data, old_policy, indices, amounts, flags, states, wind_flags, source)
    reported = json.loads((root / "report.json").read_text())
    sections = ("overall", "byLeadBand", "bySeason", "byMonth", "byArchiveEra", "events", "accumulations", "invariants")
    goal.recomputed_gates(reported, {name: expected[name] for name in sections}, data, indices, flags, PRIMARY)
    same_tree(expected, reported, "monotoneReport")
    fitted_count = sum(sum(head["modelFile"] is not None for head in state["model"]["heads"].values()) for state in states.values() if state["model"] is not None)
    require(len(states) == 12 and source_runs == 3301 and len(names) == 107 and fitted_count == 48, "monotone native or source population changed")
    receipt = {
        "contractVersion": "rain-monotone-independent-verification/v1", "verified": True,
        "privateRoot": str(root), "verifierSourceSha256": sha(__file__),
        "sourceRawResponsesVerified": source["uniqueSuccessfulRuns"],
        "sourceHttpAttemptsVerified": source["totalHttpAttempts"],
        "sourceReusedRunsVerified": source["inheritedFullResponses"] + source["inheritedShortResponses"],
        "sourceUnresolvedRunsVerified": source["newUnresolvedRuns"],
        "sourceProfilesVerified": source_runs, "featureRowsVerified": len(data["actual"]),
        "featureColumnsVerified": len(names), "monthlyStatesVerified": len(states),
        "nativeModelsRefit": 48, "nativeModelsReused": 0,
        "developmentPredictionRows": len(indices), "all49GatesVerified": True,
        "referenceParityVerified": True, "selectedCandidate": expected["selectedCandidate"],
        "developmentPassed": expected["developmentPassed"], "independentEvaluationPerformed": False,
        "productionEligible": False, "productionWrites": False,
        "freezeSha256": sha(root / "monotone-freeze.json"),
        "reportSha256": sha(root / "report.json"), "predictionsSha256": sha(root / "predictions.npz"),
    }
    # one exclusive private receipt leaves candidate artifacts untouched
    with evidence.open("x") as stream:
        json.dump(receipt, stream, sort_keys=True, allow_nan=False)
        stream.write("\n")
    return receipt


# accept only explicit private inputs without transport or production writes
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.root, args.evidence), allow_nan=False))
