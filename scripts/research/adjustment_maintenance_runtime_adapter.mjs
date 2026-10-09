import { createHash } from "node:crypto";

import {
  parseShadowRevisionCapsule,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  buildPortableRainModelPackage,
  createNativeRainCandidateArtifactEvaluator,
} from "./adjustment_rain_model_package.mjs";
import {
  applyForecastAdjustmentWindMaintenanceCandidate,
} from "./adjustment-maintenance-runtime/forecast/apply.js";
import {
  scalarNetworkActual,
} from "./adjustment-maintenance-runtime/forecast/algorithm-v1.js";
import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "./adjustment-maintenance-runtime/node_modules/@weather/domain/dist/forecast-adjustment.js";
import {
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  evaluateRainMaintenancePromotion,
  evaluateRainMaintenanceRegression,
  evaluateTemperatureMaintenancePromotion,
  evaluateTemperatureMaintenanceRegression,
  evaluateWindMaintenancePromotion,
  evaluateWindMaintenanceRegression,
} from "./adjustment-maintenance-runtime/forecast/maintenance-policy.js";
import {
  buildForecastAdjustmentMaintenanceRuntimePackage,
  encodeForecastAdjustmentMaintenanceRuntimePackage,
  forecastAdjustmentRainMaintenanceSourceIdentitySha256 as rainSourceIdentitySha256,
  forecastAdjustmentTemperatureMaintenanceSourceIdentitySha256 as temperatureSourceIdentitySha256,
  forecastAdjustmentWindMaintenanceSourceIdentitySha256 as windSourceIdentitySha256,
  verifyForecastAdjustmentMaintenanceRuntimePackage,
} from "./adjustment-maintenance-runtime/forecast/maintenance-runtime-package.js";
import {
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowSourceProjection,
  parseMaintenanceShadowSourceProjection,
  parseMaintenanceShadowValues,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  loadInstalledMaintenanceShadowCandidate,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-catalog.js";
import {
  parseMaintenanceShadowComparator,
  validateMaintenanceShadowComparatorBinding,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-comparator.js";
import {
  parseAdjustmentRainGateControlProjection,
  parseAdjustmentRevisionProjectionDocument,
} from "./adjustment-maintenance-runtime/forecast/maintenance-revision-projection.js";
import {
  adjustmentRainFixedGaugeTargetActual,
  parseAdjustmentRainFixedGaugeTargetProjection,
} from "./adjustment-maintenance-runtime/forecast/rain-fixed-gauge-target.js";
import {
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
  validateRainMaintenanceControlState,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";
import {
  createRainHurdleWindPortableArtifactEvaluator,
  createRainHurdleWindPortablePerformanceEvaluator,
  replayRainHurdleWindNativeParityPerformance,
} from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind.js";
import {
  createForecastAdjustmentRainRuntimeRegistryLoader,
} from "./adjustment-maintenance-runtime/forecast/rain-runtime-registry.js";
import {
  createForecastAdjustmentRuntimeLoader,
  createForecastAdjustmentTemperatureCanaryRuntimeLoader,
  createForecastAdjustmentWindCanaryRuntimeLoader,
} from "./adjustment-maintenance-runtime/forecast/runtime-loader.js";
import {
  applyForecastAdjustmentTemperatureMaintenanceCandidate,
} from "./adjustment-maintenance-runtime/forecast/temperature-canary.js";
export {
  ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_GENERATED_FILES,
  ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_SOURCE_FILES,
} from "./adjustment_maintenance_runtime_manifest.mjs";
export {
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
  validateRainMaintenanceControlState,
};

const incumbentRuntimeLoaders = Object.freeze({
  general: createForecastAdjustmentRuntimeLoader(),
  rain: createForecastAdjustmentRainRuntimeRegistryLoader(),
  temperature: createForecastAdjustmentTemperatureCanaryRuntimeLoader({
    ...(process.env.WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH === undefined
      ? {}
      : {
          environmentKillSwitch:
            process.env.WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH,
        }),
  }),
  wind: createForecastAdjustmentWindCanaryRuntimeLoader({
    ...(process.env.WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH === undefined
      ? {}
      : {
          environmentKillSwitch:
            process.env.WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH,
        }),
  }),
});

// load one root-selected inactive artifact without claiming raw candidate bytes
export async function loadInstalledForecastAdjustmentMaintenanceShadowCandidate(input) {
  requireExactKeys(input, ["family"], "installed shadow candidate input");
  const family = requirePortableFamily(input.family);
  const installed = await loadInstalledMaintenanceShadowCandidate({ family });
  // preserve an absent shadow slot as an explicit inactive selection
  if (installed === null) {
    return null;
  }
  return Object.freeze({
    artifactBytes: Buffer.from(canonicalJsonBytes(installed.bundle)),
    family,
    receipt: installed.receipt,
    registration: installed.registration,
  });
}

// package one verified temperature or wind fit for inactive evaluation
export function buildForecastAdjustmentMaintenancePortableCandidate(input) {
  requireExactKeys(input, ["candidateBytes", "family"], "portable candidate input");
  const family = requirePortableFamily(input.family);
  const candidateBytes = requireBuffer(input.candidateBytes, "candidateBytes");
  // retain rain's independently generated public artifact and candidate address
  if (family === "rain") {
    const packaged = buildPortableRainModelPackage(candidateBytes);
    return Object.freeze({
      artifactBytes: Buffer.from(canonicalJsonBytes(packaged.runtimeArtifact)),
      artifactSha256: packaged.artifactSha256,
      candidateSha256: packaged.candidateSha256,
      controlStateBytes: packaged.controlStateBytes,
      controlStateSha256: packaged.controlStateSha256,
      ordinalArtifactBytes: packaged.ordinalArtifactBytes,
      ordinalArtifactSha256: packaged.ordinalArtifactSha256,
      sourceIdentitySha256: rainSourceIdentitySha256(),
    });
  }
  const artifact = buildForecastAdjustmentMaintenanceRuntimePackage(candidateBytes);

  // prohibit a caller family label from relabelling fitted bytes
  if (artifact.family !== family) {
    throw new TypeError("portable candidate family differs");
  }
  const artifactBytes = encodeForecastAdjustmentMaintenanceRuntimePackage(artifact);
  const sourceIdentitySha256 = family === "temperature"
    ? temperatureSourceIdentitySha256()
    : windSourceIdentitySha256(artifact.candidate);
  return Object.freeze({
    artifactBytes,
    artifactSha256: artifact.bundleSha256,
    candidateSha256: artifact.candidateSha256,
    sourceIdentitySha256,
  });
}

// evaluate verified fit bytes through the native fit projection
export function evaluateForecastAdjustmentMaintenanceNativeCandidate(input) {
  requireExactKeys(input, ["candidateBytes", "family", "input"], "native candidate input");
  const family = requirePortableFamily(input.family);
  const candidateBytes = requireBuffer(input.candidateBytes, "candidateBytes");
  // score rain through the raw fitted artifact on the capsule's exact causal inputs
  if (family === "rain") {
    const native = createNativeRainCandidateArtifactEvaluator(candidateBytes);
    // score pre-fit archived feature rows without requiring a nonexistent capsule
    if (isRainFeatureParityInput(input.input)) {
      const parity = validateRainFeatureParityInput(
        input.input,
        native.featureNames,
      );
      return Buffer.from(canonicalJsonBytes(
        native.evaluate(parity.features, parity.validAt),
      ));
    }
    const predictionInput = rainPredictionInput(input.input);
    const decision = replayRainHurdleWindNativeParityPerformance(
      predictionInput,
      native.artifactSha256,
      native.modelMonth,
      // score raw selected fit material rather than packaged bytes
      (features, validAt) => native.evaluate(features, validAt),
    );
    return Buffer.from(canonicalJsonBytes(decision));
  }
  const fit = JSON.parse(candidateBytes.toString("utf8"));
  const artifact = buildForecastAdjustmentMaintenanceRuntimePackage(candidateBytes);

  // bind the independently decoded fit to the verified portable address
  if (artifact.family !== family) {
    throw new TypeError("native candidate family differs");
  }
  const decision = family === "temperature"
    ? applyForecastAdjustmentTemperatureMaintenanceCandidate(
      temperatureMaterial(artifact.bundleSha256, fit.model, artifact.source),
      input.input,
    )
    : applyForecastAdjustmentWindMaintenanceCandidate(
      artifact.bundleSha256,
      fit.candidate,
      input.input,
    );
  return Buffer.from(canonicalJsonBytes(decision));
}

// evaluate canonical package bytes through the installed package projection
export function evaluateForecastAdjustmentMaintenancePackagedCandidate(input) {
  requireExactKeys(input, ["artifactBytes", "family", "input"], "packaged candidate input");
  const family = requirePortableFamily(input.family);
  const artifactBytes = requireBuffer(input.artifactBytes, "artifactBytes");
  // score canonical rain artifact bytes through the actual packaged evaluator
  if (family === "rain") {
    const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
    // validate and score the disjoint pre-fit feature contract through package bytes
    if (isRainFeatureParityInput(input.input)) {
      const artifact = JSON.parse(artifactBytes.toString("utf8"));
      const parity = validateRainFeatureParityInput(input.input, artifact.featureNames);
      const evaluate = createRainHurdleWindPortableArtifactEvaluator(
        artifactBytes.toString("utf8"),
        artifactSha256,
      );
      return Buffer.from(canonicalJsonBytes(evaluate(Float32Array.from(
        parity.features,
        // preserve explicit missing split branches in float32 form
        (value) => value === null ? Number.NaN : value,
      ), parity.validAt)));
    }
    const evaluate = createRainHurdleWindPortablePerformanceEvaluator(
      artifactBytes.toString("utf8"),
      artifactSha256,
    );
    return Buffer.from(canonicalJsonBytes(evaluate(rainPredictionInput(input.input))));
  }
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  verifyForecastAdjustmentMaintenanceRuntimePackage(artifact);

  // reject alternate JSON bytes or a relabelled family
  if (!encodeForecastAdjustmentMaintenanceRuntimePackage(artifact).equals(artifactBytes) ||
    artifact.family !== family) {
    throw new TypeError("packaged candidate bytes differ");
  }
  const decision = family === "temperature"
    ? applyForecastAdjustmentTemperatureMaintenanceCandidate(
      temperatureMaterial(artifact.bundleSha256, artifact.model, artifact.source),
      input.input,
    )
    : applyForecastAdjustmentWindMaintenanceCandidate(
      artifact.bundleSha256,
      artifact.candidate,
      input.input,
    );
  return Buffer.from(canonicalJsonBytes(decision));
}

// evaluate the exact family promotion or regression policy
export function evaluateForecastAdjustmentMaintenancePolicy(input) {
  requireExactKeys(input, ["epoch", "family", "kind", "rows"], "maintenance policy input");
  const family = requirePolicyFamily(input.family);

  // keep promotion and regression epoch authority mutually exclusive
  if (input.kind === "promotion" && input.epoch === null) {
    const evaluation = family === "temperature"
      ? evaluateTemperatureMaintenancePromotion(input.rows)
      : family === "wind"
        ? evaluateWindMaintenancePromotion(input.rows)
        : evaluateRainMaintenancePromotion(input.rows);
    return Buffer.from(canonicalJsonBytes(evaluation));
  }
  if (input.kind === "regression" && input.epoch !== null) {
    const evaluation = family === "temperature"
      ? evaluateTemperatureMaintenanceRegression(input.rows, input.epoch)
      : family === "wind"
        ? evaluateWindMaintenanceRegression(input.rows, input.epoch)
        : evaluateRainMaintenanceRegression(input.rows, input.epoch);
    return Buffer.from(canonicalJsonBytes(evaluation));
  }
  throw new TypeError("maintenance policy kind or epoch is invalid");
}

// derive the fixed deployed temperature source identity
export function forecastAdjustmentTemperatureMaintenanceSourceIdentitySha256() {
  return temperatureSourceIdentitySha256();
}

// derive the verified fitted wind source identity from canonical fit bytes
export function forecastAdjustmentWindMaintenanceSourceIdentitySha256(candidateBytes) {
  const bytes = requireBuffer(candidateBytes, "candidateBytes");
  const artifact = buildForecastAdjustmentMaintenanceRuntimePackage(bytes);

  // refuse temperature fit bytes at the wind identity boundary
  if (artifact.family !== "wind") {
    throw new TypeError("wind source identity family differs");
  }
  return windSourceIdentitySha256(artifact.candidate);
}

// derive the fixed deployed rain causal-source identity
export function forecastAdjustmentRainMaintenanceSourceIdentitySha256() {
  return rainSourceIdentitySha256();
}

// load one immutable startup serving selection without caller-controlled paths
export async function loadForecastAdjustmentMaintenanceIncumbent(input) {
  requireExactKeys(input, ["family"], "maintenance incumbent input");
  const family = requirePortableFamily(input.family);
  let runtime;
  // use the same fixed startup selection sequence as serving
  if (family === "temperature") {
    runtime = await incumbentRuntimeLoaders.temperature.load();
  } else if (family === "rain") {
    runtime = await incumbentRuntimeLoaders.rain.load();
  } else {
    const canary = await incumbentRuntimeLoaders.wind.load();
    runtime = canary.state === "disabled" && canary.reasonCode === "registry_inactive"
      ? await incumbentRuntimeLoaders.general.load()
      : canary;
  }
  const authority = runtime.comparatorAuthority;
  const artifactBytes = authority === undefined || authority.artifactBase64 === null
    ? null
    : Buffer.from(authority.artifactBase64, "base64");
  const bundle = "bundle" in runtime ? runtime.bundle : null;
  const model = family === "temperature" && bundle !== null && "model" in bundle
    ? bundle.model
    : null;
  const candidate = family === "wind" && bundle !== null && "candidate" in bundle
    ? bundle.candidate
    : null;
  return Object.freeze({
    artifactBytes,
    artifactIdentitySha256: authority?.artifactIdentitySha256 ?? null,
    authorityKind: authority?.authorityKind ?? null,
    candidate,
    comparatorAuthorityBytes: authority === undefined
      ? null
      : Buffer.from(canonicalJsonBytes(authority)),
    family,
    model,
    reasonCode: runtime.reasonCode,
    state: runtime.state,
  });
}

// parse and cross-bind one exact archived shadow capsule member
export function parseForecastAdjustmentMaintenanceShadowCapsule(input) {
  requireExactKeys(input, ["capsuleBytes"], "shadow capsule input");
  const capsuleBytes = requireBuffer(input.capsuleBytes, "capsuleBytes");
  const capsule = parseShadowRevisionCapsule(capsuleBytes);
  const bodyBytes = Buffer.from(capsule.bodyBase64, "base64");
  const sourceBytes = Buffer.from(capsule.sourceProjectionBase64, "base64");
  const body = parseMaintenanceShadowValues(bodyBytes);
  const source = parseMaintenanceShadowSourceProjection(sourceBytes);
  const metadata = createMaintenanceShadowPredictionMetadata(bodyBytes, sourceBytes);
  const comparatorBytes = capsule.contractVersion === "adjustment-shadow-revision-capsule/v2"
    ? Buffer.from(capsule.comparatorBase64, "base64")
    : null;
  const comparator = comparatorBytes === null ? null : parseMaintenanceShadowComparator(comparatorBytes);

  // require the capsule metadata to be the exact package recomputation
  if (canonicalJsonBytes(metadata) !== canonicalJsonBytes(capsule.metadata)) {
    throw new TypeError("shadow capsule metadata differs");
  }
  // require the incumbent member to bind the exact source and candidate body
  if (comparator !== null) {
    if (createHash("sha256").update(comparatorBytes).digest("hex") !== capsule.comparatorSha256) {
      throw new TypeError("shadow capsule comparator hash differs");
    }
    validateMaintenanceShadowComparatorBinding(comparator, sourceBytes, bodyBytes);
  }
  return Object.freeze({
    body,
    bodyBytes,
    comparator,
    comparatorBytes,
    metadata,
    revisionReceipt: capsule.revisionReceipt,
    source,
    sourceBytes,
    sourceIdentity: createMaintenanceShadowSourceIdentity(sourceBytes),
  });
}

// expose the exact nested native-source member without minting a second database receipt
export function projectForecastAdjustmentMaintenanceShadowNativeSource(input) {
  requireExactKeys(input, ["capsuleBytes"], "shadow native source input");
  const capsuleBytes = requireBuffer(input.capsuleBytes, "capsuleBytes");
  const outer = parseShadowRevisionCapsule(capsuleBytes);
  const parsed = parseForecastAdjustmentMaintenanceShadowCapsule({ capsuleBytes });
  const sourceProjectionSha256 = createHash("sha256").update(parsed.sourceBytes).digest("hex");

  // preserve the original shadow frontier receipt instead of relabelling it as native_source
  if (parsed.revisionReceipt.projectionKind !== "shadow_prediction" ||
      parsed.revisionReceipt.projectionIdentitySha256 !== parsed.sourceIdentity.sourceReceiptSha256 ||
      parsed.revisionReceipt.projectionSha256 !== sourceProjectionSha256 ||
      outer.sourceProjectionSha256 !== sourceProjectionSha256 ||
      parsed.metadata.inputSha256 !== sourceProjectionSha256) {
    throw new TypeError("shadow native source receipt differs");
  }
  const sourceRows = parsed.source.rows.map((row, index) => Object.freeze({
    contentSha256: row.contentSha256,
    leadHours: row.leadHours,
    receivedAt: row.receivedAt,
    referenceAt: row.referenceAt,
    sourceRowSha256: parsed.sourceIdentity.sourceRowSha256[index],
    validAt: row.validAt,
  }));
  const captureClaims = parsed.source.family === "rain"
    ? parsed.source.causalInputs.captureSet.map(
        // retain the parser-verified raw capture claims in their canonical source order
        (claim) => Object.freeze(structuredClone(claim)),
      )
    : [];
  return Object.freeze({
    candidateSha256: parsed.body.candidateSha256,
    captureClaims: Object.freeze(captureClaims),
    dueKey: parsed.body.dueKey,
    family: parsed.body.family,
    predictionBodySha256: parsed.metadata.predictionBodySha256,
    registrationSha256: parsed.body.registrationSha256,
    revisionReceipt: Object.freeze(structuredClone(parsed.revisionReceipt)),
    sourceBytes: Buffer.from(parsed.sourceBytes),
    sourceProjectionSha256,
    sourceReceiptSha256: parsed.sourceIdentity.sourceReceiptSha256,
    sourceRows: Object.freeze(sourceRows),
  });
}

// derive retained and deterministic synthetic evaluator inputs from one authenticated capsule
export function buildForecastAdjustmentMaintenanceParityInputs(input) {
  requireExactKeys(input, ["capsuleBytes"], "maintenance parity input");
  const parsed = parseForecastAdjustmentMaintenanceShadowCapsule(input);
  const retainedInput = maintenanceParityRetainedInput(parsed.source);
  const syntheticInput = maintenanceParitySyntheticInput(parsed.source.family, retainedInput);
  const retainedInputBytes = maintenanceParityInputBytes(parsed.source.family, retainedInput);
  const syntheticInputBytes = maintenanceParityInputBytes(parsed.source.family, syntheticInput);

  // require a genuinely distinct replay while retaining the same reviewed source grammar
  if (retainedInputBytes.equals(syntheticInputBytes)) {
    throw new TypeError("maintenance synthetic parity input is unchanged");
  }
  return Object.freeze({
    family: parsed.source.family,
    retainedInput: Object.freeze(structuredClone(retainedInput)),
    retainedInputBytes,
    retainedInputSha256: createHash("sha256").update(retainedInputBytes).digest("hex"),
    syntheticInput: Object.freeze(structuredClone(syntheticInput)),
    syntheticInputBytes,
    syntheticInputSha256: createHash("sha256").update(syntheticInputBytes).digest("hex"),
  });
}

// derive first-candidate parity inputs from an authenticated monthly fit assembly
export function buildForecastAdjustmentMaintenanceFitParityInputs(input) {
  requireExactKeys(input, ["family", "fitInput"], "maintenance fit parity input");
  const family = requirePortableFamily(input.family);
  const fitInput = input.fitInput;
  // reject scalar or open-ended fit boundaries before selecting a row
  if (fitInput === null || typeof fitInput !== "object" || Array.isArray(fitInput)) {
    throw new TypeError("maintenance fit parity input differs");
  }
  let retainedInput;
  // derive rain directly from the pre-candidate archived feature population
  if (family === "rain") {
    // require the frozen full feature order before selecting numerical material
    if (fitInput.contractVersion !== "rain-maintenance-fit-input/v3" ||
        !Array.isArray(fitInput.featureNames) || fitInput.featureNames.length !== 107) {
      throw new TypeError("rain fit parity input differs");
    }
    const row = firstFitParityRow(fitInput);
    const parity = validateRainFeatureParityInput({
      contractVersion: "rain-maintenance-feature-parity-input/v2",
      featureNames: fitInput.featureNames,
      features: row.features,
      validAt: row.validAt,
    }, fitInput.featureNames);
    retainedInput = {
      contractVersion: "rain-maintenance-feature-parity-input/v2",
      featureNames: structuredClone(fitInput.featureNames),
      features: structuredClone(parity.features),
      validAt: parity.validAt,
    };
  } else if (family === "temperature") {
    // preserve the existing fit contract while requiring enriched source provenance below
    if (fitInput.contractVersion !== "temperature-maintenance-fit-input/v2") {
      throw new TypeError("temperature fit parity input differs");
    }
    retainedInput = temperatureFitParityInput(firstFitParityRow(fitInput));
  } else {
    // require the archive-native wind fit contract
    if (fitInput.contractVersion !== "wind-maintenance-fit-input/v2") {
      throw new TypeError("wind fit parity input differs");
    }
    retainedInput = windFitParityInput(fitInput.rows);
  }
  const syntheticInput = maintenanceParitySyntheticInput(family, retainedInput);
  const retainedInputBytes = maintenanceParityInputBytes(family, retainedInput);
  const syntheticInputBytes = maintenanceParityInputBytes(family, syntheticInput);
  // prohibit a nominal synthetic fixture that leaves evaluator bytes unchanged
  if (retainedInputBytes.equals(syntheticInputBytes)) {
    throw new TypeError("maintenance fit synthetic parity input is unchanged");
  }
  return Object.freeze({
    family,
    retainedInput: Object.freeze(structuredClone(retainedInput)),
    retainedInputBytes,
    retainedInputSha256: createHash("sha256").update(retainedInputBytes).digest("hex"),
    syntheticInput: Object.freeze(structuredClone(syntheticInput)),
    syntheticInputBytes,
    syntheticInputSha256: createHash("sha256").update(syntheticInputBytes).digest("hex"),
  });
}

// parse one archived serving projection through the production closed grammar
export function parseForecastAdjustmentMaintenanceRevisionProjection(input) {
  requireExactKeys(input, ["projectionBytes"], "revision projection input");
  const projectionBytes = requireBuffer(input.projectionBytes, "projectionBytes");
  return parseAdjustmentRevisionProjectionDocument(projectionBytes);
}

// parse one archived fixed-gauge target through its raw-body-bound grammar
export function parseForecastAdjustmentRainFixedGaugeTarget(input) {
  requireExactKeys(input, ["projectionBytes"], "rain fixed-gauge target input");
  const projectionBytes = requireBuffer(input.projectionBytes, "projectionBytes");
  const projection = parseAdjustmentRainFixedGaugeTargetProjection(projectionBytes);
  return Object.freeze({
    actual: adjustmentRainFixedGaugeTargetActual(projection),
    projection,
  });
}

// parse one archived pre-target rain control projection through its exact grammar
export function parseForecastAdjustmentRainMaintenanceControlProjection(input) {
  requireExactKeys(input, ["projectionBytes"], "rain control projection input");
  const projectionBytes = requireBuffer(input.projectionBytes, "projectionBytes");
  return parseAdjustmentRainGateControlProjection(projectionBytes);
}

// project parser-verified physical revisions through the frozen station network
export function projectForecastAdjustmentMaintenanceTemperatureTargets(input) {
  requireExactKeys(input, ["projectionBytes"], "temperature target projection input");
  // reject an unbounded or empty archive selection before decoding members
  if (!Array.isArray(input.projectionBytes) || input.projectionBytes.length < 1 ||
    input.projectionBytes.length > 4_096) {
    throw new RangeError("temperature target projection count is invalid");
  }
  const stationRows = [];
  // authenticate each target row through the production projection parser and domain lineage
  for (const value of input.projectionBytes) {
    const projectionBytes = requireBuffer(value, "projectionBytes member");
    const projection = parseAdjustmentRevisionProjectionDocument(projectionBytes);
    // accept only actual physical target members
    if (projection.projectionKind !== "target_revision") {
      throw new TypeError("temperature target projection kind differs");
    }
    const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
      // select the reviewed lineage by its archived source key
      (candidate) => candidate.sourceKey === projection.source.sourceKey,
    );
    const station = lineage === undefined
      ? undefined
      : FORECAST_OBSERVATION_STATIONS.find(
          // bind the lineage to its one physical station
          (candidate) => candidate.key === lineage.physicalStationKey,
        );
    // reject caller labels that do not match the frozen lineage table
    if (lineage === undefined || station === undefined ||
      projection.source.adapterVersion !== lineage.adapterContract ||
      projection.source.sourceConfigFingerprint !== lineage.checkedFingerprint ||
      !station.acceptedSourceKeys.includes(lineage.sourceKey)) {
      throw new TypeError("temperature target source lineage differs");
    }
    const projectionSha256 = createHash("sha256").update(projectionBytes).digest("hex");
    // retain every normalized row, including an explicit missing temperature
    for (const row of projection.rows) {
      const validAt = Date.parse(String(row.validAt));
      const startsAt = lineage.acceptedStartInclusive === null
        ? null
        : Date.parse(lineage.acceptedStartInclusive);
      const endsAt = lineage.acceptedEndExclusive === null
        ? null
        : Date.parse(lineage.acceptedEndExclusive);
      // enforce the reviewed source interval rather than trusting its source key alone
      if ((startsAt !== null && validAt < startsAt) ||
        (endsAt !== null && validAt >= endsAt)) {
        throw new RangeError("temperature target source interval differs");
      }
      stationRows.push(Object.freeze({
        contentSha256: row.contentSha256,
        physicalStationKey: station.key,
        projectionSha256,
        sourceKey: lineage.sourceKey,
        temperatureC64: row.temperatureC64,
        validAt: row.validAt,
      }));
    }
  }
  stationRows.sort(
    // make archive member input order irrelevant to the target identity
    (left, right) => left.validAt.localeCompare(right.validAt) ||
      left.physicalStationKey.localeCompare(right.physicalStationKey) ||
      left.projectionSha256.localeCompare(right.projectionSha256),
  );
  const targets = [];
  // group the exact physical rows by target clock
  for (let offset = 0; offset < stationRows.length;) {
    const validAt = stationRows[offset].validAt;
    const rows = [];
    // collect one complete clock without reordering station identity
    while (offset < stationRows.length && stationRows[offset].validAt === validAt) {
      rows.push(stationRows[offset]);
      offset += 1;
    }
    const stationKeys = new Set(rows.map((row) => row.physicalStationKey));
    // refuse two archived source members for one physical station and clock
    if (stationKeys.size !== rows.length) {
      throw new RangeError("temperature target station is duplicated");
    }
    const contributions = rows.flatMap(
      // exclude only an explicitly absent physical temperature
      (row) => row.temperatureC64 === null ? [] : [{
        nearestRank: FORECAST_OBSERVATION_STATIONS.find(
          // recover the frozen station geometry for the deterministic scalar
          (station) => station.key === row.physicalStationKey,
        ).nearestRank,
        physicalStationKey: row.physicalStationKey,
        unnormalizedSpatialWeight: FORECAST_OBSERVATION_STATIONS.find(
          // recover the same reviewed station weight
          (station) => station.key === row.physicalStationKey,
        ).unnormalizedSpatialWeight,
        value: decodeMaintenanceBinary64(row.temperatureC64),
      }],
    );
    const actual = scalarNetworkActual(contributions);
    targets.push(Object.freeze({
      networkTemperatureC64: actual === null ? null : encodeMaintenanceBinary64(actual.value),
      normalizedWeights: Object.freeze(actual === null ? [] : actual.normalizedWeights.map(
        // keep deterministic weights in exact binary64 form
        (weight) => Object.freeze({
          normalizedWeight64: encodeMaintenanceBinary64(weight.normalizedWeight),
          physicalStationKey: weight.physicalStationKey,
        }),
      )),
      stationCount: contributions.length,
      validAt,
    }));
  }
  return Object.freeze({
    stationRows: Object.freeze(stationRows),
    temperatureTargets: Object.freeze(targets),
  });
}

// project one portable temperature artifact into inactive evaluator material
function temperatureMaterial(bundleSha256, model, source) {
  return {
    bundleSha256,
    maintenanceAuthority: null,
    model,
    servedForecastIdentity: {
      adapterVersion: source.adapterVersion,
      dataset: source.dataset,
      maximumReceiptAgeHours: source.maximumReceiptAgeHours,
      providerKey: source.providerKey,
      sourceDelayHours: source.sourceDelayHours,
      upstreamModel: source.upstreamModel,
    },
    trainingForecastIdentity: {
      cohort: source.cohort,
      scope: source.scope,
    },
  };
}

// decode one validated rain source projection into the compiled causal input
function rainPredictionInput(value) {
  const sourceBytes = encodeMaintenanceShadowSourceProjection(value);
  const source = parseMaintenanceShadowSourceProjection(sourceBytes);

  // prohibit another family or a geometry-only rain projection
  if (source.family !== "rain" || source.causalInputs === undefined) {
    throw new TypeError("rain causal source is invalid");
  }
  // restore one exact runtime forecast profile from binary64 evidence rows
  const projectRun = (run) => ({
    completedAt: run.completedAt,
    hours: run.hours.map(
      // decode every exact binary64 covariate without decimal substitution
      (hour) => ({
        cloudCoverPercent: decodeNullableBinary64(hour.cloudCoverPercent64),
        leadHours: hour.leadHours,
        precipitationMm: decodeNullableBinary64(hour.precipitationMm64),
        pressureHpa: decodeNullableBinary64(hour.pressureHpa64),
        relativeHumidityPercent: decodeNullableBinary64(hour.relativeHumidityPercent64),
        temperatureC: decodeNullableBinary64(hour.temperatureC64),
        windDirectionDegrees: decodeNullableBinary64(hour.windDirectionDegrees64),
        windSpeedMps: decodeNullableBinary64(hour.windSpeedMps64),
      }),
    ),
    runInitializedAt: run.runInitializedAt,
  });
  return {
    currentRun: projectRun(source.causalInputs.currentRun),
    nowUtc: source.issuedAt,
    priorRuns: source.causalInputs.priorRuns.map(projectRun),
    stationHours: source.causalInputs.stationHours.map(
      // decode the exact station rows consumed by the feature builder
      (hour) => ({
        hourAt: hour.hourAt,
        precipitationMm: decodeNullableBinary64(hour.precipitationMm64),
        receivedAt: hour.receivedAt,
        stationId: hour.stationId,
        temperatureC: decodeNullableBinary64(hour.temperatureC64),
      }),
    ),
  };
}

// project one parser-authenticated source row into the family evaluator contract
function maintenanceParityRetainedInput(source) {
  // retain the full causal rain source because its evaluator consumes the complete run graph
  if (source.family === "rain") {
    return structuredClone(source);
  }
  const row = source.rows[0];
  // project the exact temperature input used by inactive shadow evaluation
  if (source.family === "temperature") {
    if (source.recentErrorState === undefined) {
      throw new TypeError("temperature parity recent state is absent");
    }
    return {
      evaluatedAt: source.issuedAt,
      rawBestMatchTemperatureC: decodeNullableBinary64(row.bestMatchTemperatureC64),
      recentErrorState: structuredClone(source.recentErrorState),
      sourceForecast: {
        adapterVersion: String(row.adapterVersion),
        dataset: "single_run",
        firstReceivedAt: String(row.receivedAt),
        modelCycle: row.modelCycle,
        modelLeadHours: Number(row.modelLeadHours),
        providerKey: "open-meteo",
        providerResponseSha256: String(row.providerResponseSha256),
        rawRelativeHumidityPercent: decodeNullableBinary64(row.rawRelativeHumidityPercent64),
        rawTemperatureC: decodeMaintenanceBinary64(row.rawTemperatureC64),
        rawWindSpeedMps: decodeNullableBinary64(row.rawWindSpeedMps64),
        runInitializedAt: String(row.referenceAt),
        upstreamModel: "ecmwf_ifs",
        validAt: String(row.validAt),
      },
      validAt: String(row.validAt),
    };
  }
  const windSpeedMps = decodeMaintenanceBinary64(row.windSpeedMps64);
  const windGustMps = decodeNullableBinary64(row.windGustMps64);
  return {
    evaluatedAt: source.issuedAt,
    metrics: maintenanceParityWindMetrics(windSpeedMps, windGustMps),
    rawForecastProvenance: {
      adapterVersion: String(row.adapterVersion),
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch: String(row.contractEpoch),
      dataset: String(row.dataset),
      referenceAt: String(row.referenceAt),
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: String(row.sourceConfigFingerprint),
      sourceKey: String(row.sourceKey),
      targetLeadHours: Number(row.modelLeadHours),
      upstreamModel: String(row.upstreamModel),
      validAt: String(row.validAt),
    },
  };
}

// perturb only bounded numerical inputs while preserving the reviewed family structure
function maintenanceParitySyntheticInput(family, retainedInput) {
  const synthetic = structuredClone(retainedInput);
  // create one causal but non-authoritative rain replay fixture
  if (family === "rain") {
    // distinguish archived feature parity from full causal-source parity
    if (isRainFeatureParityInput(synthetic)) {
      const raw = synthetic.features[5];
      // preserve the physical precipitation feature domain
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        throw new TypeError("rain fit parity raw feature differs");
      }
      synthetic.features[5] = Math.max(0, raw + 0.125);
    } else {
      const hour = synthetic.causalInputs.currentRun.hours[0];
      const precipitationMm = decodeNullableBinary64(hour.precipitationMm64) ?? 0;
      hour.precipitationMm64 = encodeMaintenanceBinary64(Math.max(0, precipitationMm + 0.125));
    }
    return synthetic;
  }
  // preserve nullable best-match semantics while changing the source temperature
  if (family === "temperature") {
    synthetic.sourceForecast.rawTemperatureC += 0.125;
    // retain the explicit missing best-match state when it was absent
    if (synthetic.rawBestMatchTemperatureC !== null) {
      synthetic.rawBestMatchTemperatureC += 0.125;
    }
    return synthetic;
  }
  synthetic.metrics.windSpeedMps = Math.max(0, synthetic.metrics.windSpeedMps + 0.125);
  // preserve nullable middle-band gust and the speed floor
  if (synthetic.metrics.windGustMps !== null) {
    synthetic.metrics.windGustMps = Math.max(
      synthetic.metrics.windSpeedMps,
      synthetic.metrics.windGustMps + 0.125,
    );
  }
  return synthetic;
}

// encode the exact object accepted by each family evaluator
function maintenanceParityInputBytes(family, value) {
  return family === "rain" && !isRainFeatureParityInput(value)
    ? encodeMaintenanceShadowSourceProjection(value)
    : Buffer.from(canonicalJsonBytes(value));
}

// select one authentic archive-derived monthly row without target-sensitive ordering
function firstFitParityRow(fitInput) {
  const training = Array.isArray(fitInput.trainingRows) ? fitInput.trainingRows : [];
  const development = Array.isArray(fitInput.developmentRows) ? fitInput.developmentRows : [];
  const rows = [...training, ...development].sort(
    // choose by immutable row identity and clock rather than outcome
    (left, right) => String(left.validAt).localeCompare(String(right.validAt)) ||
      String(left.key).localeCompare(String(right.key)),
  );
  // refuse parity without one genuine selected monthly row
  if (rows.length < 1) {
    throw new TypeError("maintenance fit parity row is absent");
  }
  return rows[0];
}

// project one enriched future-only temperature fit row into the serving evaluator input
function temperatureFitParityInput(row) {
  const required = [
    "adapterVersion", "firstReceivedAt", "modelCycle", "modelLeadHours",
    "providerResponseSha256", "rawBestMatchTemperatureC", "rawRelativeHumidityPercent",
    "rawTemperatureC", "rawWindSpeedMps", "runInitializedAt", "state", "validAt",
  ];
  // require every field that the production temperature evaluator consumes
  if (row === null || typeof row !== "object" || required.some((field) => !(field in row)) ||
      typeof row.rawTemperatureC !== "number" || !Number.isFinite(row.rawTemperatureC)) {
    throw new TypeError("temperature fit parity row differs");
  }
  return {
    evaluatedAt: row.sourceReceiptAt,
    rawBestMatchTemperatureC: row.rawBestMatchTemperatureC,
    recentErrorState: structuredClone(row.state),
    sourceForecast: {
      adapterVersion: row.adapterVersion,
      dataset: "single_run",
      firstReceivedAt: row.firstReceivedAt,
      modelCycle: row.modelCycle,
      modelLeadHours: row.modelLeadHours,
      providerKey: "open-meteo",
      providerResponseSha256: row.providerResponseSha256,
      rawRelativeHumidityPercent: row.rawRelativeHumidityPercent,
      rawTemperatureC: row.rawTemperatureC,
      rawWindSpeedMps: row.rawWindSpeedMps,
      runInitializedAt: row.runInitializedAt,
      upstreamModel: "ecmwf_ifs",
      validAt: row.validAt,
    },
    validAt: row.validAt,
  };
}

// select one actual best-match archive row and retain its exact provenance
function windFitParityInput(rows) {
  // reject non-array fit material before selecting its forecast class
  if (!Array.isArray(rows)) {
    throw new TypeError("wind fit parity rows differ");
  }
  const row = rows.filter((candidate) => candidate.recordKind === "legacy_v4_retrieval_snapshot")
    .sort((left, right) => left.validAt.localeCompare(right.validAt) ||
      left.contentHashes[0].localeCompare(right.contentHashes[0]))[0];
  // require the exact singleton source lineage retained by the archive projection
  if (row === undefined || !Array.isArray(row.adapterContracts) || row.adapterContracts.length !== 1 ||
      !Array.isArray(row.sourceConfigFingerprints) || row.sourceConfigFingerprints.length !== 1 ||
      !Array.isArray(row.sourceKeys) || row.sourceKeys.length !== 1 ||
      typeof row.metrics?.windSpeedMps !== "number" || !Number.isFinite(row.metrics.windSpeedMps)) {
    throw new TypeError("wind fit parity row differs");
  }
  return {
    evaluatedAt: row.receivedAt,
    metrics: maintenanceParityWindMetrics(row.metrics.windSpeedMps, row.metrics.windGustMps),
    rawForecastProvenance: {
      adapterVersion: row.adapterContracts[0],
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch: row.contractEpoch,
      dataset: row.dataset,
      referenceAt: row.referenceAt,
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: row.sourceConfigFingerprints[0],
      sourceKey: row.sourceKeys[0],
      targetLeadHours: row.targetLeadHours,
      upstreamModel: row.upstreamModel,
      validAt: row.validAt,
    },
  };
}

// identify only the additive closed pre-fit rain feature contract
function isRainFeatureParityInput(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    ["rain-maintenance-feature-parity-input/v1",
      "rain-maintenance-feature-parity-input/v2"].includes(value.contractVersion);
}

// validate the exact fitted feature order and bounded float32-compatible values
function validateRainFeatureParityInput(value, featureNames) {
  const v2 = value?.contractVersion === "rain-maintenance-feature-parity-input/v2";
  requireExactKeys(value, v2
    ? ["contractVersion", "featureNames", "features", "validAt"]
    : ["contractVersion", "featureNames", "features"],
    "rain feature parity input");
  // require the fitted feature order and only finite-or-missing numerical cells
  if (!Array.isArray(featureNames) || featureNames.length !== 107 ||
      !Array.isArray(value.featureNames) ||
      canonicalJsonBytes(value.featureNames) !== canonicalJsonBytes(featureNames) ||
      !Array.isArray(value.features) || value.features.length !== 107 ||
      value.features.some((entry) => entry !== null &&
        (typeof entry !== "number" || !Number.isFinite(entry)))) {
    throw new TypeError("rain feature parity input differs");
  }
  const raw = value.features[5];
  // preserve the frozen raw-amount feature domain
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new TypeError("rain feature parity raw feature differs");
  }
  // bind v2 arm semantics to one exact target clock
  if (v2 && (typeof value.validAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.validAt) ||
      new Date(value.validAt).toISOString() !== value.validAt)) {
    throw new TypeError("rain feature parity validAt differs");
  }
  return {
    features: structuredClone(value.features),
    validAt: v2 ? value.validAt : undefined,
  };
}

// construct the complete metric domain without inventing unused forecast values
function maintenanceParityWindMetrics(windSpeedMps, windGustMps) {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: null,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps,
    windSpeedMps,
  };
}

// preserve explicit missing values while decoding finite binary64 fields
function decodeNullableBinary64(value) {
  return value === null ? null : decodeMaintenanceBinary64(value);
}

// require one exact object key set
function requireExactKeys(value, keys, label) {
  // reject arrays, extension objects and omitted inputs
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} fields differ`);
  }
}

// require one ordinary byte buffer
function requireBuffer(value, label) {
  // reject strings and shared mutable views at the adapter boundary
  if (!Buffer.isBuffer(value) || value.length < 2 || value.length > 8 * 1_024 * 1_024) {
    throw new TypeError(`${label} is invalid`);
  }
  return Buffer.from(value);
}

// require a family with a portable temperature or wind package
function requirePortableFamily(value) {
  // admit only the three independently packaged maintenance families
  if (!new Set(["temperature", "wind", "rain"]).has(value)) {
    throw new TypeError("portable candidate family is invalid");
  }
  return value;
}

// require one policy family
function requirePolicyFamily(value) {
  // prohibit arbitrary policy dispatch
  if (!new Set(["temperature", "wind", "rain"]).has(value)) {
    throw new TypeError("maintenance policy family is invalid");
  }
  return value;
}
