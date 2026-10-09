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


# preserve raw event calls after every selected projection
def guard_projection(raw, projected):
    np = importlib.import_module("numpy")
    raw, projected = np.asarray(raw, dtype=float), np.asarray(projected, dtype=float)
    # reject invalid numerical projections before applying safety
    if raw.shape != projected.shape or not np.isfinite(raw).all() or not np.isfinite(projected).all() or (raw < 0).any() or (projected < 0).any():
        raise ValueError("invalid rain grid guard predictions")
    return np.where(raw >= 1, raw,
                    np.where(raw >= .1, np.maximum(.1, projected), projected))


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
        output[name] = (guard_projection(raw, predicted), probability)
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
def screen_grid(rows, projected, population=None):
    bridge_v2 = """
import { readFileSync } from 'node:fs';
import { createRainMaintenanceEvaluationRow, evaluateRainMaintenanceDevelopment }
  from './packages/forecast-adjustment/dist/maintenance-policy.js';
const rows = JSON.parse(readFileSync(0, 'utf8')).map(createRainMaintenanceEvaluationRow);
process.stdout.write(JSON.stringify(evaluateRainMaintenanceDevelopment(rows)));
"""
    bridge_v3 = """
import { readFileSync } from 'node:fs';
import { createRainMaintenanceEvaluationRow, evaluateRainMaintenanceDevelopmentV3 }
  from './packages/forecast-adjustment/dist/maintenance-policy.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
const rows = input.rows.map(createRainMaintenanceEvaluationRow);
process.stdout.write(JSON.stringify(evaluateRainMaintenanceDevelopmentV3(rows, input.population)));
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
        data = json.dumps(inputs if population is None else {"population": population, "rows": inputs},
                          separators=(",", ":"), allow_nan=False).encode()
        # cap the native scorer pipe independently of the overall fitter input
        if len(data) > 64 * 1024 * 1024:
            raise ValueError("rain development scorer input exceeded")
        result = subprocess.run(["node", "--input-type=module", "-e",
                                 bridge_v2 if population is None else bridge_v3], input=data,
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


# hash one value with the shared sorted canonical json and lf representation
def canonical_hash(value):
    content = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"
    return hashlib.sha256(content).hexdigest()


# validate one complete annual value-blind source population
def validate_development_population(population, rows):
    fields = {"contractVersion", "cycleHours", "developmentEndAt", "developmentStartAt",
              "eligibleRowCount", "excludedColdRowCount", "expectedRowCount",
              "missingSourceRowCount", "missingTargetRowCount", "observedRowCount",
              "operationalHorizonHours", "populationMemberRootSha256",
              "populationReceiptRootSha256", "populationSha256", "sourceModelLeadHours",
              "sourcePopulation"}
    member_fields = {"issuedAt", "key", "modelLeadHours", "operationalHorizonHours",
                     "phaseEligible", "sourceMemberSha256", "sourceReceiptSha256",
                     "targetAvailable", "validAt"}
    # reject missing, extra or incomplete proof fields before native allocation
    if set(population) != fields or population["contractVersion"] != "rain-maintenance-development-population/v3":
        raise ValueError("invalid rain development population")
    start, end = instant(population["developmentStartAt"]), instant(population["developmentEndAt"])
    expected_start = end.replace(year=end.year - 1)
    model_leads = list(range(9, 32))
    operational = list(range(1, 24))
    # freeze the exact calendar year and source-to-operational lead offset
    if start != expected_start or population["cycleHours"] != [0, 6, 12, 18] or population["sourceModelLeadHours"] != model_leads or population["operationalHorizonHours"] != operational or not isinstance(population["sourcePopulation"], list):
        raise ValueError("rain development interval differs")
    expected = {}
    first_run_hour = math.floor((start.timestamp() / 3600 - 31) / 6) * 6
    end_hour = int(end.timestamp() // 3600)
    # include the issuance halo needed by target clocks at both boundaries
    for run_hour in range(first_run_hour, end_hour - 9 + 1, 6):
        run = dt.datetime.fromtimestamp(run_hour * 3600, dt.timezone.utc)
        issued = run + dt.timedelta(hours=8)
        # preserve source leads nine through thirty-one without resampling
        for lead in model_leads:
            valid = run + dt.timedelta(hours=lead)
            # omit only target clocks outside the half-open annual interval
            if valid < start or valid >= end:
                continue
            key = f"{run.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}/{valid.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}"
            expected[key] = {"issuedAt": issued.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                             "modelLeadHours": lead, "operationalHorizonHours": lead - 8,
                             "validAt": valid.isoformat(timespec="milliseconds").replace("+00:00", "Z")}
    seen = set()
    eligible = []
    excluded = 0
    # validate exact archive source identities and geometry in expected order
    for member in population["sourcePopulation"]:
        # prohibit caller-defined source metadata or duplicate keys
        if set(member) != member_fields or member["key"] in seen or member["key"] not in expected:
            raise ValueError("rain development source member differs")
        geometry = expected[member["key"]]
        # bind the source member to its original issued and target clocks
        if any(member[field] != geometry[field] for field in geometry) or type(member["phaseEligible"]) is not bool or type(member["targetAvailable"]) is not bool or not all(isinstance(member[field], str) and len(member[field]) == 64 and all(character in "0123456789abcdef" for character in member[field]) for field in ("sourceMemberSha256", "sourceReceiptSha256")):
            raise ValueError("rain development source member differs")
        seen.add(member["key"])
        # retain source-temperature eligibility without opening target values
        if member["phaseEligible"]:
            # every source-eligible development row requires its actual native target
            if not member["targetAvailable"]:
                raise ValueError("rain development target is unavailable")
            eligible.append(member["key"])
        else:
            excluded += 1
    counts = [population[name] for name in ("eligibleRowCount", "excludedColdRowCount",
              "expectedRowCount", "missingSourceRowCount", "missingTargetRowCount", "observedRowCount")]
    # require complete source custody and recomputed roots before fitting
    if any(type(value) is not int or value < 0 for value in counts) or set(expected) != seen or population["expectedRowCount"] != len(expected) or population["observedRowCount"] != len(expected) or population["eligibleRowCount"] != len(eligible) or population["excludedColdRowCount"] != excluded or population["missingSourceRowCount"] != 0 or population["missingTargetRowCount"] != 0 or population["populationMemberRootSha256"] != canonical_hash(sorted(member["sourceMemberSha256"] for member in population["sourcePopulation"])) or population["populationReceiptRootSha256"] != canonical_hash(sorted({member["sourceReceiptSha256"] for member in population["sourcePopulation"]})) or population["populationSha256"] != canonical_hash(population["sourcePopulation"]):
        raise ValueError("rain development population proof differs")
    # match the exact source-eligible population to actual target-bearing rows
    if sorted(eligible) != sorted(row["key"] for row in rows):
        raise ValueError("rain development evaluation population differs")


# derive original earlier-only raw-control scales for one historical month
def historical_control_scales(data, month):
    np = importlib.import_module("numpy")
    search = importlib.import_module("rain_search")
    residual = importlib.import_module("rain_residual")
    recent = importlib.import_module("rain_recency_calibration")
    legacy = importlib.import_module("run_rain_sub24")
    fit, calibration, _, bounds = maintenance_month_masks(data, month)
    legacy_fit, legacy_calibration, _, _ = legacy.month_masks(data, month)
    actual, hours, raw = data["actual"][calibration], data["hour"][calibration], data["raw"][calibration]
    counts = {"training": residual.support(data["actual"][fit], data["hour"][fit]),
              "calibration": residual.support(actual, hours)}
    common = residual.supported(counts["training"], search.POLICY["trainingSupport"]) and residual.supported(counts["calibration"], search.POLICY["calibrationSupport"]) and int(legacy_fit.sum()) >= 1000 and int((data["actual"][legacy_fit] >= .1).sum()) >= 100 and int(legacy_calibration.sum()) >= 200
    # an unsupported historical control month cannot be omitted or raw-filled
    if not common:
        return None
    same_window = search.calibrate(actual, hours, lambda scale: np.clip(raw * scale, 0, 30))["scale"]
    mass = recent.recent_weights(hours, bounds["calibrationMaximumValidHourExclusive"])
    effective = recent.effective_support(actual, hours, mass)
    recent_supported = effective["effectiveDates"] >= 30 and effective["effectiveWetDates"] >= 3
    recent_scale = recent.calibrate(actual, hours, lambda scale: np.clip(raw * scale, 0, 30), mass)["scale"] if recent_supported else same_window
    legacy_scale = legacy.volume_scale(data["actual"][legacy_calibration], data["raw"][legacy_calibration], data["hour"][legacy_calibration])
    return {"legacy": legacy_scale, "recent": recent_scale, "sameWindow": same_window}


# build one historical-only shared policy row from earlier-cutoff controls
def historical_evaluation_row(row, incumbent, probability, scales):
    raw = row["raw"]
    native_probability = {"atLeast0_1": float(raw >= .1), "atLeast1_0": float(raw >= 1),
                          "atLeast2_5": float(raw >= 2.5)}
    incumbent_probability = dict(zip(("atLeast0_1", "atLeast1_0", "atLeast2_5"),
                                     map(float, probability), strict=True))
    return {"actualBestMatchPrediction": raw, "applied": True, "candidatePrediction": incumbent,
            "candidateProbability": incumbent_probability, "evidenceClass": "historical_development",
            "farmTarget": None, "firstEdgeCommittedAt": None,
            "horizonHours": row["operationalHorizonHours"], "incumbentPrediction": incumbent,
            "incumbentProbability": incumbent_probability, "key": row["key"],
            "localDate": instant(row["validAt"]).astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat(),
            "nativeSourcePrediction": raw, "nativeSourceProbability": native_probability,
            "nearestThree": None, "persistencePrediction": row["persistencePrediction"] if row["persistencePrediction"] is not None else raw,
            "provenanceComplete": True, "providerFamily": None,
            "rawTargetHourTemperatureC": row["rawTargetHourTemperatureC"],
            "recentVolumeScalePrediction": min(30, raw * scales["recent"]),
            "runKey": row["runInitializedAt"], "sameWindowVolumeScalePrediction": min(30, raw * scales["sameWindow"]),
            "sourceReceiptAt": None, "sourceRowSha256": row["sourceRowSha256"], "stationKey": None,
            "target": row["actual"], "targetRowSha256": row["targetRowSha256"],
            "unchangedOrdinalPrediction": incumbent, "validAt": row["validAt"],
            "volumeScalePrediction": raw * scales["legacy"]}


# validate one future-only joined row's operational and archive identities
def validate_v3_row(row):
    persistence = row.get("persistencePrediction")
    hashes = (row.get("sourceRowSha256"), row.get("targetRowSha256"))
    lead = row.get("modelLeadHours")
    # require the original source lead offset and genuine member hashes
    if lead not in range(9, 32) or row.get("operationalHorizonHours") != lead - 8 or int((instant(row["validAt"]) - instant(row["runInitializedAt"])).total_seconds() // 3600) != lead or any(not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value) for value in hashes) or (persistence is not None and (not isinstance(persistence, (int, float)) or isinstance(persistence, bool) or not math.isfinite(persistence) or persistence < 0)):
        raise ValueError("rain future-only row provenance differs")


# execute the actual current four-head fitter and a finite earlier-only grid
def fit_monthly_rain(payload, output_root):
    wind = importlib.import_module("rain_wind")
    names = importlib.import_module("rain_wind_features").FEATURE_NAMES
    np = importlib.import_module("numpy")
    version = payload.get("contractVersion")
    v3 = version == "rain-maintenance-fit-input/v3"
    expected_fields = {"contractVersion", "month", "featureNames", "trainingRows", "developmentRows"}
    # admit only the additive annual proof on the future-only v3 path
    if v3:
        expected_fields.add("developmentPopulation")
    # prevent caller-defined families, grids and predictor order on either disjoint version
    if set(payload) != expected_fields or version not in ("rain-maintenance-fit-input/v2", "rain-maintenance-fit-input/v3") or payload["featureNames"] != list(names):
        raise ValueError("invalid rain fit-only input")
    training, development = payload["trainingRows"], payload["developmentRows"]
    # reject unbounded population sizes before allocating native matrices
    if not isinstance(training, list) or not isinstance(development, list) or len(training) + len(development) > MAX_ROWS:
        raise ValueError("rain fit row ceiling exceeded")
    validate_rows(training, payload["month"])
    validate_rows(development, payload["month"])
    # bind the full annual source proof before reading any development labels
    if v3:
        validate_development_population(payload["developmentPopulation"], development)
        # verify every joined training and development identity before model allocation
        for row in (*training, *development):
            validate_v3_row(row)
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
    policy = {**POLICY, "contractVersion": "rain-maintenance-fit/v3",
              "developmentPopulationSha256": payload["developmentPopulation"]["populationSha256"],
              "developmentRows": len(development)} if v3 else POLICY
    report = {**policy, "dueMonth": payload["month"], "state": "no_candidate", "selectedId": None,
              "fitState": final_state, "reason": "insufficient_development", "gridReports": {}, "artifact": None}
    # all four final heads must be real supported fits, not control replay
    if not final_state["supported"] or final_state["model"] is None or any(value["reason"] != "fitted" for value in final_state["model"]["heads"].values()):
        report["reason"] = "insufficient_native_fit_support"
        return report
    # a partial population cannot replace either disjoint development contract
    if (not v3 and (len(development) != 32896 or any("evaluationRow" not in row or "gaugeCount" not in row for row in development))) or (v3 and (not development or any("gaugeCount" not in row for row in development))):
        return report
    by_key = {row["key"]: index for index, row in enumerate(rows)}
    projected = {name: (np.full(len(development), np.nan), np.full((len(development), 3), np.nan)) for name in GRID}
    month_labels = [(instant(row["runInitializedAt"]) + dt.timedelta(hours=8)).strftime("%Y-%m") for row in development]
    # fit historical development months without opening any future confirmation
    for month in sorted(set(month_labels)):
        mask = maintenance_month_masks(data, month)
        control = data["raw"][mask[2]].copy()
        indices, _, state = wind.fit_month(output_root, data, x, month, control, masks=mask)
        scales = historical_control_scales(data, month) if v3 else None
        # unsupported historical months cannot be omitted from the population
        if not state["supported"] or any(value["reason"] != "fitted" for value in state["model"]["heads"].values()) or (v3 and scales is None):
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
                # reconstruct original earlier-cutoff controls without a prior publication dependency
                if v3:
                    row["evaluationRow"] = historical_evaluation_row(row, float(grid[GRID[0]][0][local_index]),
                                                                      grid[GRID[0]][1][local_index], scales)
                # keep every arm on exactly the same row
                for name in GRID:
                    projected[name][0][position] = grid[name][0][local_index]
                    projected[name][1][position] = grid[name][1][local_index]
    # any row gap rejects the whole grid rather than manufacturing raw success
    if any(not np.isfinite(value).all() for pair in projected.values() for value in pair):
        report["reason"] = "development_alignment_gap"
        return report
    reports = screen_grid(development, projected,
                          payload["developmentPopulation"] if v3 else None)
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


# normalize signed zero only in the public json numerical representation
def canonical_control_numbers(value):
    # json has one zero representation and both signs compare identically in tree traversal
    if isinstance(value, float) and value == 0:
        return 0
    # preserve ordered numerical tree arrays
    if isinstance(value, list):
        return [canonical_control_numbers(item) for item in value]
    # preserve closed artifact fields without adding metadata
    if isinstance(value, dict):
        return {key: canonical_control_numbers(item) for key, item in value.items()}
    return value


# fit a pre-month reference without development selection or confirmation access
def fit_rain_control_reference(payload, output_root, clock=None):
    np = importlib.import_module("numpy")
    context = importlib.import_module("rain_context")
    names = importlib.import_module("rain_wind_features").FEATURE_NAMES
    ordinal = importlib.import_module("rain_ordinal")
    search = importlib.import_module("rain_search")
    residual = importlib.import_module("rain_residual")
    recent = importlib.import_module("rain_recency_calibration")
    legacy = importlib.import_module("run_rain_sub24")
    # keep this reference input disjoint from candidate fitting
    if set(payload) != {"contractVersion", "featureNames", "month", "requestedAt", "trainingRows"} or payload["contractVersion"] != "rain-control-reference-fit-input/v1" or payload["featureNames"] != list(names):
        raise ValueError("invalid rain control reference input")
    month_start = dt.datetime.strptime(payload["month"], "%Y-%m").replace(tzinfo=dt.timezone.utc)
    requested = instant(payload["requestedAt"])
    cutoff = month_start - dt.timedelta(days=7)
    # prohibit early reference publication and month-boundary backdating
    if month_start.strftime("%Y-%m") != payload["month"] or not cutoff <= requested < month_start:
        raise ValueError("rain control reference request chronology differs")
    rows = payload["trainingRows"]
    # cap the original earlier-only population before numerical allocation
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise ValueError("rain control reference row ceiling exceeded")
    validate_rows(rows, payload["month"])
    rows = sorted(rows, key=lambda row: (row["validAt"], row["key"]))
    data, x = native_arrays(rows)
    fit, calibration, _, bounds = maintenance_month_masks(data, payload["month"])
    legacy_fit, legacy_calibration, _, legacy_bounds = legacy.month_masks(data, payload["month"])
    counts = {"training": residual.support(data["actual"][fit], data["hour"][fit]),
              "calibration": residual.support(data["actual"][calibration], data["hour"][calibration])}
    legacy_counts = {"trainingRows": int(legacy_fit.sum()), "trainingWetRows": int((data["actual"][legacy_fit] >= .1).sum()),
                     "calibrationRows": int(legacy_calibration.sum())}
    common_supported = residual.supported(counts["training"], search.POLICY["trainingSupport"]) and residual.supported(counts["calibration"], search.POLICY["calibrationSupport"]) and legacy_counts["trainingRows"] >= 1000 and legacy_counts["trainingWetRows"] >= 100 and legacy_counts["calibrationRows"] >= 200
    now = clock or (lambda: dt.datetime.now(dt.timezone.utc))
    stamp = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    report = {"calibrationEndAt": stamp(cutoff), "calibrationStartAt": stamp(cutoff - dt.timedelta(days=90)),
              "contractVersion": "rain-control-reference-fit/v1", "generatedAt": None,
              "legacyCalibrationStartAt": stamp(cutoff - dt.timedelta(days=45)), "modelMonth": payload["month"],
              "ordinalArtifact": None, "parityRows": [], "reason": "insufficient_control_support",
              "scales": None, "state": "unsupported", "support": None, "trainingMaximumValidAt": None}
    # never fit or fill a control when its full original support is unavailable
    if common_supported:
        directory = Path(output_root) / "control-heads"
        models, state = context.fit_ordinal(x[fit], data["actual"][fit], data["hour"][fit], directory, list(names))
        # all four actual fitted heads are required by the portable runtime
        if any(head["reason"] != "fitted" for head in state["heads"].values()):
            report["reason"] = "insufficient_ordinal_head_support"
        else:
            actual, hours, raw = data["actual"][calibration], data["hour"][calibration], data["raw"][calibration]
            probabilities, amount = context.predict_ordinal(models, x[calibration], list(names))
            proposed = ordinal.calibrate_events(actual, raw, probabilities, hours)
            rules, _ = search.checked_rules(actual, raw, probabilities, hours, proposed)
            categories = ordinal.event_categories(raw, probabilities, rules)
            blended = search.blended(raw, amount)
            scalar = search.calibrate(actual, hours, lambda scale: ordinal.project_amount(blended, categories, scale))
            same_window = search.calibrate(actual, hours, lambda scale: np.clip(raw * scale, 0, 30))["scale"]
            mass = recent.recent_weights(hours, bounds["calibrationMaximumValidHourExclusive"])
            effective = recent.effective_support(actual, hours, mass)
            recent_supported = effective["effectiveDates"] >= 30 and effective["effectiveWetDates"] >= 3
            recent_scale = recent.calibrate(actual, hours, lambda scale: np.clip(raw * scale, 0, 30), mass)["scale"] if recent_supported else same_window
            legacy_scale = legacy.volume_scale(data["actual"][legacy_calibration], data["raw"][legacy_calibration], data["hour"][legacy_calibration])
            compact = importlib.import_module("export_rain_wind_runtime").compact_head
            heads = {}
            # publish only numerical operations from newly fitted native models
            for name, head in state["heads"].items():
                heads[name] = compact((directory / head["modelFile"]).read_bytes(), name, list(names))
            artifact = canonical_control_numbers({"categoryScales": [scalar["scale"]] * 3, "contractVersion": "rain-hurdle-wind-runtime/v1",
                        "featureNames": list(names), "heads": heads, "modelMonth": payload["month"],
                        "rules": [{"threshold": rule["threshold"], "cutoff": rule["cutoff"]} for rule in rules]})
            support = {"calibrationDates": counts["calibration"]["dates"], "calibrationHours": counts["calibration"]["hours"],
                       "calibrationRows": counts["calibration"]["rows"], "calibrationWetDates": counts["calibration"]["wetDates"],
                       "calibrationWetHours": counts["calibration"]["wetHours"], "effectiveDates": effective["effectiveDates"],
                       "effectiveWetDates": effective["effectiveWetDates"], "legacyCalibrationRows": legacy_counts["calibrationRows"],
                       "legacyTrainingRows": legacy_counts["trainingRows"], "legacyTrainingWetRows": legacy_counts["trainingWetRows"],
                       "trainingDates": counts["training"]["dates"], "trainingHours": counts["training"]["hours"],
                       "trainingRows": counts["training"]["rows"], "trainingWetDates": counts["training"]["wetDates"],
                       "trainingWetHours": counts["training"]["wetHours"]}
            synthetic = np.asarray([[0.] * len(names), [1.] * len(names), [np.nan] * len(names)], dtype=np.float32)
            raw_parity = np.asarray([.5, 2., 4.], dtype=np.float64)
            synthetic[:, 5] = raw_parity
            pc, ac = context.predict_ordinal(models, synthetic, list(names))
            predicted = ordinal.project_amount(search.blended(raw_parity, ac), ordinal.event_categories(raw_parity, pc, rules), scalar["scale"])
            parity = [{"features": [None if not math.isfinite(float(value)) else float(value) for value in synthetic[index]],
                       "raw": float(raw_parity[index]), "prediction": float(predicted[index]),
                       "probabilities": list(map(float, pc[index]))} for index in range(len(synthetic))]
            report.update({"ordinalArtifact": artifact, "parityRows": parity, "reason": "pre_month_reference",
                           "scales": {"legacy": legacy_scale, "recent": recent_scale,
                                      "recentSupported": bool(recent_supported), "sameWindow": same_window},
                           "state": "supported", "support": support,
                           "trainingMaximumValidAt": stamp(dt.datetime.fromtimestamp(int(data["hour"][fit].max()) * 3600, dt.timezone.utc))})
    generated = now()
    # record true completion time and refuse crossing the month boundary
    if generated.tzinfo != dt.timezone.utc or not requested <= generated < month_start:
        raise ValueError("rain control reference completion chronology differs")
    report["generatedAt"] = stamp(generated)
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
        payload = json.loads(path.read_bytes())
        # dispatch only the disjoint pre-month contract through the same sandbox
        if payload.get("contractVersion") == "rain-control-reference-fit-input/v1":
            result = fit_rain_control_reference(payload, Path(temporary))
        else:
            result = fit_monthly_rain(payload, Path(temporary))
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
