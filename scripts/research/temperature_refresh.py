"""Bounded, review-only refresh of the existing delayed temperature MOS."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
ZONE = ZoneInfo("America/Los_Angeles")
ARMS = ("frozen_incumbent", "month_start_expanding", "month_start_trailing365")
SCOPE = "assumed_delay6_next12"
POLICY = {
    "contractVersion": "temperature-refresh-preregistration/v1",
    "arms": list(ARMS),
    "scope": SCOPE,
    "operationalDelayHours": 6,
    "sourceDelayHours": 7,
    "minimumModelLeadHours": 7,
    "maximumModelLeadHours": 18,
    "embargoHours": 168,
    "minimumTrainingDates": 60,
    "minimumTrainingRows": 1000,
    "strengthPolicy": "frozen_incumbent_learned_strength",
    "maximumCorrectionC": 3,
    "physicalMinimumC": -100,
    "physicalMaximumC": 70,
    "automaticActivationEligible": False,
    "operatorApprovalRequired": True,
    "servingChanged": False,
}
MAX_ROWS = 250_000
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_RESULT_BYTES = 64 * 1024 * 1024
INCUMBENT_PATH = ROOT / "config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json"

# use the serving runtime and shared scorer rather than python inference
BRIDGE = r"""
import { readFileSync } from 'node:fs';
import { applyEcmwfTemperatureMosRuntime, TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY }
  from './packages/forecast-adjustment/dist/temperature-mos-runtime.js';
const input = JSON.parse(readFileSync(0, 'utf8'));
let output;
// reuse only pure compiled inference
if (input.operation === 'infer') {
  output = input.inputs.map(value => applyEcmwfTemperatureMosRuntime(value));
} else if (input.operation === 'policy') {
  output = TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY;
} else if (input.operation === 'load') {
  const { loadTemperaturePerformanceData } = await import('./apps/worker/dist/forecast-adjustment-performance-cli.js');
  output = await loadTemperaturePerformanceData(input.options);
} else if (input.operation === 'score') {
  const { prepareForecastAdjustmentPerformancePairs, evaluateForecastAdjustmentPerformance,
    scoreBalancedForecastAdjustmentPairs }
    = await import('./packages/forecast-adjustment/dist/performance-scorecard.js');
  const { localCalendarFeaturesFor } = await import('./packages/forecast-adjustment/dist/calendar.js');
  const prepared = prepareForecastAdjustmentPerformancePairs(input.pairs);
  const classes = new Set(input.pairs.map(value => value.evidenceClass));
  // never hide mixed evidence behind an empty target population
  if (classes.size !== 1) throw new Error('temperature evidence classes differ');
  // missing targets remain explicit support failure rather than empty success
  const evaluation = prepared.rows.length === 0 ? {
    bootstrap: null, comparisonState: 'unscored', dateCount: 0, eventCount: 0,
    evidenceClass: input.pairs[0].evidenceClass, metrics: null,
    qualificationState: input.pairs[0].evidenceClass === 'development' ? 'development_only' : 'pending_support',
    servingState: 'authorized_active', supportState: 'insufficient', weightedRows: []
  } : evaluateForecastAdjustmentPerformance(prepared.rows, {
    minimumDates: 60, minimumRows: 1000, servingState: 'authorized_active'
  });
  const groups = new Map();
  // retain local-calendar slices under the identical paired population
  for (const pair of prepared.rows) {
    const calendar = localCalendarFeaturesFor(pair.validAt);
    const labels = { horizon: `hours_${pair.horizonHours <= 6 ? '1_6' : '7_12'}`,
      month: `month_${String(calendar.month).padStart(2, '0')}`,
      season: calendar.season, daypart: calendar.daypart };
    // keep every declared dimension separate
    for (const [dimension, label] of Object.entries(labels)) {
      const identity = `${dimension}/${label}`;
      const group = groups.get(identity) ?? { dimension, label, pairs: [] };
      group.pairs.push(pair);
      groups.set(identity, group);
    }
  }
  const slices = [...groups.values()].map(group => ({ dimension: group.dimension,
    label: group.label, rowCount: group.pairs.length,
    metrics: new Set(group.pairs.map(pair => pair.localDate)).size >= 60 && group.pairs.length >= 1000
      ? scoreBalancedForecastAdjustmentPairs(group.pairs).metrics : null }));
  const baselineByKey = new Map(input.bestMatch.map(value => [value.key, value.prediction]));
  const matched = prepared.rows.filter(pair => baselineByKey.has(pair.key));
  let bestMatchDiagnostic = null;
  // never impute a missing recorded best-match comparator
  if (matched.length > 0) {
    const source = scoreBalancedForecastAdjustmentPairs(matched).metrics;
    const bestMatch = scoreBalancedForecastAdjustmentPairs(matched.map(pair => ({ ...pair,
      rawPrediction: baselineByKey.get(pair.key) }))).metrics;
    bestMatchDiagnostic = { rowCount: matched.length,
      dateCount: new Set(matched.map(pair => pair.localDate)).size,
      bestMatchRawMae: bestMatch.raw.mae, sourceRawMae: source.raw.mae,
      sourceAdjustedMae: source.adjusted.mae, unit: 'celsius' };
  }
  output = { prepared, evaluation, slices, bestMatchDiagnostic };
} else {
  throw new Error('unknown temperature research operation');
}
process.stdout.write(JSON.stringify(output));
"""


# canonicalize private evidence without permitting nonfinite values
def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


# bind exact bytes to a reproducible evidence identity
def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


# accept only exact millisecond utc instants
def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    # reject normalized offsets and malformed calendar instants
    if parsed.tzinfo != dt.timezone.utc or format_instant(parsed) != value:
        raise ValueError("expected canonical utc instant")
    return parsed


# preserve the runtime timestamp representation
def format_instant(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# require a canonical local date before deriving dst-aware boundaries
def calendar_date(value):
    parsed = dt.date.fromisoformat(value)
    # reject normalized date spelling
    if parsed.isoformat() != value:
        raise ValueError("expected canonical local date")
    return parsed


# freeze the complete candidate policy before target access
def registration(from_date, to_date, purpose, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    first = calendar_date(from_date)
    last = calendar_date(to_date)
    # bound every confirmation interval
    if last < first or (last - first).days > 449:
        raise ValueError("registration range must contain 1 to 450 dates")
    # prohibit retrospective evidence from claiming untouched confirmation
    if purpose not in ("retrospective_development", "fresh_confirmation"):
        raise ValueError("invalid evidence purpose")
    start = dt.datetime.combine(first, dt.time(), ZONE)
    # future target hours do not yet contain observed target bytes
    if purpose == "fresh_confirmation" and start <= now:
        raise ValueError("fresh confirmation must be registered before its target interval")
    return {**POLICY, "arms": list(ARMS), "registeredAt": format_instant(now), "fromLocalDate": from_date,
            "toLocalDate": to_date, "purpose": purpose,
            "futureTargetBytesUnavailableAtRegistration": purpose == "fresh_confirmation"}


# verify the fixed policy instead of accepting user-shaped serving authority
def validate_registration(value):
    expected = registration(value["fromLocalDate"], value["toLocalDate"], value["purpose"],
                            instant(value["registeredAt"]))
    # require exact bytes apart from canonical key ordering
    if value != expected:
        raise ValueError("preregistration differs from frozen temperature policy")
    return value


# select earlier-only training labels with their actual receipt boundary
def eligible_training_rows(rows, month, arm):
    # permit only the two fixed refresh arms
    if arm not in ARMS[1:]:
        raise ValueError("invalid temperature refit arm")
    month_start = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=ZONE)
    cutoff = month_start - dt.timedelta(hours=POLICY["embargoHours"])
    earliest = month_start.date() - dt.timedelta(days=365)
    selected = []
    exclusions = collections.Counter()
    seen = set()
    # validate all identities before fitting any labels
    for row in rows:
        key = row["key"]
        # reject duplicated training events instead of overweighting them
        if key in seen:
            raise ValueError("duplicate temperature training key")
        seen.add(key)
        valid_at = instant(row["validAt"])
        receipt = row.get("targetMaxReceiptAt")
        # unknown actual receipt cannot become causal training availability
        if receipt is None:
            exclusions["missing_target_receipt"] += 1
            continue
        # require target and forecast availability before the embargo boundary
        if instant(receipt) >= cutoff or valid_at + dt.timedelta(hours=7) > cutoff:
            exclusions["target_after_cutoff"] += 1
            continue
        # keep the trailing window in local calendar days across dst
        if arm == ARMS[2] and valid_at.astimezone(ZONE).date() < earliest:
            exclusions["outside_trailing_window"] += 1
            continue
        # preserve missing targets instead of inventing labels
        if row.get("actualTemperatureC") is None:
            exclusions["missing_target"] += 1
            continue
        selected.append(row)
    return selected, format_instant(cutoff), dict(exclusions)


# fit only existing numerical helpers in the established research interpreter
def fit_candidate(rows, month, arm, incumbent):
    selected, cutoff, exclusions = eligible_training_rows(rows, month, arm)
    short = importlib.import_module("temperature_shortlead_models")
    fitted = short.fit(selected, month, "ecmwf_single_run_hindcast", SCOPE)
    strength = {key: {"alpha": value["alpha"], "supported": value["supported"],
                      "trainingCutoffUtc": cutoff}
                for key, value in incumbent["strengthBands"].items()}
    # hold the previously learned strength fixed without recalibrating on score data
    model = {key: fitted[key] for key in ("contractVersion", "month", "cohort", "scope",
                                        "supported", "directCoefficients", "adaptiveCoefficients",
                                        "trainingCutoffUtc")}
    model.update({"learnedStrengthContractVersion": incumbent["learnedStrengthContractVersion"],
                  "strengthBands": strength})
    receipt = {"arm": arm, "month": month, "modelSha256": digest(model),
               "trainingRows": fitted["trainingRows"], "trainingDates": fitted["trainingDates"],
               "trainingCutoffUtc": cutoff, "latestTrainingValidAt": fitted["lastTrainingValidAt"],
               "trainingKeySha256": digest(fitted["trainingKeys"]), "exclusions": exclusions,
               "strengthPolicy": POLICY["strengthPolicy"],
               "originalStrengthBandReceipts": incumbent["strengthBands"],
               "strengthRefitted": False, "servingChanged": False}
    return model, receipt


# execute bounded native batches without placing private rows in argv
def native(operation, **values):
    data = canonical({"operation": operation, **values})
    # cap stdin memory before invoking a pure local runtime
    if len(data) > 64 * 1024 * 1024:
        raise ValueError("native temperature batch exceeds bound")
    result = subprocess.run(["node", "--input-type=module", "-e", BRIDGE], input=data,
                            capture_output=True, cwd=ROOT, check=False)
    # avoid leaking private input or filesystem paths in error messages
    if result.returncode != 0:
        raise RuntimeError("native temperature operation failed; compile the workspace before research")
    # refuse an unexpectedly large native response before decoding it
    if len(result.stdout) > MAX_INPUT_BYTES:
        raise ValueError("native temperature response exceeds bound")
    return json.loads(result.stdout)


# bound a private prepared-row input before parsing it
def read_prepared_rows(path):
    path = Path(path)
    # reject links and oversized retained inputs
    if path.is_symlink() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("invalid retained temperature input")
    rows = []
    # keep parsing bounded by line size and row count
    with path.open() as stream:
        for line in stream:
            # reject an oversized row before json decoding
            if len(line.encode()) > 32 * 1024 or len(rows) >= MAX_ROWS:
                raise ValueError("retained temperature rows exceed bound")
            rows.append(json.loads(line))
    return rows


# constrain all candidate and burn writes to private ignored research storage
def private_output(path):
    supplied = Path(path).absolute()
    allowed = [ROOT / ".weather-data", Path.home() / ".weather/research-work"]
    # reject traversal and symlinks before creating an output
    if ".." in supplied.parts or supplied.exists() or supplied.is_symlink():
        raise ValueError("temperature output must be a new private directory")
    base = next((base for base in allowed if supplied.is_relative_to(base)), None)
    # prevent writable paths near settings or model registries
    if base is None or base.is_symlink() or base.resolve() != base:
        raise ValueError("temperature output is outside private research storage")
    base.mkdir(mode=0o700, exist_ok=True)
    parent = base
    # create private descendants without changing unrelated existing modes
    for component in supplied.relative_to(base).parts:
        parent = parent / component
        # reject linked descendants before creating a directory
        if parent.is_symlink():
            raise ValueError("temperature output contains a symbolic link")
        parent.mkdir(mode=0o700, exist_ok=True)
        metadata = parent.stat()
        # reject shared or unowned evidence ancestors
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("temperature output requires private owned ancestry")
    validate_private_write(supplied / "report.json")
    return supplied


# prevent report or burn publication outside owned private evidence
def validate_private_write(path):
    supplied = Path(path).absolute()
    allowed = [ROOT / ".weather-data", Path.home() / ".weather/research-work"]
    base = next((base for base in allowed if supplied.is_relative_to(base)), None)
    # deny all repository and serving paths outside ignored private storage
    if base is None or ".." in supplied.parts or base.is_symlink() or base.resolve() != base:
        raise ValueError("temperature write is outside private research storage")
    parent = supplied.parent
    # require private owned ancestors within the evidence root
    while parent.is_relative_to(base):
        metadata = parent.stat()
        # reject symlinks and shared writable/readable evidence ancestry
        if parent.is_symlink() or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise ValueError("temperature write requires private owned ancestry")
        # stop at the established ignored root
        if parent == base:
            break
        parent = parent.parent
    return supplied


# create immutable report and burn bytes with owner-only access
def write_private(path, value):
    path = validate_private_write(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    # sync exact bytes before reporting durable evidence
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(canonical(value) + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    # make the exclusive burn or report name durable before target access
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


# reserve the complete private run allocation before each immutable result
def write_result(output, name, value):
    content_bytes = len(canonical(value)) + 1
    allocated = sum(path.stat().st_blocks * 512 for path in output.iterdir())
    # account for filesystem blocks rather than only json payload lengths
    if allocated + ((content_bytes + 4095) // 4096) * 4096 > MAX_RESULT_BYTES:
        raise ValueError("temperature experiment exceeds 64 MiB result allocation")
    write_private(output / name, value)


# burn an untouched interval before opening its target package
def burn_confirmation(preregistration_path, value):
    # old evidence remains development without a freshness claim
    if value["purpose"] != "fresh_confirmation":
        return None
    burn = Path(str(preregistration_path) + ".burn.json")
    receipt = {"contractVersion": "temperature-confirmation-burn/v1",
               "preregistrationSha256": digest(value),
               "burnedAt": format_instant(dt.datetime.now(dt.timezone.utc)),
               "fromLocalDate": value["fromLocalDate"], "toLocalDate": value["toLocalDate"]}
    write_private(burn, receipt)
    return receipt


# report native scoring aggregates in the shared closed family shape
def family_card(rows, results, inputs):
    pairs = []
    # retain raw and adjusted on identical target rows
    for row, result in zip(rows, results, strict=True):
        valid_at = instant(row["validAt"])
        pairs.append({"key": row["key"], "rowIdentity": row.get("rowIdentity", row["key"]),
                      "targetKey": row.get("targetKey", row.get("targetIdentity") or row["validAt"]),
                      "vintageKey": row.get("vintageKey", row["runInitializedAt"]),
                      "validAt": row["validAt"], "localDate": valid_at.astimezone(ZONE).date().isoformat(),
                      "horizonHours": row["modelLeadHours"] - 6,
                      "evidenceClass": row.get("evidenceClass", "development"),
                      "rawPrediction": row["rawTemperatureC"],
                      "adjustedPrediction": result["predictionTemperatureC"],
                      "target": row.get("actualTemperatureC"), "fallback": not result["applied"],
                      "provenanceComplete": row.get("provenanceComplete", False),
                      "sourceReceiptAt": row.get("sourceReceiptAt"),
                      "firstEdgeCommittedAt": row.get("firstEdgeCommittedAt")})
    # retain explicit support failure when no eligible target exists yet
    if not pairs:
        metrics = {key: None for key in ("rawMae", "adjustedMae", "deltaMae", "rawBias", "adjustedBias",
                                         "rawRmse", "adjustedRmse", "rawP95", "adjustedP95", "skillPercent",
                                         "skillInterval95")}
        metrics["unit"] = "celsius"
        support = {key: 0 for key in ("dateCount", "validHourCount", "vintageCount", "targetRowCount",
                                     "rowCount", "eventCount", "wetDateCount", "wetRowCount",
                                     "effectiveWeightSum", "fallbackCount", "gapCount", "excludedCount")}
        support.update({"exclusionReasons": {}, "fallbackReasons": {}})
        return {"family": "temperature", "servingIdentitySha256": INCUMBENT_PATH.stem.removeprefix("sha256-"),
                "evidenceClass": "prospective_receipt", "evidenceCutoffAt": inputs["targetCutoffAt"],
                "supportState": "insufficient", "comparisonState": "unscored",
                "qualificationState": "pending_support", "servingState": "authorized_active",
                "recommendation": "retain", "support": support, "metrics": metrics,
                "slices": [], "rainDiagnostics": None, "bestMatchDiagnostic": None}
    best_match = [{"key": row["key"], "prediction": row["bestMatchRawTemperatureC"]}
                  for row in rows if row.get("bestMatchRawTemperatureC") is not None]
    scored = native("score", pairs=pairs, bestMatch=best_match)
    evaluation = scored["evaluation"]
    prepared = scored["prepared"]
    metrics = {key: None for key in ("rawMae", "adjustedMae", "deltaMae", "rawBias", "adjustedBias",
                                     "rawRmse", "adjustedRmse", "rawP95", "adjustedP95", "skillPercent",
                                     "skillInterval95")}
    metrics["unit"] = "celsius"
    values = evaluation["metrics"]
    # populate common metrics only when the shared support contract permits them
    if values is not None:
        metrics.update({"rawMae": values["raw"]["mae"], "adjustedMae": values["adjusted"]["mae"],
                        "deltaMae": values["delta"]["mae"], "rawBias": values["raw"]["bias"],
                        "adjustedBias": values["adjusted"]["bias"], "rawRmse": values["raw"]["rmse"],
                        "adjustedRmse": values["adjusted"]["rmse"], "rawP95": values["raw"]["p95AbsoluteError"],
                        "adjustedP95": values["adjusted"]["p95AbsoluteError"], "skillPercent": values["skill"] * 100})
    interval = evaluation["bootstrap"]
    # keep block support gaps explicit rather than inventing zero-width intervals
    if interval is not None:
        metrics["skillInterval95"] = {"lower": interval["lowerSkill"] * 100,
                                      "upper": interval["upperSkill"] * 100}
    eligible = prepared["rows"]
    reasons = dict(collections.Counter(result["reason"] for result in results if not result["applied"]))
    excluded = sum(prepared["exclusions"].values())
    support = {"dateCount": evaluation["dateCount"], "eventCount": evaluation["eventCount"],
               "rowCount": len(rows), "validHourCount": len({row["validAt"] for row in eligible}),
               "vintageCount": len({row["vintageKey"] for row in eligible}),
               "targetRowCount": len({row["targetKey"] for row in eligible}),
               "effectiveWeightSum": sum(row["weight"] for row in evaluation["weightedRows"]),
               "wetDateCount": 0, "wetRowCount": 0, "excludedCount": excluded,
               "fallbackCount": prepared["fallbackCount"],
               "gapCount": excluded + prepared["diagnostics"]["provenance_incomplete"],
               "exclusionReasons": prepared["exclusions"], "fallbackReasons": reasons}
    return {"family": "temperature", "servingIdentitySha256": INCUMBENT_PATH.stem.removeprefix("sha256-"),
            "evidenceClass": evaluation["evidenceClass"], "evidenceCutoffAt": inputs["targetCutoffAt"],
            "supportState": evaluation["supportState"], "comparisonState": evaluation["comparisonState"],
            "qualificationState": "pending_support" if evaluation["evidenceClass"] in ("as_issued", "prospective_receipt") else evaluation["qualificationState"],
            "servingState": "authorized_active", "recommendation": "retain",
            "support": support, "metrics": metrics,
            "slices": [{"dimension": value["dimension"], "label": value["label"],
                        "rowCount": value["rowCount"],
                        "metrics": slice_metrics(value["metrics"])} for value in scored["slices"]],
            "rainDiagnostics": None, "bestMatchDiagnostic": scored["bestMatchDiagnostic"]}


# render support-gated slice values without manufacturing confidence intervals
def slice_metrics(values):
    metric = {key: None for key in ("rawMae", "adjustedMae", "deltaMae", "rawBias", "adjustedBias",
                                   "rawRmse", "adjustedRmse", "rawP95", "adjustedP95", "skillPercent",
                                   "skillInterval95")}
    metric["unit"] = "celsius"
    # preserve explicit slice support failure
    if values is not None:
        metric.update({"rawMae": values["raw"]["mae"], "adjustedMae": values["adjusted"]["mae"],
                       "deltaMae": values["delta"]["mae"], "rawBias": values["raw"]["bias"],
                       "adjustedBias": values["adjusted"]["bias"], "rawRmse": values["raw"]["rmse"],
                       "adjustedRmse": values["adjusted"]["rmse"], "rawP95": values["raw"]["p95AbsoluteError"],
                       "adjustedP95": values["adjusted"]["p95AbsoluteError"], "skillPercent": values["skill"] * 100})
    return metric


# adapt the verified package loader without inventing state or receipt fields
def normalized_package_rows(rows):
    return [{**row, **row["scoredPairMetadata"], "state": row["recentErrorState"]} for row in rows]


# keep actually issued incumbent values separate from source-run reconstructions
def incumbent_population(rows, results):
    pairs = []
    identity = INCUMBENT_PATH.stem.removeprefix("sha256-")
    # use recorded applied values only for the exact reviewed serving artifact
    for row, result in zip(rows, results, strict=True):
        recorded = row.get("recordedRuntimeResult")
        # public best-match fallbacks are not an issued ecmwf adjustment
        if recorded is not None and recorded["applied"] and recorded["servingBundleSha256"] == identity:
            row = {**row, **recorded["scoredPairMetadata"]}
            result = {"applied": True, "predictionTemperatureC": recorded["predictionTemperatureC"],
                      "reason": recorded["reasonCode"]}
        pairs.append((row, result))
    classes = {row["evidenceClass"] for row, _ in pairs}
    selected = next((value for value in ("as_issued", "prospective_receipt", "retrospective_counterfactual", "development")
                     if value in classes), None)
    population = [(row, result) for row, result in pairs if row["evidenceClass"] == selected]
    return [row for row, _ in population], [result for _, result in population], len(pairs) - len(population)


# retain every replay class on its own ecmwf source baseline
def source_reconstruction_reports(rows, results, inputs):
    groups = collections.defaultdict(list)
    # use native replay values without substituting actually served decisions
    for row, result in zip(rows, results, strict=True):
        groups[row["evidenceClass"]].append((row, result))
    return [{"evidenceClass": evidence_class, "baseline": "ecmwf_source_run",
             "qualificationEligible": False,
             "family": family_card([row for row, _ in population],
                                   [result for _, result in population], inputs)}
            for evidence_class, population in sorted(groups.items())]


# expose omitted public fallbacks without mixing best-match and ecmwf errors
def include_actual_serving_fallbacks(card, fallbacks, fallback_reasons):
    # retain a coherent primary population even when no fallback was captured
    if not fallbacks:
        return
    support = card["support"]
    support["exclusionReasons"]["actual_serving_best_match_fallback"] = len(fallbacks)
    support["excludedCount"] += len(fallbacks)
    support["gapCount"] += len(fallbacks)
    support["rowCount"] += len(fallbacks)
    support["fallbackCount"] += len(fallbacks)
    support["fallbackReasons"] = dict(collections.Counter(support["fallbackReasons"]) +
                                      collections.Counter(fallback_reasons))
    card["qualificationState"] = "pending_support"
    card["recommendation"] = "retain"


# reuse exact native inference for every branch, cap and fallback
def infer_rows(rows, models):
    results = []
    # bound each runtime batch independently of research-population size
    for start in range(0, len(rows), 256):
        inputs = []
        # pass only the runtime's declared forecast and state fields
        for row in rows[start:start + 256]:
            forecast = {key: row[key] for key in ("cohort", "key", "modelCycle", "modelLeadHours",
                                                  "rawRelativeHumidityPercent", "rawTemperatureC",
                                                  "rawWindSpeedMps", "runInitializedAt", "validAt")}
            month = instant(row["validAt"]).astimezone(ZONE).strftime("%Y-%m")
            inputs.append({"forecast": forecast, "recentErrorState": row["state"],
                           "model": models.get(month, models.get("frozen"))})
        results.extend(native("infer", inputs=inputs))
    return results


# fit both fixed arms and select only on causal already-opened development
def fit_monthly_temperature(payload):
    required = {"contractVersion", "month", "trainingRows", "developmentRows", "incumbentModel"}
    # reject a confirmation package or caller-defined search policy
    if set(payload) != required or payload["contractVersion"] != "temperature-maintenance-fit-input/v2":
        raise ValueError("invalid temperature fit-only input")
    month = payload["month"]
    start = dt.datetime.strptime(month, "%Y-%m").replace(tzinfo=ZONE)
    # reject normalized month spellings
    if start.strftime("%Y-%m") != month:
        raise ValueError("invalid original due month")
    cutoff = start - dt.timedelta(hours=168)
    training, development = payload["trainingRows"], payload["developmentRows"]
    # bound input populations independently of native allocations
    if not isinstance(training, list) or not isinstance(development, list) or len(training) + len(development) > MAX_ROWS:
        raise ValueError("temperature fit row ceiling exceeded")
    seen = set()
    # distinguish repeated score keys from duplicated events within either population
    for phase, rows in (("training", training), ("development", development)):
        # require actual immutable availability rather than claimed hindsight
        for row in rows:
            identity = (row["key"], phase)
            # duplicates and missing source or target receipts remain invalid
            if identity in seen or row.get("sourceReceiptAt") is None or row.get("targetMaxReceiptAt") is None:
                raise ValueError("temperature fit input has missing or duplicate provenance")
            seen.add(identity)
            # keep the original due cutoff even during catch-up
            if instant(row["sourceReceiptAt"]) >= cutoff or instant(row["targetMaxReceiptAt"]) >= cutoff or instant(row["validAt"]) >= cutoff:
                raise ValueError("temperature fit input is not earlier than the original cutoff")
            # a reserved member cannot become development through a fitter
            if row.get("evidenceClass") != "development" or row.get("actualTemperatureC") is None:
                raise ValueError("temperature fit-only input must be opened development")
    incumbent = payload["incumbentModel"]
    arms = {}
    final_models = {}
    short = importlib.import_module("temperature_shortlead_models")
    incumbent_results = infer_rows(development, {"frozen": incumbent})
    dates = {instant(row["validAt"]).astimezone(ZONE).date().isoformat() for row in development}
    supported = len(development) >= 1000 and len(dates) >= 60
    weight = short.event_weights(development)
    # normalize the retained equal-date mass before comparing losses
    if len(development):
        weight = weight / weight.sum()
    raw_mae = sum(float(w) * abs(row["rawTemperatureC"] - row["actualTemperatureC"]) for w, row in zip(weight, development, strict=True))
    incumbent_mae = sum(float(w) * abs(result["predictionTemperatureC"] - row["actualTemperatureC"]) for w, row, result in zip(weight, development, incumbent_results, strict=True))
    # perform both real final fits even when development has no selectable winner
    for arm in ARMS[1:]:
        model, receipt = fit_candidate(training, month, arm, incumbent)
        final_models[arm] = model
        score_models = {}
        # historical score months retain their own earlier-only embargo
        for score_month in sorted({instant(row["validAt"]).astimezone(ZONE).strftime("%Y-%m") for row in development}):
            score_models[score_month], _ = fit_candidate(training, score_month, arm, incumbent)
        results = infer_rows(development, score_models)
        mae = sum(float(w) * abs(result["predictionTemperatureC"] - row["actualTemperatureC"]) for w, row, result in zip(weight, development, results, strict=True))
        applied_count = sum(result["applied"] for result in results)
        eligible = supported and model["supported"] and applied_count > 0 and mae <= raw_mae and mae <= incumbent_mae
        arms[arm] = {"fitReceipt": receipt, "developmentMae": mae if supported else None,
                     "developmentDates": len(dates), "developmentRows": len(development),
                     "fallbackCount": sum(not result["applied"] for result in results),
                     "eligible": eligible}
    eligible = [arm for arm in ARMS[1:] if arms[arm]["eligible"]]
    selected = min(eligible, key=lambda arm: (arms[arm]["developmentMae"], ARMS.index(arm))) if eligible else None
    model = None
    # freeze only the selected causal fit for a future one-shot confirmation
    if selected is not None:
        fitted = final_models[selected]
        model = {key: value for key, value in fitted.items() if key not in ("month", "contractVersion")}
        model.update({"contractVersion": "temperature-permanent-model/v1",
                      "effectiveFrom": format_instant(start),
                      "latestTrainingValidAt": arms[selected]["fitReceipt"]["latestTrainingValidAt"]})
    return {"contractVersion": "temperature-maintenance-fit/v2", "dueMonth": month,
            "state": "development_candidate" if selected is not None else "no_candidate",
            "selectedArm": selected, "model": model, "arms": arms,
            "confirmationOpened": False, "servingChanged": False,
            "developmentRawMae": raw_mae if supported else None,
            "developmentIncumbentMae": incumbent_mae if supported else None}


# read the sandbox's fixed input and return only bounded candidate material
def fit_only_main():
    path = Path("/input/data/temperature.json")
    # reject links and overflow before decoding any rows
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError("invalid temperature sandbox input")
    value = fit_monthly_temperature(json.loads(path.read_bytes()))
    data = canonical(value) + b"\n"
    # sanitized family output remains within the eight-mib monthly ceiling
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("temperature candidate ceiling exceeded")
    destination = Path("/output/temperature.json")
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    # flush the isolated result before the controller reads it
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# run every preregistered arm and retain rejected or unsupported proposals
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--register", nargs=2, metavar=("FROM", "TO"))
    parser.add_argument("--purpose", choices=("retrospective_development", "fresh_confirmation"), default="retrospective_development")
    parser.add_argument("--preregistration", type=Path, required=True)
    parser.add_argument("--forecast-package", type=Path, action="append")
    parser.add_argument("--adjustment-package", type=Path, action="append")
    parser.add_argument("--training-rows", type=Path)
    parser.add_argument("--training-package", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    # register future intervals without opening forecast or target evidence
    if args.register:
        value = registration(*args.register, args.purpose)
        write_private(args.preregistration, value)
        print(json.dumps({"preregistrationSha256": digest(value), "servingChanged": False}))
        return
    value = validate_registration(json.loads(args.preregistration.read_text()))
    # require both complementary packages before research access
    if args.forecast_package is None or args.adjustment_package is None or args.output is None:
        parser.error("research requires forecast-package, adjustment-package and private output")
    # require independently verified earlier training material for untouched confirmation
    if value["purpose"] == "fresh_confirmation" and args.training_package is None:
        parser.error("fresh confirmation requires a disjoint verified training package")
    # keep each training source unambiguous
    if args.training_package is not None and args.training_rows is not None:
        parser.error("select training-package or training-rows, not both")
    burn_confirmation(args.preregistration, value)
    data = native("load", options={"forecastPackage": [str(path.resolve()) for path in args.forecast_package],
                                   "adjustmentPackage": [str(path.resolve()) for path in args.adjustment_package]})
    all_rows = normalized_package_rows(data["rows"])
    # retain outside-window records for training but never score invalid horizons
    rows = [row for row in all_rows if row["scoreEligible"]]
    inputs = data["inputs"]
    # bind preregistration to the exact exported local-date interval
    if (inputs["localDateFrom"], inputs["localDateTo"]) != (value["fromLocalDate"], value["toLocalDate"]):
        raise ValueError("preregistration and package dates differ")
    training_source = {"kind": "earlier_only_walk_forward", "inputs": inputs}
    training = all_rows
    # load both complementary training snapshots without touching any database
    if args.training_package is not None:
        training_data = native("load", options={
            "forecastPackage": str((args.training_package / "forecast").resolve()),
            "adjustmentPackage": str((args.training_package / "adjustment").resolve())})
        training_inputs = training_data["inputs"]
        # require the independently verified training interval to precede score dates
        if training_inputs["localDateTo"] >= value["fromLocalDate"]:
            raise ValueError("training and evaluation packages overlap")
        training = normalized_package_rows(training_data["rows"])
        training_source = {"kind": "verified_disjoint_package_pair", "inputs": training_inputs}
    # opened retained rows remain development with an exact immutable input hash
    elif args.training_rows is not None:
        training = read_prepared_rows(args.training_rows)
        training_source = {"kind": "retained_prepared_rows",
                           "sha256": hashlib.sha256(args.training_rows.read_bytes()).hexdigest()}
    incumbent = json.loads(INCUMBENT_PATH.read_text())["model"]
    policy = native("policy")
    # pin the complete delayed runtime policy before generating any candidate
    if any(policy[key] != POLICY[key] for key in ("scope", "sourceDelayHours", "operationalDelayHours",
                                                 "minimumModelLeadHours", "maximumModelLeadHours",
                                                 "maximumCorrectionC", "physicalMinimumC", "physicalMaximumC")):
        raise ValueError("temperature runtime policy drift")
    output = private_output(args.output)
    reports = {}
    all_fallbacks = data["actualServingFallbacks"]
    fallbacks = [row for row in all_fallbacks
                 if row["servingIdentitySha256"] == INCUMBENT_PATH.stem.removeprefix("sha256-")]
    fallback_reasons = dict(collections.Counter(row["reasonCode"] or "unspecified_public_fallback" for row in fallbacks))
    months = sorted({instant(row["validAt"]).astimezone(ZONE).strftime("%Y-%m") for row in rows})
    # run the incumbent and both fixed refit arms without selecting a serving winner
    for arm in ARMS:
        models = {"frozen": incumbent}
        receipts = []
        # only fit the named refresh arms
        if arm != ARMS[0]:
            models = {}
            # fit each target-month model using earlier labels only
            for month in months:
                models[month], receipt = fit_candidate(training, month, arm, incumbent)
                receipts.append(receipt)
        results = infer_rows(rows, models)
        # incumbent issuance facts survive descriptive evaluation without implying fresh candidate qualification
        report_rows = rows
        other_class_count = 0
        # never pool retained counterfactuals with committed incumbent values
        if arm == ARMS[0]:
            write_result(output, "incumbent-source-reconstructions.json", {
                "contractVersion": "temperature-source-reconstructions/v1", "inputs": inputs,
                "servingChanged": False, "qualificationEligible": False,
                "populations": source_reconstruction_reports(rows, results, inputs)})
            report_rows, results, other_class_count = incumbent_population(rows, results)
        # offline candidate predictions are never actual issued values
        if arm != ARMS[0]:
            # a future burned source receipt permits prospective reconstruction but never actual issuance
            if value["purpose"] == "fresh_confirmation":
                report_rows, results, other_class_count = incumbent_population(
                    [{**row, "recordedRuntimeResult": None} for row in rows], results)
            else:
                report_rows = [{**row, "evidenceClass": "development"} for row in rows]
        card = family_card(report_rows, results, inputs)
        # reconcile disjoint evidence populations without including them in metrics
        if other_class_count:
            card["support"]["exclusionReasons"]["other_evidence_class"] = other_class_count
            card["support"]["excludedCount"] += other_class_count
            card["support"]["gapCount"] += other_class_count
            card["support"]["rowCount"] += other_class_count
        # actual public fallbacks are visible gaps in the selection-conditioned ECMWF population
        if arm == ARMS[0] and fallbacks:
            include_actual_serving_fallbacks(card, fallbacks, fallback_reasons)
        report = {"contractVersion": "forecast-adjustment-performance-report/v1", "siteKey": "ballydidean",
                  "generatedAt": format_instant(dt.datetime.now(dt.timezone.utc)),
                  "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                  "inputs": inputs, "family": card}
        reports[arm] = {"reportSha256": digest(report), "supportState": card["supportState"],
                        "comparisonState": card["comparisonState"]}
        write_result(output, f"{arm}.report.json", report)
        write_result(output, f"{arm}.models.json", {"models": models, "fitReceipts": receipts})
        # the published temperature card describes the incumbent, never a selected candidate
        if arm == ARMS[0]:
            write_result(output, "report.json", report)
    write_result(output, "actual-serving-best-match-fallbacks.json", {
        "contractVersion": "temperature-actual-serving-fallbacks/v1", "inputs": inputs,
        "baseline": "actual_serving_best_match_fallback", "qualificationEligible": False,
        "servingChanged": False,
        "fallbackReasons": dict(collections.Counter(row["reasonCode"] or "unspecified_public_fallback"
                                                     for row in all_fallbacks)),
        "rows": all_fallbacks})
    write_result(output, "research.json", {"policy": value, "preregistrationSha256": digest(value),
                                            "trainingSource": training_source,
                                            "arms": reports, "servingChanged": False,
                                            "operatorApprovalRequired": True, "automaticActivationEligible": False})
    print(json.dumps({"arms": reports, "servingChanged": False, "qualificationState": "pending_support"}))


# keep all execution behind the explicit offline command
if __name__ == "__main__":
    # keep the old v1 command separate from maintenance fitting
    if sys.argv[1:] == ["--fit-only"]:
        fit_only_main()
    else:
        main()
