import type { RainAdjustmentRun, RainAdjustmentHour } from "@weather/database";
import { RAIN_HURDLE_WIND_MODEL_SHA256 } from "@weather/forecast-adjustment";

const HOUR_MS = 3_600_000;

export interface ApiRainAdjustmentDecision {
  readonly contractVersion: "forecast-rain-adjustment-decision/v1";
  readonly state: "active" | "disabled" | "raw_fallback";
  readonly reasonCode: string | null;
  readonly bundleSha256: string | null;
  readonly correctedPrecipitationMm: number | null;
  readonly rawBestMatchPrecipitationMm: number | null;
  readonly sourceForecast: null | {
    readonly runInitializedAt: string;
    readonly firstReceivedAt: string;
    readonly validAt: string;
    readonly rawPrecipitationMm: number;
    readonly modelLeadHours: number;
    readonly decisionAt: string;
    readonly upstreamModel: "ecmwf_ifs";
    readonly providerKey: "open-meteo";
  };
}

// validate the entire public-safe snapshot before exposing any adjusted amount
export function validRainAdjustmentRun(run: RainAdjustmentRun | null, now: string): run is RainAdjustmentRun {
  // require the artifact actually shipped with this API image
  if (run === null || run.modelSha256 !== RAIN_HURDLE_WIND_MODEL_SHA256 ||
    !Array.isArray(run.hours) || run.hours.length < 1 || run.hours.length > 23) {
    return false;
  }
  const initialized = Date.parse(run.runInitializedAt);
  const decision = Date.parse(run.decisionAt);
  const received = Date.parse(run.firstReceivedAt);
  const generated = Date.parse(run.generatedAt);
  const time = Date.parse(now);
  // reject future, stale, late and shifted forecast evidence
  if (![initialized, decision, received, generated, time].every(Number.isFinite) ||
    initialized % (6 * HOUR_MS) !== 0 || decision !== initialized + 8 * HOUR_MS ||
    received < initialized || received > decision || decision > time ||
    generated < decision || generated > time || time - decision >= 12 * HOUR_MS) {
    return false;
  }
  const leads = new Set<number>();
  // do not expose a partially malformed or duplicate output projection
  for (const hour of run.hours) {
    // bind finite physical amounts to the same original model lead
    if (hour === null || !Number.isInteger(hour.modelLeadHours) ||
      hour.modelLeadHours < 9 || hour.modelLeadHours > 31 || leads.has(hour.modelLeadHours) ||
      Date.parse(hour.validAt) !== initialized + hour.modelLeadHours * HOUR_MS ||
      !Number.isFinite(hour.rawPrecipitationMm) || hour.rawPrecipitationMm < 0 || hour.rawPrecipitationMm > 2000 ||
      !Number.isFinite(hour.correctedPrecipitationMm) || hour.correctedPrecipitationMm < 0 ||
      typeof hour.applied !== "boolean" ||
      (hour.applied && (hour.correctedPrecipitationMm > 30 || hour.reasonCode !== null)) ||
      (!hour.applied && (hour.correctedPrecipitationMm !== hour.rawPrecipitationMm ||
        typeof hour.reasonCode !== "string" || !/^[a-z_]{1,80}$/u.test(hour.reasonCode)))) {
      return false;
    }
    leads.add(hour.modelLeadHours);
  }
  return true;
}

// retain ordinary raw forecasts whenever source or model evidence is unavailable
export function rainAdjustmentDecision(
  run: RainAdjustmentRun | null,
  validAt: string,
  rawBestMatchPrecipitationMm: number | null,
  now: string,
): ApiRainAdjustmentDecision {
  const valid = validRainAdjustmentRun(run, now);
  const hour: RainAdjustmentHour | undefined = valid ? run.hours.find((item) => item.validAt === validAt) : undefined;
  const active = hour?.applied === true && rawBestMatchPrecipitationMm !== null &&
    Number.isFinite(rawBestMatchPrecipitationMm) && rawBestMatchPrecipitationMm >= 0;
  return {
    contractVersion: "forecast-rain-adjustment-decision/v1",
    state: active ? "active" : valid ? "raw_fallback" : "disabled",
    reasonCode: active ? null : !valid ? "model_unavailable" : hour?.reasonCode ?? "outside_operational_window",
    bundleSha256: valid ? run.modelSha256 : null,
    correctedPrecipitationMm: active ? hour!.correctedPrecipitationMm : null,
    rawBestMatchPrecipitationMm,
    sourceForecast: active ? {
      runInitializedAt: run!.runInitializedAt, firstReceivedAt: run!.firstReceivedAt,
      validAt, rawPrecipitationMm: hour!.rawPrecipitationMm, modelLeadHours: hour!.modelLeadHours,
      decisionAt: run!.decisionAt, upstreamModel: "ecmwf_ifs", providerKey: "open-meteo",
    } : null,
  };
}

// expose bounded availability while keeping station observations and inputs private
export function rainAdjustmentRuntime(run: RainAdjustmentRun | null, now: string) {
  const active = validRainAdjustmentRun(run, now) && run.hours.some((hour) => hour.applied);
  return {
    state: active ? "active" : "disabled",
    activeBundle: active ? run!.modelSha256 : null,
    reasonCode: active ? null : "model_unavailable",
    loadedAt: now,
    source: active ? {
      runInitializedAt: run!.runInitializedAt, firstReceivedAt: run!.firstReceivedAt,
      decisionAt: run!.decisionAt, hourCount: run!.hours.filter((hour) => hour.applied).length,
    } : null,
  };
}
