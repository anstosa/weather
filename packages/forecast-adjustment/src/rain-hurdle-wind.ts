import { createHash } from "node:crypto";

import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
  RAIN_HURDLE_WIND_ARTIFACT_SHA256,
} from "./rain-hurdle-wind-artifact.js";

export const RAIN_HURDLE_WIND_RUNTIME_VERSION = "rain-hurdle-wind-runtime/v1" as const;
export const RAIN_HURDLE_WIND_MODEL_SHA256 = RAIN_HURDLE_WIND_ARTIFACT_SHA256;

const STATION_IDS = RAIN_COLLECTION_STATIONS.map((station) => station.locationId);
const DECISION_DELAY_HOURS = RAIN_COLLECTION_POLICY.decisionDelayHours;
const HOUR_MS = 3_600_000;
const THRESHOLDS = [0.1, 1, 2.5] as const;

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

interface RainArtifact {
  readonly contractVersion: typeof RAIN_HURDLE_WIND_RUNTIME_VERSION;
  readonly modelMonth: "2026-08";
  readonly featureNames: readonly string[];
  readonly rules: readonly { readonly threshold: number; readonly cutoff: number | null }[];
  readonly categoryScales: readonly number[];
  readonly heads: Readonly<Record<"0.1" | "1.0" | "2.5" | "amount", NativeHead>>;
}

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
  readonly modelSha256: typeof RAIN_HURDLE_WIND_MODEL_SHA256;
  readonly modelMonth: "2026-08";
  readonly decisionAt: string;
  readonly hours: readonly RainWindPredictionHour[];
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
function loadArtifact(): RainArtifact {
  const digest = createHash("sha256").update(RAIN_HURDLE_WIND_ARTIFACT_JSON).digest("hex");
  if (digest !== RAIN_HURDLE_WIND_ARTIFACT_SHA256) {
    throw new RangeError("rain model artifact digest mismatch");
  }
  const artifact = JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON) as RainArtifact;
  if (
    artifact.contractVersion !== RAIN_HURDLE_WIND_RUNTIME_VERSION ||
    artifact.modelMonth !== "2026-08" ||
    artifact.featureNames.length !== 107 ||
    artifact.rules.length !== 3 ||
    artifact.categoryScales.length !== 3
  ) {
    throw new RangeError("rain model artifact schema mismatch");
  }
  // reject malformed trees before any served inference
  for (const name of ["0.1", "1.0", "2.5", "amount"] as const) {
    const head = artifact.heads[name];
    if (
      !head || head.trees.length !== 160 ||
      head.objective !== (name === "amount" ? "reg:gamma" : "binary:logistic") ||
      !Number.isFinite(head.baseScore) || head.baseScore <= 0 ||
      (name !== "amount" && head.baseScore >= 1)
    ) {
      throw new RangeError("rain model head schema mismatch");
    }
    // check every tree has only bounded numerical split paths
    for (const tree of head.trees) {
      const length = tree[0].length;
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

// project frozen event rules, raw blend and category-specific amount scales
export function predictRainHurdleWindFeatures(features: Float32Array): number {
  if (features.length !== 107 || features.some((value) => value === Infinity || value === -Infinity)) {
    throw new RangeError("rain model feature vector invalid");
  }
  const raw = features[5] ?? Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) {
    throw new RangeError("rain model raw amount invalid");
  }
  const scores = [
    scoreHead(ARTIFACT.heads["0.1"], features),
    scoreHead(ARTIFACT.heads["1.0"], features),
    scoreHead(ARTIFACT.heads["2.5"], features),
  ];
  let category = 0;
  // highest called event wins exactly as the frozen native hurdle
  for (let index = 0; index < THRESHOLDS.length; index += 1) {
    const cutoff = ARTIFACT.rules[index]?.cutoff;
    const score = scores[index] ?? Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new RangeError("rain model event probability invalid");
    }
    if (cutoff === null ? raw >= THRESHOLDS[index]! : score >= (cutoff ?? Number.NaN)) {
      category = index + 1;
    }
  }
  if (category === 0) {
    return 0;
  }
  const amount = Math.min(30, Math.max(0.1, scoreHead(ARTIFACT.heads.amount, features)));
  const base = Math.min(30, Math.max(0, 0.25 * raw + 0.75 * amount));
  const scaled = base * (ARTIFACT.categoryScales[category - 1] ?? Number.NaN);
  const lower = THRESHOLDS[category - 1] ?? Number.NaN;
  const upper = category === 1 ? 1 - Number.EPSILON / 2 : category === 2 ? 2.5 - Number.EPSILON : 30;
  const projected = Math.min(upper, Math.max(lower, scaled));
  if (!Number.isFinite(projected) || projected < 0 || projected > 30) {
    throw new RangeError("rain model amount projection invalid");
  }
  return projected;
}

// serve only first-day hours known at the fixed causal decision time
export function predictRainHurdleWind(input: RainWindPredictionInput): RainWindPredictionResult {
  const nowMs = Date.parse(input.nowUtc);
  const initializedMs = exactHour(input.currentRun.runInitializedAt);
  const decisionMs = initializedMs + DECISION_DELAY_HOURS * HOUR_MS;
  if (!Number.isFinite(nowMs) || decisionMs > nowMs) {
    throw new RangeError("rain runtime decision has not matured");
  }
  const current = prepareRun(input.currentRun, decisionMs);
  const prior = new Map<number, PreparedRun>();
  for (const run of input.priorRuns) {
    const prepared = prepareRun(run, decisionMs);
    if (
      prepared.initializedMs >= initializedMs ||
      ![6, 12].includes((initializedMs - prepared.initializedMs) / HOUR_MS) ||
      prior.has(prepared.initializedMs)
    ) {
      throw new RangeError("rain runtime prior cycle invalid");
    }
    prior.set(prepared.initializedMs, prepared);
  }
  const stations = prepareStations(input.stationHours, decisionMs);
  const hours: RainWindPredictionHour[] = [];
  // forecast leads 9–31 are the only trained output scope
  for (let modelLeadHours = 1; modelLeadHours <= 23; modelLeadHours += 1) {
    const sourceLead = DECISION_DELAY_HOURS + modelLeadHours;
    const raw = source(current, sourceLead, "precipitationMm");
    const temperature = source(current, sourceLead, "temperatureC");
    if (!Number.isFinite(raw) || raw < 0 || !Number.isFinite(temperature)) {
      throw new RangeError("rain runtime current source amount or temperature invalid");
    }
    const validAt = new Date(initializedMs + sourceLead * HOUR_MS).toISOString();
    if (temperature <= 2) {
      hours.push({ validAt, modelLeadHours: sourceLead, rawPrecipitationMm: raw, correctedPrecipitationMm: raw, applied: false, reasonCode: "phase_unsupported" });
      continue;
    }
    try {
      const features = buildRainHurdleWindFeatures(current, prior, stations, modelLeadHours);
      const corrected = predictRainHurdleWindFeatures(features);
      hours.push({ validAt, modelLeadHours: sourceLead, rawPrecipitationMm: raw, correctedPrecipitationMm: corrected, applied: true, reasonCode: null });
    } catch {
      hours.push({ validAt, modelLeadHours: sourceLead, rawPrecipitationMm: raw, correctedPrecipitationMm: raw, applied: false, reasonCode: "prediction_invalid" });
    }
  }
  return {
    modelSha256: RAIN_HURDLE_WIND_MODEL_SHA256,
    modelMonth: ARTIFACT.modelMonth,
    decisionAt: new Date(decisionMs).toISOString(),
    hours,
  };
}
