import { createHash } from "node:crypto";

import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
  RAIN_HURDLE_WIND_ARTIFACT_SHA256,
} from "./rain-hurdle-wind-artifact.js";
import { localCalendarFeaturesFor } from "./calendar.js";

export const RAIN_HURDLE_WIND_RUNTIME_VERSION = "rain-hurdle-wind-runtime/v1" as const;
export const RAIN_HURDLE_WIND_RUNTIME_V2_VERSION = "rain-hurdle-wind-runtime/v2" as const;
export const RAIN_HURDLE_WIND_MODEL_SHA256 = RAIN_HURDLE_WIND_ARTIFACT_SHA256;
export const RAIN_HURDLE_WIND_PROJECTION_IDS = [
  "R0_exact_refit",
  "R1_winter_scale_0_90",
  "R2_winter_scale_0_95",
  "R3_spring_wet_logit_plus_0_20",
  "R4_summer_wet_logit_plus_0_20",
  "R5_nested_cumulative_min",
  "R6_heavy_raw_blend_0_25",
] as const;

const STATION_IDS = RAIN_COLLECTION_STATIONS.map((station) => station.locationId);
const DECISION_DELAY_HOURS = RAIN_COLLECTION_POLICY.decisionDelayHours;
const HOUR_MS = 3_600_000;
const THRESHOLDS = [0.1, 1, 2.5] as const;
const PUBLIC_ARTIFACT_V1_KEYS = ["categoryScales", "contractVersion", "featureNames", "heads", "modelMonth", "rules"] as const;
const PUBLIC_ARTIFACT_V2_KEYS = [...PUBLIC_ARTIFACT_V1_KEYS, "projectionId"] as const;
const LEGACY_ACTIVE_ARTIFACT_KEYS = [...PUBLIC_ARTIFACT_V1_KEYS, "nativeModelSha256", "provenanceSha256"] as const;
export const RAIN_HURDLE_WIND_FEATURE_NAMES_SHA256 =
  "6c8be26782bae556a152aa83ecf2f9dec2089561a635a20d6510f16a979a3650" as const;

type Tree = readonly [
  readonly number[],
  readonly number[],
  readonly number[],
  readonly number[],
  readonly number[],
];

interface NativeHead {
  readonly objective: "binary:logistic" | "reg:gamma";
  readonly baseScore: number;
  readonly trees: readonly Tree[];
}

export type RainHurdleWindProjectionId = typeof RAIN_HURDLE_WIND_PROJECTION_IDS[number];

export interface RainHurdleWindPortableArtifactV1 {
  readonly contractVersion: typeof RAIN_HURDLE_WIND_RUNTIME_VERSION;
  readonly modelMonth: `${number}-${number}`;
  readonly featureNames: readonly string[];
  readonly rules: readonly { readonly threshold: number; readonly cutoff: number | null }[];
  readonly categoryScales: readonly number[];
  readonly heads: Readonly<Record<"0.1" | "1.0" | "2.5" | "amount", NativeHead>>;
}

export interface RainHurdleWindPortableArtifactV2
  extends Omit<RainHurdleWindPortableArtifactV1, "contractVersion"> {
  readonly contractVersion: typeof RAIN_HURDLE_WIND_RUNTIME_V2_VERSION;
  readonly projectionId: RainHurdleWindProjectionId;
}

export type RainHurdleWindPortableArtifact =
  | RainHurdleWindPortableArtifactV1
  | RainHurdleWindPortableArtifactV2;

export interface RainWindForecastHour {
  readonly leadHours: number;
  readonly precipitationMm: number | null;
  readonly temperatureC: number | null;
  readonly relativeHumidityPercent: number | null;
  readonly cloudCoverPercent: number | null;
  readonly pressureHpa: number | null;
  readonly windSpeedMps: number | null;
  readonly windDirectionDegrees: number | null;
}

export interface RainWindRunProfile {
  readonly runInitializedAt: string;
  readonly completedAt: string;
  readonly hours: readonly RainWindForecastHour[];
}

export interface RainWindStationHour {
  readonly hourAt: string;
  readonly receivedAt: string;
  readonly stationId: number;
  readonly precipitationMm: number | null;
  readonly temperatureC: number | null;
}

export interface RainWindPredictionInput {
  readonly currentRun: RainWindRunProfile;
  readonly priorRuns: readonly RainWindRunProfile[];
  readonly stationHours: readonly RainWindStationHour[];
  readonly nowUtc: string;
}

export interface RainWindPredictionHour {
  readonly validAt: string;
  readonly modelLeadHours: number;
  readonly rawPrecipitationMm: number;
  readonly correctedPrecipitationMm: number;
  readonly applied: boolean;
  readonly reasonCode: "phase_unsupported" | "prediction_invalid" | null;
}

export interface RainWindPredictionResult {
  readonly modelSha256: string;
  readonly modelMonth: `${number}-${number}`;
  readonly decisionAt: string;
  readonly hours: readonly RainWindPredictionHour[];
}

export interface RainHurdleWindFeaturePerformance {
  readonly correctedPrecipitationMm: number;
  readonly occurrenceProbabilityAtLeast0_1: number;
  readonly occurrenceProbabilityAtLeast1_0: number;
  readonly occurrenceProbabilityAtLeast2_5: number;
  readonly positiveAmountMm: number;
}

export interface RainWindPerformanceHour extends RainWindPredictionHour {
  readonly occurrenceProbabilities: {
    readonly atLeast0_1: number;
    readonly atLeast1_0: number;
    readonly atLeast2_5: number;
  } | null;
  readonly positiveAmountMm: number | null;
}

export interface RainWindPerformanceResult
  extends Omit<RainWindPredictionResult, "hours"> {
  readonly hours: readonly RainWindPerformanceHour[];
}

// retain exact pre-fit feature vectors before any candidate exists
export interface RainHurdleWindFeatureRow {
  readonly features: Float32Array;
  readonly modelLeadHours: number;
  readonly rawPrecipitationMm: number;
  readonly rawTargetHourTemperatureC: number;
  readonly validAt: string;
}

export interface RainHurdleWindFeatureProjection {
  readonly decisionAt: string;
  readonly rows: readonly RainHurdleWindFeatureRow[];
  readonly runInitializedAt: string;
}

interface PreparedRun {
  readonly initializedMs: number;
  readonly completedMs: number;
  readonly hours: readonly RainWindForecastHour[];
}

interface StationObservation {
  readonly precipitationMm: number;
  readonly temperatureC: number;
}

// bind the generated numerical trees to their frozen source digest
function loadArtifact(): RainHurdleWindPortableArtifact {
  const parsed = parseRainHurdleWindArtifact(
    RAIN_HURDLE_WIND_ARTIFACT_JSON,
    RAIN_HURDLE_WIND_ARTIFACT_SHA256,
  );
  // admit legacy provenance or one generated public serving artifact
  if (!exactObjectKeys(parsed, LEGACY_ACTIVE_ARTIFACT_KEYS) &&
      !exactObjectKeys(parsed, PUBLIC_ARTIFACT_V1_KEYS) &&
      !exactObjectKeys(parsed, PUBLIC_ARTIFACT_V2_KEYS)) {
    throw new RangeError("rain model incumbent artifact schema mismatch");
  }
  return validateRainHurdleWindArtifactShape(parsed);
}

// validate one exact public portable rain runtime artifact
export function validateRainHurdleWindPortableArtifact(
  artifactJson: string,
  expectedSha256: string,
): RainHurdleWindPortableArtifact {
  const parsed = parseRainHurdleWindArtifact(artifactJson, expectedSha256);
  // require one closed public runtime schema
  if (parsed.contractVersion === RAIN_HURDLE_WIND_RUNTIME_VERSION
    ? !exactObjectKeys(parsed, PUBLIC_ARTIFACT_V1_KEYS)
    : !exactObjectKeys(parsed, PUBLIC_ARTIFACT_V2_KEYS)) {
    throw new RangeError("rain model artifact schema mismatch");
  }
  return validateRainHurdleWindArtifactShape(parsed);
}

// parse one digest-bound plain artifact object
function parseRainHurdleWindArtifact(
  artifactJson: string,
  expectedSha256: string,
): Record<string, unknown> {
  const digest = createHash("sha256").update(artifactJson).digest("hex");
  // bind the exact selected artifact bytes
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256) || digest !== expectedSha256) {
    throw new RangeError("rain model artifact digest mismatch");
  }
  const parsed = JSON.parse(artifactJson) as unknown;
  // reject nonobject roots before schema inspection
  if (!plainRecord(parsed)) {
    throw new RangeError("rain model artifact schema mismatch");
  }
  return parsed;
}

// validate the shared numerical runtime shape after the outer schema closes
function validateRainHurdleWindArtifactShape(
  parsed: Record<string, unknown>,
): RainHurdleWindPortableArtifact {
  // require the frozen feature and output geometry
  if (
    ![RAIN_HURDLE_WIND_RUNTIME_VERSION, RAIN_HURDLE_WIND_RUNTIME_V2_VERSION]
      .includes(parsed.contractVersion as typeof RAIN_HURDLE_WIND_RUNTIME_VERSION) ||
    typeof parsed.modelMonth !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(parsed.modelMonth) ||
    !Array.isArray(parsed.featureNames) || parsed.featureNames.length !== 107 ||
    parsed.featureNames.some((name) => typeof name !== "string") ||
    createHash("sha256").update(JSON.stringify(parsed.featureNames)).digest("hex") !==
      RAIN_HURDLE_WIND_FEATURE_NAMES_SHA256 ||
    !Array.isArray(parsed.rules) || parsed.rules.length !== THRESHOLDS.length ||
    !Array.isArray(parsed.categoryScales) || parsed.categoryScales.length !== THRESHOLDS.length ||
    !plainRecord(parsed.heads) || !exactObjectKeys(parsed.heads, ["0.1", "1.0", "2.5", "amount"])
  ) {
    throw new RangeError("rain model artifact schema mismatch");
  }
  // bind v2 serving bytes to one reviewed selected arm
  if (parsed.contractVersion === RAIN_HURDLE_WIND_RUNTIME_V2_VERSION &&
      !RAIN_HURDLE_WIND_PROJECTION_IDS.includes(parsed.projectionId as RainHurdleWindProjectionId)) {
    throw new RangeError("rain model artifact schema mismatch");
  }
  // close the three trained event rules and amount scales
  for (let index = 0; index < THRESHOLDS.length; index += 1) {
    const rule = parsed.rules[index];
    const scale = parsed.categoryScales[index];
    // reject renamed thresholds, extension fields and nonprobability cutoffs
    if (!plainRecord(rule) || !exactObjectKeys(rule, ["cutoff", "threshold"]) ||
        rule.threshold !== THRESHOLDS[index] ||
        !(rule.cutoff === null || (typeof rule.cutoff === "number" && Number.isFinite(rule.cutoff) &&
          rule.cutoff >= 0 && rule.cutoff <= 1)) ||
        typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
      throw new RangeError("rain model artifact schema mismatch");
    }
  }
  const artifact = parsed as unknown as RainHurdleWindPortableArtifact;
  // reject malformed trees before any served inference
  for (const name of ["0.1", "1.0", "2.5", "amount"] as const) {
    const head = artifact.heads[name];
    // require one closed finite head for each named output
    if (
      !plainRecord(head) || !exactObjectKeys(head, ["baseScore", "objective", "trees"]) ||
      !Array.isArray(head.trees) || head.trees.length !== 160 ||
      head.objective !== (name === "amount" ? "reg:gamma" : "binary:logistic") ||
      !Number.isFinite(head.baseScore) || head.baseScore <= 0 ||
      (name !== "amount" && head.baseScore >= 1)
    ) {
      throw new RangeError("rain model head schema mismatch");
    }
    // check every tree has only bounded numerical split paths
    for (const tree of head.trees) {
      // require the five exact parallel numerical arrays
      if (!Array.isArray(tree) || tree.length !== 5 || tree.some((array) =>
        !Array.isArray(array) || array.some((value) => typeof value !== "number"))) {
        throw new RangeError("rain model tree array mismatch");
      }
      const length = tree[0].length;
      // retain one aligned nonempty topology
      if (length === 0 || tree.some((array) => array.length !== length)) {
        throw new RangeError("rain model tree array mismatch");
      }
      // validate node indices and split values once at load
      for (let node = 0; node < length; node += 1) {
        const left = tree[2][node];
        const right = tree[3][node];
        const feature = tree[0][node];
        const value = tree[1][node];
        const missingLeft = tree[4][node];
        // reject invalid topology and feature indices before traversal
        if (
          left === undefined || right === undefined || feature === undefined ||
          value === undefined || missingLeft === undefined || !Number.isFinite(value) ||
          !Number.isInteger(feature) || feature < 0 || feature >= 107 ||
          ![0, 1].includes(missingLeft) ||
          (left !== -1 && (!Number.isInteger(left) || left <= node || left >= length)) ||
          (right !== -1 && (!Number.isInteger(right) || right <= node || right >= length)) ||
          ((left === -1) !== (right === -1))
        ) {
          throw new RangeError("rain model tree node mismatch");
        }
      }
    }
  }
  return artifact;
}

// narrow one parsed plain object
function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

// compare one object's exact public keys
function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

const ARTIFACT = loadArtifact();

// accept only exact utc-hour identities for causal joins
function exactHour(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed % HOUR_MS !== 0 || new Date(parsed).toISOString() !== value) {
    throw new RangeError("rain runtime expects exact UTC hours");
  }
  return parsed;
}

// reject malformed physical fields while retaining explicit nulls
function field(value: number | null, minimum: number, maximum: number): number {
  if (value === null) {
    return Number.NaN;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError("rain runtime physical field invalid");
  }
  return value;
}

// validate a complete single initialized forecast profile
function prepareRun(run: RainWindRunProfile, decisionMs: number): PreparedRun {
  const initializedMs = exactHour(run.runInitializedAt);
  const completedMs = Date.parse(run.completedAt);
  if (
    !Number.isFinite(completedMs) || completedMs > decisionMs ||
    run.hours.length !== 48 || initializedMs > completedMs
  ) {
    throw new RangeError("rain runtime forecast receipt unavailable at decision");
  }
  // preserve exact one-based native training lead order
  for (let index = 0; index < run.hours.length; index += 1) {
    const hour = run.hours[index];
    if (!hour || hour.leadHours !== index + 1) {
      throw new RangeError("rain runtime forecast lead mismatch");
    }
    field(hour.precipitationMm, 0, 2000);
    field(hour.temperatureC, -100, 70);
    field(hour.relativeHumidityPercent, 0, 100);
    field(hour.cloudCoverPercent, 0, 100);
    field(hour.pressureHpa, 100, 1200);
    field(hour.windSpeedMps, 0, 150);
    field(hour.windDirectionDegrees, 0, 360);
  }
  return { initializedMs, completedMs, hours: run.hours };
}

// bind hourly station values to one physical gauge and receipt time
function prepareStations(rows: readonly RainWindStationHour[], decisionMs: number): Map<number, Map<number, StationObservation>> {
  const stations = new Map<number, Map<number, StationObservation>>();
  for (const row of rows) {
    const hourMs = exactHour(row.hourAt);
    const receivedMs = Date.parse(row.receivedAt);
    if (
      !STATION_IDS.includes(row.stationId as typeof STATION_IDS[number]) ||
      !Number.isFinite(receivedMs) || receivedMs > decisionMs ||
      hourMs > decisionMs - HOUR_MS || hourMs > receivedMs
    ) {
      throw new RangeError("rain runtime station value unavailable at decision");
    }
    const value = {
      precipitationMm: field(row.precipitationMm, 0, 500),
      temperatureC: field(row.temperatureC, -80, 60),
    };
    const byHour = stations.get(hourMs) ?? new Map<number, StationObservation>();
    if (byHour.has(row.stationId)) {
      throw new RangeError("rain runtime duplicate station hour");
    }
    byHour.set(row.stationId, value);
    stations.set(hourMs, byHour);
  }
  return stations;
}

// reconstruct the fixed inverse-distance research weight
function stationWeight(station: typeof RAIN_COLLECTION_STATIONS[number]): number {
  const toRadians = Math.PI / 180;
  const latitude = station.latitude * toRadians;
  const longitude = station.longitude * toRadians;
  const siteLatitude = RAIN_COLLECTION_POLICY.latitude * toRadians;
  const siteLongitude = RAIN_COLLECTION_POLICY.longitude * toRadians;
  const a = Math.sin((latitude - siteLatitude) / 2) ** 2 +
    Math.cos(latitude) * Math.cos(siteLatitude) * Math.sin((longitude - siteLongitude) / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(a));
  return 1 / (1 + (distance / 2000) ** 2);
}

const STATION_WEIGHTS = RAIN_COLLECTION_STATIONS.map(stationWeight);

// retain missing gauges as missing rather than dry
function stationValues(stations: Map<number, Map<number, StationObservation>>, hourMs: number, name: keyof StationObservation): number[] {
  const byHour = stations.get(hourMs);
  return STATION_IDS.map((id) => byHour?.get(id)?.[name] ?? Number.NaN);
}

// match the native weighted network mean, wet fraction and support
function networkSummary(values: readonly number[]): number[] {
  let weightedAmount = 0;
  let weightedWet = 0;
  let weightTotal = 0;
  let maximum = Number.NEGATIVE_INFINITY;
  let support = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const weight = STATION_WEIGHTS[index];
    if (value !== undefined && weight !== undefined && Number.isFinite(value)) {
      weightedAmount += value * weight;
      weightedWet += Number(value >= 0.1) * weight;
      weightTotal += weight;
      maximum = Math.max(maximum, value);
      support += 1;
    }
  }
  return support ? [weightedAmount / weightTotal, weightedWet / weightTotal, maximum, support] : [Number.NaN, Number.NaN, Number.NaN, 0];
}

// match the research network-temperature weighted median support gate
function networkTemperature(values: readonly number[]): number {
  const available = values.flatMap((value, index) => {
    const weight = STATION_WEIGHTS[index];
    const id = STATION_IDS[index];
    return Number.isFinite(value) && weight !== undefined && id !== undefined ? [{ value, weight, id }] : [];
  });
  if (available.length < 3 || ![0, 1, 2].some((index) => Number.isFinite(values[index]))) {
    return Number.NaN;
  }
  available.sort((left, right) => left.value - right.value || left.id - right.id);
  const half = available.reduce((total, item) => total + item.weight, 0) / 2;
  let cumulative = 0;
  for (const item of available) {
    cumulative += item.weight;
    if (cumulative >= half) {
      return item.value;
    }
  }
  return Number.NaN;
}

// preserve NumPy's NaN propagation for incomplete source windows
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// preserve NaN propagation for a source maximum
function maximum(values: readonly number[]): number {
  return values.some((value) => Number.isNaN(value)) ? Number.NaN : Math.max(...values);
}

// extract a native one-based source lead
function source(run: PreparedRun, lead: number, name: keyof RainWindForecastHour): number {
  const row = run.hours[lead - 1];
  if (!row || name === "leadHours") {
    throw new RangeError("rain runtime source lead unavailable");
  }
  const value = row[name];
  return value === null ? Number.NaN : value;
}

// compute meteorological wind-from components at double precision
function windComponents(speed: number, direction: number): readonly [number, number] {
  if (!Number.isFinite(speed) || !Number.isFinite(direction)) {
    return [Number.NaN, Number.NaN];
  }
  const radians = (direction % 360) * Math.PI / 180;
  return [-speed * Math.sin(radians), -speed * Math.cos(radians)];
}

// reproduce the 107 frozen forecast-only and causal station predictors
export function buildRainHurdleWindFeatures(
  current: PreparedRun,
  prior: ReadonlyMap<number, PreparedRun>,
  stations: Map<number, Map<number, StationObservation>>,
  modelLeadHours: number,
): Float32Array {
  if (!Number.isInteger(modelLeadHours) || modelLeadHours < 1 || modelLeadHours > 23) {
    throw new RangeError("rain model lead outside trained scope");
  }
  const lead = DECISION_DELAY_HOURS + modelLeadHours;
  const decisionMs = current.initializedMs + DECISION_DELAY_HOURS * HOUR_MS;
  const validMs = current.initializedMs + lead * HOUR_MS;
  const instant = new Date(validMs);
  const yearStart = Date.UTC(instant.getUTCFullYear(), 0, 1);
  const yearEnd = Date.UTC(instant.getUTCFullYear() + 1, 0, 1);
  const annual = 2 * Math.PI * (validMs - yearStart) / (yearEnd - yearStart);
  const daily = 2 * Math.PI * instant.getUTCHours() / 24;
  const rain = current.hours.map((_, index) => source(current, index + 1, "precipitationMm"));
  const raw = rain[lead - 1];
  const latest = stationValues(stations, decisionMs - HOUR_MS, "precipitationMm");
  const latestMean = networkSummary(latest)[0] ?? Number.NaN;
  const observedTemperature = networkTemperature(stationValues(stations, decisionMs - HOUR_MS, "temperatureC"));
  const result = [
    modelLeadHours, Math.sin(annual), Math.cos(annual), Math.sin(daily), Math.cos(daily),
    raw, Math.log1p(raw ?? Number.NaN), mean(rain.slice(lead - 2, lead + 1)),
    maximum(rain.slice(lead - 4, lead + 3)),
    rain.slice(lead - 1, lead + 5).reduce((sum, value) => sum + value, 0),
    rain.slice(8, 32).reduce((sum, value) => sum + value, 0),
    source(current, lead, "temperatureC"), source(current, lead, "relativeHumidityPercent"),
    source(current, lead, "windSpeedMps"), source(current, lead, "cloudCoverPercent"),
    observedTemperature, latestMean - (rain[6] ?? Number.NaN),
  ];
  // keep six decision-time lag windows in the frozen station order
  for (const lag of [1, 2, 3, 6, 12, 24]) {
    result.push(...networkSummary(stationValues(stations, decisionMs - lag * HOUR_MS, "precipitationMm")));
  }
  // retain each physical station's three native rain lags
  for (const lag of [1, 3, 6]) {
    result.push(...stationValues(stations, decisionMs - lag * HOUR_MS, "precipitationMm"));
  }
  const pressure = current.hours.map((_, index) => source(current, index + 1, "pressureHpa"));
  const p = pressure[lead - 1] ?? Number.NaN;
  result.push(
    p, p - (pressure[lead - 4] ?? Number.NaN), p - (pressure[lead - 7] ?? Number.NaN),
    (pressure[lead + 5] ?? Number.NaN) - p,
    maximum(pressure.slice(lead - 4, lead + 3)) - Math.min(...pressure.slice(lead - 4, lead + 3)),
    p - (pressure[6] ?? Number.NaN),
  );
  const previous: number[] = [];
  const means: number[] = [];
  // never substitute later or unreceived forecast cycles
  for (const lag of [6, 12]) {
    const older = prior.get(current.initializedMs - lag * HOUR_MS);
    const oldLead = lead + lag;
    previous.push(older ? source(older, oldLead, "precipitationMm") : Number.NaN);
    means.push(older ? mean([
      source(older, oldLead - 1, "precipitationMm"),
      source(older, oldLead, "precipitationMm"),
      source(older, oldLead + 1, "precipitationMm"),
    ]) : Number.NaN);
  }
  const vintages = [raw ?? Number.NaN, ...previous].filter(Number.isFinite);
  const vintageMean = mean(vintages);
  const vintageVariance = mean(vintages.map((value) => (value - vintageMean) ** 2));
  result.push(
    ...previous, (raw ?? Number.NaN) - (previous[0] ?? Number.NaN),
    (raw ?? Number.NaN) - (previous[1] ?? Number.NaN), ...means,
    vintageMean, Math.sqrt(vintageVariance), maximum(vintages) - Math.min(...vintages),
    mean(vintages.map((value) => Number(value >= 0.1))),
    mean(vintages.map((value) => Number(value >= 1))), vintages.length,
  );
  // calculate six same-initialization scalar tendencies
  for (const name of ["relativeHumidityPercent", "cloudCoverPercent", "windSpeedMps"] as const) {
    const currentValue = source(current, lead, name);
    result.push(
      currentValue - source(current, lead - 3, name),
      source(current, lead + 3, name) - currentValue,
    );
  }
  const wind = (offset: number) => windComponents(
    source(current, lead + offset, "windSpeedMps"),
    source(current, lead + offset, "windDirectionDegrees"),
  );
  const past = wind(-3);
  const at = wind(0);
  const future = wind(3);
  result.push(
    at[0], at[1], at[0] - past[0], at[1] - past[1],
    future[0] - at[0], future[1] - at[1],
  );
  if (result.length !== ARTIFACT.featureNames.length || result.some((value) => value === undefined || value === Infinity || value === -Infinity)) {
    throw new RangeError("rain feature schema invalid");
  }
  return Float32Array.from(result);
}

// traverse numerical XGBoost trees with their native missing branches
function scoreHead(head: NativeHead, features: Float32Array): number {
  let margin = head.objective === "binary:logistic"
    ? Math.log(head.baseScore / (1 - head.baseScore))
    : Math.log(head.baseScore);
  for (const tree of head.trees) {
    let node = 0;
    // finite acyclic topology was checked at artifact load
    while ((tree[2][node] ?? -1) !== -1) {
      const featureIndex = tree[0][node] ?? 0;
      const value = features[featureIndex] ?? Number.NaN;
      // compare against the native float32 split threshold
      const goLeft = Number.isNaN(value) ? tree[4][node] === 1 : value < Math.fround(tree[1][node] ?? Number.NaN);
      node = goLeft ? (tree[2][node] ?? -1) : (tree[3][node] ?? -1);
    }
    margin += tree[1][node] ?? Number.NaN;
  }
  const prediction = head.objective === "binary:logistic"
    ? 1 / (1 + Math.exp(-margin))
    : Math.exp(margin);
  return Math.fround(prediction);
}

// project the frozen amount and only the three named binary probabilities
export function predictRainHurdleWindFeaturesWithProbabilities(
  features: Float32Array,
): RainHurdleWindFeaturePerformance {
  return predictRainHurdleWindFeaturesWithArtifact(ARTIFACT, features);
}

// create a test and packaging evaluator from independently validated artifact bytes
export function createRainHurdleWindPortableArtifactEvaluator(
  artifactJson: string,
  expectedSha256: string,
): (features: Float32Array, validAt?: string) => RainHurdleWindFeaturePerformance {
  const artifact = validateRainHurdleWindPortableArtifact(artifactJson, expectedSha256);
  return (
    // retain one exact validated artifact across repeated parity rows
    (features, validAt) => predictRainHurdleWindFeaturesWithArtifact(artifact, features, validAt)
  );
}

// create a complete performance evaluator from one inactive public artifact
export function createRainHurdleWindPortablePerformanceEvaluator(
  artifactJson: string,
  expectedSha256: string,
): (input: RainWindPredictionInput) => RainWindPerformanceResult {
  const artifact = validateRainHurdleWindPortableArtifact(artifactJson, expectedSha256);
  return (
    // retain one validated inactive candidate across the complete lead body
    (input) => predictRainHurdleWindPerformanceWithArtifact(input, artifact, expectedSha256)
  );
}

// evaluate one feature vector against an explicit already-validated artifact
function predictRainHurdleWindFeaturesWithArtifact(
  artifact: RainHurdleWindPortableArtifact,
  features: Float32Array,
  validAt?: string,
): RainHurdleWindFeaturePerformance {
  if (features.length !== 107 || features.some((value) => value === Infinity || value === -Infinity)) {
    throw new RangeError("rain model feature vector invalid");
  }
  const raw = features[5] ?? Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) {
    throw new RangeError("rain model raw amount invalid");
  }
  const nativeScores = [
    scoreHead(artifact.heads["0.1"], features),
    scoreHead(artifact.heads["1.0"], features),
    scoreHead(artifact.heads["2.5"], features),
  ];
  const scores = artifact.contractVersion === RAIN_HURDLE_WIND_RUNTIME_V2_VERSION
    ? projectRainOccurrenceProbabilities(nativeScores, artifact.projectionId, validAt)
    : nativeScores;
  let category = 0;
  // highest called event wins exactly as the frozen native hurdle
  for (let index = 0; index < THRESHOLDS.length; index += 1) {
    const cutoff = artifact.rules[index]?.cutoff;
    const score = scores[index] ?? Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new RangeError("rain model event probability invalid");
    }
    if (cutoff === null ? raw >= THRESHOLDS[index]! : score >= (cutoff ?? Number.NaN)) {
      category = index + 1;
    }
  }
  const probabilities = {
    occurrenceProbabilityAtLeast0_1: scores[0]!,
    occurrenceProbabilityAtLeast1_0: scores[1]!,
    occurrenceProbabilityAtLeast2_5: scores[2]!,
  };
  const positiveAmountMm = Math.min(30, Math.max(0.1, scoreHead(artifact.heads.amount, features)));
  // apply the v2 wet-call floor even when no learned category was called
  if (category === 0) {
    const correctedPrecipitationMm = artifact.contractVersion === RAIN_HURDLE_WIND_RUNTIME_V2_VERSION
      ? applyRainSelectedProjection(raw, 0, artifact.projectionId, validAt)
      : 0;
    return { correctedPrecipitationMm, positiveAmountMm, ...probabilities };
  }
  const base = Math.min(30, Math.max(0, 0.25 * raw + 0.75 * positiveAmountMm));
  const scaled = base * (artifact.categoryScales[category - 1] ?? Number.NaN);
  const lower = THRESHOLDS[category - 1] ?? Number.NaN;
  const upper = category === 1 ? 1 - Number.EPSILON / 2 : category === 2 ? 2.5 - Number.EPSILON : 30;
  const projected = Math.min(upper, Math.max(lower, scaled));
  if (!Number.isFinite(projected) || projected < 0 || projected > 30) {
    throw new RangeError("rain model amount projection invalid");
  }
  const correctedPrecipitationMm = artifact.contractVersion === RAIN_HURDLE_WIND_RUNTIME_V2_VERSION
    ? applyRainSelectedProjection(raw, projected, artifact.projectionId, validAt)
    : projected;
  return { correctedPrecipitationMm, positiveAmountMm, ...probabilities };
}

// apply one reviewed occurrence-head arm before category selection
function projectRainOccurrenceProbabilities(
  scores: readonly number[],
  projectionId: RainHurdleWindProjectionId,
  validAt: string | undefined,
): number[] {
  const projected = [...scores];
  const month = rainProjectionMonth(validAt);
  const seasonalMonths = projectionId === "R3_spring_wet_logit_plus_0_20"
    ? [3, 4, 5]
    : projectionId === "R4_summer_wet_logit_plus_0_20" ? [6, 7, 8] : [];
  // adjust only the selected seasonal wet head
  if (seasonalMonths.includes(month)) {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, projected[0] ?? Number.NaN));
    projected[0] = Math.fround(1 / (1 + Math.exp(-(Math.log(probability / (1 - probability)) + 0.20))));
  }
  // enforce nesting only for its independent arm
  if (projectionId === "R5_nested_cumulative_min") {
    for (let index = 1; index < projected.length; index += 1) {
      projected[index] = Math.min(projected[index - 1] ?? Number.NaN,
        projected[index] ?? Number.NaN);
    }
  }
  return projected;
}

// apply post-calibration arm behavior and the original event guard
function applyRainSelectedProjection(
  raw: number,
  calibrated: number,
  projectionId: RainHurdleWindProjectionId,
  validAt: string | undefined,
): number {
  const month = rainProjectionMonth(validAt);
  let projected = calibrated;
  // scale only winter hours in the selected scale arm
  if ([12, 1, 2].includes(month) &&
      ["R1_winter_scale_0_90", "R2_winter_scale_0_95"].includes(projectionId)) {
    projected *= projectionId === "R1_winter_scale_0_90" ? 0.90 : 0.95;
  }
  // preserve the preregistered heavy blend before the overriding safety guard
  if (projectionId === "R6_heavy_raw_blend_0_25" && raw >= 1) {
    projected = 0.25 * raw + 0.75 * projected;
  }
  // preserve raw heavy amounts and every raw wet call
  if (raw >= 1) {
    return raw;
  }
  return raw >= 0.1 ? Math.max(0.1, projected) : projected;
}

// derive the same local month used by the native grid screen
function rainProjectionMonth(validAt: string | undefined): number {
  // require a real target clock for every v2 arm, including nonseasonal arms
  if (validAt === undefined ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(validAt) ||
      new Date(validAt).toISOString() !== validAt) {
    throw new RangeError("rain model v2 validAt is required");
  }
  return localCalendarFeaturesFor(validAt).month;
}

// retain the serving amount-only feature interface
export function predictRainHurdleWindFeatures(features: Float32Array): number {
  return predictRainHurdleWindFeaturesWithProbabilities(features)
    .correctedPrecipitationMm;
}

// replay first-day hours and retain named probabilities only on applied rows
export function predictRainHurdleWindPerformance(
  input: RainWindPredictionInput,
): RainWindPerformanceResult {
  return predictRainHurdleWindPerformanceWithArtifact(
    input,
    ARTIFACT,
    RAIN_HURDLE_WIND_MODEL_SHA256,
  );
}

// replay one complete source body against an explicit validated artifact
function predictRainHurdleWindPerformanceWithArtifact(
  input: RainWindPredictionInput,
  artifact: RainHurdleWindPortableArtifact,
  modelSha256: string,
): RainWindPerformanceResult {
  return replayRainHurdleWindNativeParityPerformance(
    input,
    modelSha256,
    artifact.modelMonth,
    (features, validAt) => predictRainHurdleWindFeaturesWithArtifact(artifact, features, validAt),
  );
}

// project the actual serving feature builder before candidate selection
export function projectRainHurdleWindFeatures(
  input: RainWindPredictionInput,
): RainHurdleWindFeatureProjection {
  const nowMs = Date.parse(input.nowUtc);
  const initializedMs = exactHour(input.currentRun.runInitializedAt);
  const decisionMs = initializedMs + DECISION_DELAY_HOURS * HOUR_MS;
  // refuse future or normalized decision inputs before preparing causal members
  if (!Number.isFinite(nowMs) || decisionMs > nowMs) {
    throw new RangeError("rain runtime decision has not matured");
  }
  const current = prepareRun(input.currentRun, decisionMs);
  const prior = new Map<number, PreparedRun>();
  // retain only the exact earlier 6h and 12h model cycles
  for (const run of input.priorRuns) {
    const prepared = prepareRun(run, decisionMs);
    if (prepared.initializedMs >= initializedMs ||
        ![6, 12].includes((initializedMs - prepared.initializedMs) / HOUR_MS) ||
        prior.has(prepared.initializedMs)) {
      throw new RangeError("rain runtime prior cycle invalid");
    }
    prior.set(prepared.initializedMs, prepared);
  }
  const stations = prepareStations(input.stationHours, decisionMs);
  const rows: RainHurdleWindFeatureRow[] = [];
  // preserve all 23 fitted output leads, including phase-ineligible targets
  for (let modelLeadHours = 1; modelLeadHours <= 23; modelLeadHours += 1) {
    const sourceLead = DECISION_DELAY_HOURS + modelLeadHours;
    const raw = source(current, sourceLead, "precipitationMm");
    const temperature = source(current, sourceLead, "temperatureC");
    // require actual source values before producing a fit row
    if (!Number.isFinite(raw) || raw < 0 || !Number.isFinite(temperature)) {
      throw new RangeError("rain runtime current source amount or temperature invalid");
    }
    rows.push({
      features: buildRainHurdleWindFeatures(current, prior, stations, modelLeadHours),
      modelLeadHours: sourceLead,
      rawPrecipitationMm: raw,
      rawTargetHourTemperatureC: temperature,
      validAt: new Date(initializedMs + sourceLead * HOUR_MS).toISOString(),
    });
  }
  return {
    decisionAt: new Date(decisionMs).toISOString(),
    rows,
    runInitializedAt: input.currentRun.runInitializedAt,
  };
}

// score one already-retained native feature projection with the compiled artifact
export function predictRainHurdleWindFeatureProjection(
  featureProjection: RainHurdleWindFeatureProjection,
): RainWindPerformanceResult {
  return replayRainHurdleWindFeatureProjection(
    featureProjection,
    RAIN_HURDLE_WIND_MODEL_SHA256,
    ARTIFACT.modelMonth,
    (features) => predictRainHurdleWindFeaturesWithArtifact(ARTIFACT, features),
  );
}

// replay complete causal inputs through one independent parity scorer
export function replayRainHurdleWindNativeParityPerformance(
  input: RainWindPredictionInput,
  modelSha256: string,
  modelMonth: `${number}-${number}`,
  evaluateFeatures: (features: Float32Array, validAt: string) => RainHurdleWindFeaturePerformance,
): RainWindPerformanceResult {
  // bind parity output to one concrete portable artifact identity and month
  if (!/^[a-f0-9]{64}$/u.test(modelSha256) || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(modelMonth) ||
      typeof evaluateFeatures !== "function") {
    throw new RangeError("rain parity runtime identity is invalid");
  }
  const featureProjection = projectRainHurdleWindFeatures(input);
  return replayRainHurdleWindFeatureProjection(
    featureProjection, modelSha256, modelMonth, evaluateFeatures,
  );
}

// score one validated feature projection without rebuilding its causal rows
function replayRainHurdleWindFeatureProjection(
  featureProjection: RainHurdleWindFeatureProjection,
  modelSha256: string,
  modelMonth: `${number}-${number}`,
  evaluateFeatures: (features: Float32Array, validAt: string) => RainHurdleWindFeaturePerformance,
): RainWindPerformanceResult {
  // require the fixed fitted geometry before model evaluation
  if (featureProjection.rows.length !== 23 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u.test(featureProjection.decisionAt)) {
    throw new RangeError("rain feature projection geometry is invalid");
  }
  const hours: RainWindPerformanceHour[] = [];
  // forecast leads 9–31 are the only trained output scope
  for (const row of featureProjection.rows) {
    if (row.rawTargetHourTemperatureC <= 2) {
      hours.push({ validAt: row.validAt, modelLeadHours: row.modelLeadHours,
        rawPrecipitationMm: row.rawPrecipitationMm,
        correctedPrecipitationMm: row.rawPrecipitationMm, applied: false,
        reasonCode: "phase_unsupported", occurrenceProbabilities: null,
        positiveAmountMm: null });
      continue;
    }
    try {
      const prediction = evaluateFeatures(row.features, row.validAt);
      hours.push({ validAt: row.validAt, modelLeadHours: row.modelLeadHours,
        rawPrecipitationMm: row.rawPrecipitationMm,
        correctedPrecipitationMm: prediction.correctedPrecipitationMm,
        applied: true, reasonCode: null, occurrenceProbabilities: {
        atLeast0_1: prediction.occurrenceProbabilityAtLeast0_1,
        atLeast1_0: prediction.occurrenceProbabilityAtLeast1_0,
        atLeast2_5: prediction.occurrenceProbabilityAtLeast2_5,
      }, positiveAmountMm: prediction.positiveAmountMm });
    } catch {
      hours.push({ validAt: row.validAt, modelLeadHours: row.modelLeadHours,
        rawPrecipitationMm: row.rawPrecipitationMm,
        correctedPrecipitationMm: row.rawPrecipitationMm, applied: false,
        reasonCode: "prediction_invalid", occurrenceProbabilities: null,
        positiveAmountMm: null });
    }
  }
  return {
    modelSha256,
    modelMonth,
    decisionAt: featureProjection.decisionAt,
    hours,
  };
}

// serve the unchanged amount, applied and reason projection
export function predictRainHurdleWind(
  input: RainWindPredictionInput,
): RainWindPredictionResult {
  const result = predictRainHurdleWindPerformance(input);
  return {
    decisionAt: result.decisionAt,
    hours: result.hours.map((hour) => ({
      applied: hour.applied,
      correctedPrecipitationMm: hour.correctedPrecipitationMm,
      modelLeadHours: hour.modelLeadHours,
      rawPrecipitationMm: hour.rawPrecipitationMm,
      reasonCode: hour.reasonCode,
      validAt: hour.validAt,
    })),
    modelMonth: result.modelMonth,
    modelSha256: result.modelSha256,
  };
}
