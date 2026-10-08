"""Real four-head monthly rain refits on opened, earlier-only inputs."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo

GRID = ("R0_exact_refit", "R1_winter_scale_0_90", "R2_winter_scale_0_95",
        "R3_spring_wet_logit_plus_0_20", "R4_summer_wet_logit_plus_0_20",
        "R5_nested_cumulative_min", "R6_heavy_raw_blend_0_25")
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_ROWS = 250_000
POLICY = {"contractVersion": "rain-maintenance-fit/v2", "grid": list(GRID),
          "features": 107, "rounds": 160, "calibrationDays": 90, "embargoDays": 7,
          "minimumCalibrationDates": 60,
          "sourceFitterLegacyCalibrationDays": 90, "nthread": 1,
          "developmentRows": 32896, "confirmationOpened": False}


# reject normalized instants before deriving causal receipt boundaries
def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    # require exact millisecond utc representation
    if parsed.tzinfo != dt.timezone.utc or parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        raise ValueError("rain requires a canonical utc instant")
    return parsed


# reuse the approved ninety-day policy without drifting the original training floor
def maintenance_month_masks(data, month):
    search = importlib.import_module("rain_search")
    start = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=dt.timezone.utc)
    # reject normalized due-month identities
    if start.strftime("%Y-%m") != month:
        raise ValueError("invalid rain due month")
    # a later inherited policy edit cannot silently change the agreed support
    if search.POLICY["calibrationDays"] != POLICY["calibrationDays"] or search.POLICY["calibrationSupport"]["dates"] != POLICY["minimumCalibrationDates"]:
        raise ValueError("rain calibration policy drifted")
    fit, calibration, evaluation, bounds = search.month_masks(data, month)
    return fit, calibration, evaluation, {**bounds,
        "maintenanceCalibrationDays": POLICY["calibrationDays"],
        "legacyCalibrationDays": search.POLICY["calibrationDays"]}


# apply exactly seven independent projections of the same newly fitted heads
def project_grid(raw, probabilities, amount, calibration, months):
    np = importlib.import_module("numpy")
    hurdle = importlib.import_module("rain_hurdle_calibration")
    search = importlib.import_module("rain_search")
    raw, probabilities, amount = np.asarray(raw), np.asarray(probabilities), np.asarray(amount)
    months = np.asarray(months)
    # freeze geometry and reject native overflow before projection
    if probabilities.shape != (len(raw), 3) or amount.shape != raw.shape or months.shape != raw.shape or not np.isfinite(amount).all():
        raise ValueError("invalid rain grid head geometry")
    output = {}
    # no Cartesian combinations or target-dependent grid expansion
    for name in GRID:
        probability = probabilities.copy()
        # apply one prespecified seasonal wet-logit change before category projection
        if name in (GRID[3], GRID[4]):
            selected = np.isin(months, (3, 4, 5) if name == GRID[3] else (6, 7, 8))
            p = np.clip(probability[selected, 0], 1e-12, 1 - 1e-12)
            probability[selected, 0] = 1 / (1 + np.exp(-(np.log(p / (1 - p)) + .20)))
        # nesting is one separate arm rather than an adaptive safety combination
        if name == GRID[5]:
            probability = np.minimum.accumulate(probability, axis=1)
        predicted = hurdle.predict(raw, probability, search.blended(raw, amount), calibration)
        # winter scales affect only their own post-calibration arm
        if name in (GRID[1], GRID[2]):
            predicted[np.isin(months, (12, 1, 2))] *= .90 if name == GRID[1] else .95
        # retain the exact heavy-only raw blend as its own finite hypothesis
        if name == GRID[6]:
            selected = raw >= 1
            predicted[selected] = .25 * raw[selected] + .75 * predicted[selected]
        output[name] = (predicted, probability)
    return output


# preserve real native source and target availability for every fitted row
def validate_rows(rows, month):
    start = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=dt.timezone.utc)
    cutoff = start - dt.timedelta(days=7)
    seen = set()
    # validate immutable keys before any model reads their labels
    for row in rows:
        # no missing receipt or reserved confirmation can gain fitting authority
        if row["key"] in seen or row.get("evidenceClass") != "development" or row.get("sourceReceiptAt") is None or row.get("targetMaxReceiptAt") is None:
            raise ValueError("rain fit input has invalid opened provenance")
        seen.add(row["key"])
        # catch-up retains the due month's original cutoff
        if max(instant(row["sourceReceiptAt"]), instant(row["targetMaxReceiptAt"]), instant(row["validAt"])) >= cutoff:
            raise ValueError("rain fit input is not earlier than the due cutoff")
        # phase eligibility uses the raw target-hour forecast temperature
        if len(row["features"]) != 107 or not isinstance(row.get("rawTargetHourTemperatureC"), (int, float)) or row["rawTargetHourTemperatureC"] <= 2 or not math.isfinite(row["rawTargetHourTemperatureC"]):
            raise ValueError("rain fit schema or phase differs")
        # missing predictors are explicit nulls, never inferred target values
        if any(value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)) for value in row["features"]):
            raise ValueError("rain features must be finite or explicit missing")
        # targets and source amounts remain physically closed
        if any(not isinstance(row.get(key), (int, float)) or isinstance(row[key], bool) or not math.isfinite(row[key]) or row[key] < 0 for key in ("actual", "raw")):
            raise ValueError("invalid rain amount")


# assemble exactly aligned native arrays without persistent decoded intermediates
def native_arrays(rows):
    np = importlib.import_module("numpy")
    hours = np.asarray([int(instant(row["validAt"]).timestamp() // 3600) for row in rows], dtype=np.int64)
    initialized = np.asarray([int(instant(row["runInitializedAt"]).timestamp() // 3600) for row in rows], dtype=np.int64)
    data = {"hour": hours, "initialized": initialized,
            "actual": np.asarray([row["actual"] for row in rows], dtype=np.float64),
            "raw": np.asarray([row["raw"] for row in rows], dtype=np.float64)}
    x = np.asarray([[np.nan if value is None else value for value in row["features"]] for row in rows], dtype=np.float32).reshape((len(rows), 107))
    return data, x


# run the shared closed development evaluator, never minting a qualification
def screen_grid(rows, projected):
    bridge = """
import { readFileSync } from 'node:fs';
import { createRainMaintenanceEvaluationRow, evaluateRainMaintenanceDevelopment }
  from './packages/forecast-adjustment/dist/maintenance-policy.js';
const rows = JSON.parse(readFileSync(0, 'utf8')).map(createRainMaintenanceEvaluationRow);
process.stdout.write(JSON.stringify(evaluateRainMaintenanceDevelopment(rows)));
"""
    np = importlib.import_module("numpy")
    weights = importlib.import_module("run_rain_sub24").weights
    hours = np.asarray([int(instant(row["validAt"]).timestamp() // 3600) for row in rows])
    reports = {}
    # evaluate every arm with the identical frozen controls and full 49-gate matrix
    for name in GRID:
        prediction, probabilities = projected[name]
        inputs = []
        # retain historical-only classification and bind each source/target row identity
        for index, row in enumerate(rows):
            value = dict(row["evaluationRow"])
            value.update({"candidatePrediction": float(prediction[index]), "applied": True,
                          "evidenceClass": "historical_development", "sourceReceiptAt": None,
                          "firstEdgeCommittedAt": None,
                          "candidateProbability": dict(zip(("atLeast0_1", "atLeast1_0", "atLeast2_5"), map(float, probabilities[index]), strict=True))})
            inputs.append(value)
        data = json.dumps(inputs, separators=(",", ":"), allow_nan=False).encode()
        # cap the native scorer pipe independently of the overall fitter input
        if len(data) > 64 * 1024 * 1024:
            raise ValueError("rain development scorer input exceeded")
        result = subprocess.run(["node", "--input-type=module", "-e", bridge], input=data,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        report = json.loads(result.stdout)
        support = {}
        # gauge-support strata are diagnostics plus a supported nonharm veto
        for label, low, high in (("3", 3, 3), ("4_5", 4, 5), ("6_12", 6, 12)):
            selected = np.asarray([low <= row["gaugeCount"] <= high for row in rows])
            count = int(selected.sum())
            dates = len(np.unique(hours[selected] // 24))
            candidate_mae = raw_mae = None
            # never call an empty or unsupported stratum safe
            if count and dates >= 60:
                weight = weights(hours[selected])
                actual = np.asarray([row["actual"] for row in rows])[selected]
                raw = np.asarray([row["raw"] for row in rows])[selected]
                candidate_mae = float(weight @ abs(prediction[selected] - actual))
                raw_mae = float(weight @ abs(raw - actual))
            support[label] = {"rows": count, "dates": dates, "candidateMae": candidate_mae,
                              "rawMae": raw_mae, "harm": candidate_mae is not None and candidate_mae > raw_mae}
        mae = float(weights(hours) @ abs(prediction - np.asarray([row["actual"] for row in rows])))
        reports[name] = {"gateReport": report, "gaugeSupport": support, "mae": mae,
                         "eligible": report["passed"] and not any(value["harm"] for value in support.values())}
    return reports


# execute the actual current four-head fitter and a finite earlier-only grid
def fit_monthly_rain(payload, output_root):
    wind = importlib.import_module("rain_wind")
    names = importlib.import_module("rain_wind_features").FEATURE_NAMES
    np = importlib.import_module("numpy")
    # prevent caller-defined families, grids and predictor order
    if set(payload) != {"contractVersion", "month", "featureNames", "trainingRows", "developmentRows"} or payload["contractVersion"] != "rain-maintenance-fit-input/v2" or payload["featureNames"] != list(names):
        raise ValueError("invalid rain fit-only input")
    training, development = payload["trainingRows"], payload["developmentRows"]
    # reject unbounded population sizes before allocating native matrices
    if not isinstance(training, list) or not isinstance(development, list) or len(training) + len(development) > MAX_ROWS:
        raise ValueError("rain fit row ceiling exceeded")
    validate_rows(training, payload["month"])
    validate_rows(development, payload["month"])
    combined = {row["key"]: row for row in training}
    # shared historical keys must retain identical immutable numerical inputs
    for row in development:
        previous = combined.get(row["key"])
        # reject a revised outcome concealed by the same key
        if previous is not None and any(previous[key] != row[key] for key in ("features", "actual", "raw", "validAt", "runInitializedAt")):
            raise ValueError("rain duplicate immutable row differs")
        combined[row["key"]] = row
    rows = sorted(combined.values(), key=lambda row: (row["validAt"], row["key"]))
    data, x = native_arrays(rows)
    masks = maintenance_month_masks(data, payload["month"])
    _, _, final_state = wind.fit_month(output_root, data, x, payload["month"], np.empty(0), masks=masks)
    report = {**POLICY, "dueMonth": payload["month"], "state": "no_candidate", "selectedId": None,
              "fitState": final_state, "reason": "insufficient_development", "gridReports": {}, "artifact": None}
    # all four final heads must be real supported fits, not control replay
    if not final_state["supported"] or final_state["model"] is None or any(value["reason"] != "fitted" for value in final_state["model"]["heads"].values()):
        report["reason"] = "insufficient_native_fit_support"
        return report
    # a partial population cannot replace the frozen development matrix
    if len(development) != 32896 or any("evaluationRow" not in row or "gaugeCount" not in row for row in development):
        return report
    by_key = {row["key"]: index for index, row in enumerate(rows)}
    projected = {name: (np.full(len(development), np.nan), np.full((len(development), 3), np.nan)) for name in GRID}
    month_labels = [(instant(row["runInitializedAt"]) + dt.timedelta(hours=8)).strftime("%Y-%m") for row in development]
    # fit historical development months without opening any future confirmation
    for month in sorted(set(month_labels)):
        mask = maintenance_month_masks(data, month)
        control = data["raw"][mask[2]].copy()
        indices, _, state = wind.fit_month(output_root, data, x, month, control, masks=mask)
        # unsupported historical months cannot be omitted from the population
        if not state["supported"] or any(value["reason"] != "fitted" for value in state["model"]["heads"].values()):
            report["reason"] = "insufficient_development_month"
            return report
        import xgboost as xgb
        models = {}
        # reopen only just-written private-tmpfs numerical models
        for name, head in state["model"]["heads"].items():
            models[name] = xgb.Booster()
            models[name].load_model(output_root / "wind-models" / month / head["modelFile"])
        pc, ac = wind.context.predict_ordinal(models, x[indices], list(names))
        valid_months = [instant(rows[index]["validAt"]).astimezone(ZoneInfo("America/Los_Angeles")).month for index in indices]
        grid = project_grid(data["raw"][indices], pc, ac, state["calibration"], valid_months)
        lookup = {index: position for position, index in enumerate(indices)}
        # align development rows by immutable key, never sorting by outcomes
        for position, row in enumerate(development):
            index = by_key[row["key"]]
            # include only the month's genuine decision population
            if month_labels[position] == month and index in lookup:
                local_index = lookup[index]
                # keep every arm on exactly the same row
                for name in GRID:
                    projected[name][0][position] = grid[name][0][local_index]
                    projected[name][1][position] = grid[name][1][local_index]
    # any row gap rejects the whole grid rather than manufacturing raw success
    if any(not np.isfinite(value).all() for pair in projected.values() for value in pair):
        report["reason"] = "development_alignment_gap"
        return report
    reports = screen_grid(development, projected)
    eligible = [name for name in GRID if reports[name]["eligible"]]
    selected = min(eligible, key=lambda name: (reports[name]["mae"], name)) if eligible else None
    report.update({"gridReports": reports, "selectedId": selected, "reason": "no_development_gate_passer"})
    # retain only compact numerical tree operations in a selectable artifact
    if selected is not None:
        compact = importlib.import_module("export_rain_wind_runtime").compact_head
        heads = {}
        # remove raw native training buffers and private observations from publication
        for name, head in final_state["model"]["heads"].items():
            content = (output_root / "wind-models" / payload["month"] / head["modelFile"]).read_bytes()
            heads[name] = compact(content, name, list(names))
        report.update({"state": "development_candidate", "reason": "development_gate_passer",
                       "artifact": {"contractVersion": "rain-maintenance-artifact/v2", "projectionId": selected,
                                    "modelMonth": payload["month"], "featureNames": list(names),
                                    "heads": heads, "calibration": final_state["calibration"]}})
    return report


# use fixed sandbox paths and prohibit result overwrite
def main():
    # no caller path, code string or registration operation is accepted
    if sys.argv[1:] != ["--fit-only"]:
        raise ValueError("rain maintenance requires exactly --fit-only")
    path = Path("/input/data/rain.json")
    # inspect the fixed regular input before decoding rows
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("invalid rain sandbox input")
    # destroy native model intermediates inside the kernel-bounded private output mount
    with tempfile.TemporaryDirectory(dir="/output", prefix="rain-native-") as temporary:
        result = fit_monthly_rain(json.loads(path.read_bytes()), Path(temporary))
    content = json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"
    # the persisted family graph remains separately bounded
    if len(content) > MAX_OUTPUT_BYTES:
        raise ValueError("rain candidate ceiling exceeded")
    fd = os.open("/output/rain.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    # fsync only the sanitized result before namespace teardown
    with os.fdopen(fd, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    sys.stdout.buffer.write(content)
    sys.stdout.buffer.flush()


# importing the module performs no fit or archive access
if __name__ == "__main__":
    main()
