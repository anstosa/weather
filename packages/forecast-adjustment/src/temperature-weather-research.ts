import { createHash } from "node:crypto";

import {
  FORECAST_LEAD_BANDS,
  forecastLeadBandFor,
  type ForecastLeadBandKey,
  type ForecastTrainingCohort,
  type JsonValue,
} from "@weather/domain";

import {
  fitCoefficientCell,
  metricPolicyFor,
  type WeightedResidualObservation,
} from "./algorithm-v1.js";
import { canonicalSha256 } from "./candidate.js";
import {
  addLocalCalendarDays,
  localCalendarFeaturesFor,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
} from "./calendar.js";
import {
  analyzeTemperatureLeadResearch,
  scoreTemperatureResearchPredictions,
  TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID,
  TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES,
  TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS,
  type TemperatureLeadResearchScore,
} from "./temperature-lead-research.js";
import {
  createTemperatureNowcastPredictionAudit,
  TEMPERATURE_NOWCAST_HALF_LIFE_HOURS,
  TEMPERATURE_NOWCAST_LOOKBACK_HOURS,
  TEMPERATURE_NOWCAST_MAXIMUM_CORRECTION_C,
  TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS,
  TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS,
  TEMPERATURE_NOWCAST_MINIMUM_CORRECTION_C,
  TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS,
  TEMPERATURE_NOWCAST_PHYSICAL_MAXIMUM_C,
  TEMPERATURE_NOWCAST_PHYSICAL_MINIMUM_C,
  TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS,
  type TemperatureNowcastFallbackReason,
  type TemperatureNowcastPrivateAuditRecord,
  type TemperatureNowcastPredictionAudit,
  type TemperatureNowcastResearchEvent,
} from "./temperature-nowcast-research.js";

// freeze the non-promotable research identity
export const TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-research/v1" as const;

// freeze the non-promotable stage-ablation identity
export const TEMPERATURE_ONLY_RESEARCH_CONTRACT_VERSION =
  "temperature-only-research/v1" as const;

// freeze the non-promotable horizon experiment identities
export const TEMPERATURE_WEATHER_HORIZON_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-horizon-research/v1" as const;
export const TEMPERATURE_WEATHER_HORIZON_GATE_CONTRACT_VERSION =
  "temperature-weather-horizon-gate/v1" as const;
export const TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS = 48 as const;

// freeze the non-promotable causal adaptive identity
export const TEMPERATURE_WEATHER_ADAPTIVE_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-adaptive-research/v1" as const;

// freeze the non-promotable fixed hybrid identity
export const TEMPERATURE_WEATHER_HYBRID_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-hybrid-research/v1" as const;

// freeze the non-promotable weather shrinkage identity
export const TEMPERATURE_WEATHER_SHRINKAGE_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-shrinkage-research/v1" as const;

// freeze the non-promotable recent-training identity
export const TEMPERATURE_WEATHER_RECENCY_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-recency-research/v1" as const;
export const TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES = 365 as const;

// freeze the non-promotable boosted residual identity
export const TEMPERATURE_BOOSTED_RESEARCH_CONTRACT_VERSION =
  "temperature-boosted-residual-research/v1" as const;

// freeze the non-promotable boosted hybrid identity
export const TEMPERATURE_BOOSTED_HYBRID_RESEARCH_CONTRACT_VERSION =
  "temperature-boosted-hybrid-research/v1" as const;

// freeze the non-promotable first-twelve-hour nowcast identity
export const TEMPERATURE_NEAR_NOWCAST_RESEARCH_CONTRACT_VERSION =
  "temperature-near-nowcast-research/v1" as const;

// freeze the continuous and categorical predictor encoding
export const TEMPERATURE_BOOSTED_FEATURE_NAMES = [
  "rawTemperatureC",
  "relativeHumidityPercent",
  "windSpeedMps",
  "targetLeadHours",
  "season_winter",
  "season_spring",
  "season_summer",
  "season_autumn",
  "daypart_night",
  "daypart_morning",
  "daypart_afternoon",
  "daypart_evening",
] as const;

// freeze the scalar cell support policy
export const TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES = 10 as const;
export const TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS = 50 as const;
export const TEMPERATURE_WEATHER_PSEUDOCOUNT = 100 as const;

const MILLISECONDS_PER_HOUR = 3_600_000;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FIXED_ANCHOR_LEADS = new Set([24, 48, 72, 96, 120, 144, 168]);
const STRATEGIES = [
  "raw",
  "calendarBaseline",
  "calendarTemperature",
  "calendarTemperatureWeather",
  "rawTemperatureWeather",
] as const;
const DAYPARTS = [
  "night",
  "morning",
  "afternoon",
  "evening",
] as const satisfies readonly LocalDaypart[];
const HUMIDITY_BINS = ["<50", "[50,80)", ">=80", "missing"] as const;
const WIND_BINS = ["<2", "[2,5)", ">=5", "missing"] as const;

export type TemperatureWeatherStrategy = (typeof STRATEGIES)[number];
export type TemperatureWeatherScoreCohort = Extract<
  ForecastTrainingCohort,
  "fixed_lead_anchor" | "legacy_v4_retrieval_snapshot"
>;
type HumidityBin = (typeof HUMIDITY_BINS)[number];
type WindBin = (typeof WIND_BINS)[number];
type SupportedHumidityBin = Exclude<HumidityBin, "missing">;
type SupportedWindBin = Exclude<WindBin, "missing">;
type ModelPath = "calendar_start" | "raw_start";

// describe one exact retained temperature example
export interface TemperatureWeatherResearchEvent {
  readonly actual: number;
  readonly baselineAdjusted: number;
  readonly baselineEligible: boolean;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string | null;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// compare all frozen strategies on one denominator
export interface TemperatureWeatherResearchComparison {
  readonly calendarBaseline: TemperatureLeadResearchScore;
  readonly calendarTemperature: TemperatureLeadResearchScore;
  readonly calendarTemperatureWeather: TemperatureLeadResearchScore;
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
}

// expose one fitted temperature component without training rows
export interface TemperatureWeatherTemperatureCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: ModelPath;
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly temperatureBin: number;
  readonly temperatureMaximumExclusiveC: number;
  readonly temperatureMinimumC: number;
}

// expose one fitted weather component without training rows
export interface TemperatureWeatherWeatherCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly humidityBin: SupportedHumidityBin;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: ModelPath;
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly windSpeedBin: SupportedWindBin;
}

// describe strategy fallbacks over the retained score denominator
export interface TemperatureWeatherFallbackCoverage {
  readonly baselineIneligibleCount: number;
  readonly baselineEligibleCount: number;
  readonly calendarBaselineAppliedCount: number;
  readonly calendarTemperature: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
  };
  readonly calendarTemperatureWeather: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
  };
  readonly rawTemperatureWeather: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
  };
}

// describe one lead diagnostic
export interface TemperatureWeatherLeadDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly key: string;
  readonly maximumHours: number;
  readonly minimumHours: number;
}

// describe one daypart diagnostic slice
export interface TemperatureWeatherDaypartDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly daypart: LocalDaypart;
}

// describe one local-date diagnostic slice
export interface TemperatureWeatherLocalDateDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly localDate: string;
}

// describe one forecast-temperature diagnostic slice
export interface TemperatureWeatherTemperatureBinDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly temperatureBin: {
    readonly index: number;
    readonly maximumExclusiveC: number;
    readonly minimumC: number;
  };
}

// describe one joint forecast-weather diagnostic slice
export interface TemperatureWeatherRegimeDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly humidityBin: HumidityBin;
  readonly windSpeedBin: WindBin;
}

// report a complete offline weather-conditioning experiment
export interface TemperatureWeatherResearchReport {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION;
  readonly coverage: TemperatureWeatherFallbackCoverage;
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherRegimeDiagnostic[];
  };
  readonly evidenceStatus:
    | "retrospective_comparison_only"
    | "empty_score_cohort"
    | "empty_training_cohort";
  readonly first48Hours: TemperatureWeatherResearchComparison;
  readonly inputCoverage: {
    readonly baselineEligibleEventCount: number;
    readonly eventCount: number;
    readonly localDateCount: number;
    readonly uniqueValidHours: number;
  };
  readonly models: {
    readonly calendarStart: {
      readonly temperature: readonly TemperatureWeatherTemperatureCell[];
      readonly weather: readonly TemperatureWeatherWeatherCell[];
    };
    readonly rawStart: {
      readonly temperature: readonly TemperatureWeatherTemperatureCell[];
      readonly weather: readonly TemperatureWeatherWeatherCell[];
    };
  };
  readonly overall: TemperatureWeatherResearchComparison;
  readonly policy: {
    readonly componentCorrectionMaximumC: 5;
    readonly componentCorrectionMinimumC: -5;
    readonly finalCorrectionMaximumC: 5;
    readonly finalCorrectionMinimumC: -5;
    readonly finalTemperatureMaximumC: 70;
    readonly finalTemperatureMinimumC: -100;
    readonly minimumLocalDates: typeof TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES;
    readonly minimumUniqueValidHours: typeof TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS;
    readonly parentCoefficient: 0;
    readonly pseudocount: typeof TEMPERATURE_WEATHER_PSEUDOCOUNT;
    readonly scoreDenominator: "all_matched_temperature_events";
    readonly scoreInformationBoundary: "live_referenceAt_or_anchor_validAt_minus_targetLeadHours";
    readonly trainingObservationAvailableAt: "validAt_plus_1_hour";
    readonly unsupportedComponent: 0;
    readonly weatherResidualUsesUnclippedPrecedingStages: true;
  };
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly researchOnly: true;
  readonly runtimeBundleCreated: false;
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly trainingCoverage: {
    readonly baselineEligibleEventCount: number;
    readonly eventCount: number;
    readonly localDateCount: number;
    readonly uniqueValidHours: number;
  };
}

// compare the isolated temperature stage with its source strategies
export interface TemperatureOnlyResearchComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureOnly: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
}

// reuse the frozen daypart metadata with the isolated comparison
type TemperatureOnlyDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureOnlyResearchComparison };
// reuse the frozen lead metadata with the isolated comparison
type TemperatureOnlyLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureOnlyResearchComparison };
// reuse the frozen date metadata with the isolated comparison
type TemperatureOnlyLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureOnlyResearchComparison };
// reuse the frozen temperature-bin metadata with the isolated comparison
type TemperatureOnlyTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureOnlyResearchComparison };
// reuse the frozen weather metadata with the isolated comparison
type TemperatureOnlyRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureOnlyResearchComparison };

// expose one isolated raw-start stage without score rows
export interface TemperatureOnlyAblation {
  readonly after48Hours: TemperatureOnlyResearchComparison;
  readonly coverage: {
    readonly eventCount: number;
    readonly baselineIneligibleCount: number;
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly differsFromRawTemperatureWeatherCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureOnlyDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureOnlyLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureOnlyLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureOnlyLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureOnlyTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureOnlyRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureOnlyResearchComparison;
  readonly overall: TemperatureOnlyResearchComparison;
  readonly policy: {
    readonly calendarComponentIncluded: false;
    readonly datesConsumed: true;
    readonly productionActivationAllowed: false;
    readonly promotable: false;
    readonly researchOnly: true;
    readonly selectedAfterExaminingPriorResults: true;
    readonly weatherComponentIncluded: false;
  };
}

// retain v1 evidence while adding one descriptive stage ablation
export type TemperatureOnlyResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_ONLY_RESEARCH_CONTRACT_VERSION;
  readonly temperatureOnly: TemperatureOnlyAblation;
};

// compare the fixed horizon gate on one denominator
export interface TemperatureWeatherHorizonComparison {
  readonly gatedAfter48Hours: TemperatureLeadResearchScore;
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
}

// describe one horizon lead diagnostic
export interface TemperatureWeatherHorizonLeadDiagnostic {
  readonly comparison: TemperatureWeatherHorizonComparison;
  readonly key: string;
  readonly maximumHours: number;
  readonly minimumHours: number;
}

// describe one horizon daypart diagnostic
export interface TemperatureWeatherHorizonDaypartDiagnostic {
  readonly comparison: TemperatureWeatherHorizonComparison;
  readonly daypart: LocalDaypart;
}

// describe one horizon local-date diagnostic
export interface TemperatureWeatherHorizonLocalDateDiagnostic {
  readonly comparison: TemperatureWeatherHorizonComparison;
  readonly localDate: string;
}

// describe one horizon temperature-bin diagnostic
export interface TemperatureWeatherHorizonTemperatureBinDiagnostic {
  readonly comparison: TemperatureWeatherHorizonComparison;
  readonly temperatureBin: {
    readonly index: number;
    readonly maximumExclusiveC: number;
    readonly minimumC: number;
  };
}

// describe one horizon weather-regime diagnostic
export interface TemperatureWeatherHorizonRegimeDiagnostic {
  readonly comparison: TemperatureWeatherHorizonComparison;
  readonly humidityBin: HumidityBin;
  readonly windSpeedBin: WindBin;
}

// expose the fixed horizon ablation without score rows
export interface TemperatureWeatherHorizonGate {
  readonly after48Hours: TemperatureWeatherHorizonComparison;
  readonly contractVersion: typeof TEMPERATURE_WEATHER_HORIZON_GATE_CONTRACT_VERSION;
  readonly coverage: {
    readonly after48BaselineIneligibleCount: number;
    readonly after48EventCount: number;
    readonly after48TemperatureSupportedCount: number;
    readonly after48TemperatureUnsupportedCount: number;
    readonly after48WeatherFeatureMissingCount: number;
    readonly after48WeatherSupportedCount: number;
    readonly after48WeatherUnsupportedCount: number;
    readonly eventCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly rawProtectedEventCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherHorizonDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherHorizonLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherHorizonLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherHorizonLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherHorizonTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherHorizonRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureWeatherHorizonComparison;
  readonly overall: TemperatureWeatherHorizonComparison;
  readonly policy: {
    readonly aboveThresholdStrategy: "rawTemperatureWeather";
    readonly atOrBelowThresholdStrategy: "raw";
    readonly first48RawByConstruction: true;
    readonly productionActivationAllowed: false;
    readonly promotable: false;
    readonly selectedAfterExaminingPriorResults: true;
    readonly thresholdHours: typeof TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS;
  };
}

// retain v1 evidence while adding one descriptive horizon view
export type TemperatureWeatherHorizonResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_HORIZON_RESEARCH_CONTRACT_VERSION;
  readonly horizonGate: TemperatureWeatherHorizonGate;
};

// compare the causal correction with its two source strategies
export interface TemperatureWeatherAdaptiveComparison {
  readonly causalAdaptive: TemperatureLeadResearchScore;
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the adaptive comparison
type TemperatureWeatherAdaptiveDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherAdaptiveComparison };
// reuse one lead diagnostic with the adaptive comparison
type TemperatureWeatherAdaptiveLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherAdaptiveComparison };
// reuse one date diagnostic with the adaptive comparison
type TemperatureWeatherAdaptiveLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherAdaptiveComparison };
// reuse one temperature diagnostic with the adaptive comparison
type TemperatureWeatherAdaptiveTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherAdaptiveComparison };
// reuse one weather diagnostic with the adaptive comparison
type TemperatureWeatherAdaptiveRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherAdaptiveComparison };

type TemperatureWeatherAdaptiveAlpha =
  (typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID)[number];

// describe one aggregate alpha-selection partition
export interface TemperatureWeatherAdaptiveAlphaSelectionCount {
  readonly alpha: TemperatureWeatherAdaptiveAlpha;
  readonly calibratedSelectionCount: number;
  readonly selectionCount: number;
  readonly uncalibratedSelectionCount: number;
}

// freeze the live-only causal calibration policy
export interface TemperatureWeatherAdaptivePolicy {
  readonly alphaGrid: typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID;
  readonly alphaTiePolicy: "prefer_smaller_alpha";
  readonly availabilityEvidenceStatus: "pseudo_real_time_retrospective_not_independently_validated";
  readonly bucketWidthHours: 6;
  readonly datesConsumed: true;
  readonly liveOnly: true;
  readonly minimumPriorLocalDates: typeof TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES;
  readonly minimumPriorUniqueValidHours: typeof TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS;
  readonly noArchiveWarmStart: true;
  readonly observationAvailableAtRule: "validAt_plus_1_hour";
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly researchOnly: true;
  readonly selectedAfterExaminingPriorResults: true;
  readonly sourceStrategy: "rawTemperatureWeather";
  readonly unsupportedAlpha: 0;
}

// expose aggregate live calibration results without causal rows
export interface TemperatureWeatherAdaptiveEvaluatedView {
  readonly after48Hours: TemperatureWeatherAdaptiveComparison;
  readonly calibratedSubset: TemperatureWeatherAdaptiveComparison;
  readonly causalAudit: {
    readonly selectionCount: number;
    readonly violationCount: number;
  };
  readonly coverage: {
    readonly alphaSelectionCounts: readonly TemperatureWeatherAdaptiveAlphaSelectionCount[];
    readonly calibratedEventCount: number;
    readonly eventCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly uncalibratedEventCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherAdaptiveDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherAdaptiveLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherAdaptiveLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherAdaptiveLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherAdaptiveTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherAdaptiveRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureWeatherAdaptiveComparison;
  readonly overall: TemperatureWeatherAdaptiveComparison;
  readonly policy: TemperatureWeatherAdaptivePolicy;
  readonly reason: null;
  readonly status: "empty_live_cohort" | "evaluated";
}

// keep archive controls explicit without fabricating adaptive scores
export interface TemperatureWeatherAdaptiveArchiveView {
  readonly after48Hours: null;
  readonly calibratedSubset: null;
  readonly causalAudit: null;
  readonly coverage: null;
  readonly diagnostics: null;
  readonly first48Hours: null;
  readonly overall: null;
  readonly policy: TemperatureWeatherAdaptivePolicy;
  readonly reason: "archive_has_no_observed_retrieval_time";
  readonly status: "not_applicable_archive_cohort";
}

// retain v1 evidence while adding one causal live-only view
export type TemperatureWeatherAdaptiveResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly adaptiveCorrection:
    | TemperatureWeatherAdaptiveArchiveView
    | TemperatureWeatherAdaptiveEvaluatedView;
  readonly contractVersion: typeof TEMPERATURE_WEATHER_ADAPTIVE_RESEARCH_CONTRACT_VERSION;
};

// compare the fixed hybrid with every inherited source strategy
export interface TemperatureWeatherHybridComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
  readonly causalAdaptive: TemperatureLeadResearchScore;
  readonly gatedAfter48Hours: TemperatureLeadResearchScore;
  readonly hybrid: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the hybrid comparison
type TemperatureWeatherHybridDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherHybridComparison };
// reuse one lead diagnostic with the hybrid comparison
type TemperatureWeatherHybridLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherHybridComparison };
// reuse one date diagnostic with the hybrid comparison
type TemperatureWeatherHybridLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherHybridComparison };
// reuse one temperature diagnostic with the hybrid comparison
type TemperatureWeatherHybridTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherHybridComparison };
// reuse one weather diagnostic with the hybrid comparison
type TemperatureWeatherHybridRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherHybridComparison };

// freeze the fixed hybrid policy
export interface TemperatureWeatherHybridPolicy {
  readonly aboveThresholdStrategy: "rawTemperatureWeather";
  readonly atOrBelowThresholdStrategy: "causalAdaptive";
  readonly calibration: TemperatureWeatherAdaptivePolicy;
  readonly datesConsumed: true;
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly selectedAfterExaminingPriorResults: true;
  readonly thresholdHours: typeof TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS;
}

// expose aggregate live hybrid results without causal rows
export interface TemperatureWeatherHybridEvaluatedView {
  readonly after48Hours: TemperatureWeatherHybridComparison;
  readonly causalAudit: {
    readonly selectionCount: number;
    readonly violationCount: number;
  };
  readonly coverage: {
    readonly eventCount: number;
    readonly first48EventCount: number;
    readonly after48EventCount: number;
    readonly first48CalibratedEventCount: number;
    readonly first48UncalibratedEventCount: number;
    readonly first48NonzeroCorrectionCount: number;
    readonly after48NonzeroCorrectionCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly differsFromGatedAfter48HoursCount: number;
    readonly first48AlphaSelectionCounts: readonly TemperatureWeatherAdaptiveAlphaSelectionCount[];
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherHybridDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherHybridLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherHybridLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherHybridLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherHybridTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherHybridRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureWeatherHybridComparison;
  readonly overall: TemperatureWeatherHybridComparison;
  readonly policy: TemperatureWeatherHybridPolicy;
  readonly reason: null;
  readonly status: "empty_live_cohort" | "evaluated";
}

// keep archive controls explicit without fabricating hybrid scores
export interface TemperatureWeatherHybridArchiveView {
  readonly after48Hours: null;
  readonly causalAudit: null;
  readonly coverage: null;
  readonly diagnostics: null;
  readonly first48Hours: null;
  readonly overall: null;
  readonly policy: TemperatureWeatherHybridPolicy;
  readonly reason: "archive_has_no_observed_retrieval_time";
  readonly status: "not_applicable_archive_cohort";
}

// retain v1 evidence while adding one fixed live-only hybrid
export type TemperatureWeatherHybridResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_HYBRID_RESEARCH_CONTRACT_VERSION;
  readonly hybridCorrection:
    | TemperatureWeatherHybridArchiveView
    | TemperatureWeatherHybridEvaluatedView;
};

// compare the fixed weather shrinkage with both component endpoints
export interface TemperatureWeatherShrinkageComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureOnly: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
  readonly rawTemperatureHalfWeather: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the shrinkage comparison
type TemperatureWeatherShrinkageDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherShrinkageComparison };
// reuse one lead diagnostic with the shrinkage comparison
type TemperatureWeatherShrinkageLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherShrinkageComparison };
// reuse one date diagnostic with the shrinkage comparison
type TemperatureWeatherShrinkageLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherShrinkageComparison };
// reuse one temperature diagnostic with the shrinkage comparison
type TemperatureWeatherShrinkageTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherShrinkageComparison };
// reuse one weather diagnostic with the shrinkage comparison
type TemperatureWeatherShrinkageRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherShrinkageComparison };

// expose one static half-weather view without score rows
export interface TemperatureWeatherShrinkageView {
  readonly after48Hours: TemperatureWeatherShrinkageComparison;
  readonly coverage: {
    readonly eventCount: number;
    readonly baselineIneligibleCount: number;
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly differsFromRawTemperatureOnlyCount: number;
    readonly differsFromRawTemperatureWeatherCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherShrinkageDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherShrinkageLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherShrinkageLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherShrinkageLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherShrinkageTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherShrinkageRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureWeatherShrinkageComparison;
  readonly overall: TemperatureWeatherShrinkageComparison;
  readonly policy: {
    readonly allLeadHours: true;
    readonly calendarComponentIncluded: false;
    readonly datesConsumed: true;
    readonly noAdaptiveCalibration: true;
    readonly noHorizonGate: true;
    readonly noRefittingOrCoefficientSearch: true;
    readonly notAnAverageOfCappedPredictions: true;
    readonly productionActivationAllowed: false;
    readonly promotable: false;
    readonly researchOnly: true;
    readonly selectedAfterExaminingPriorResults: true;
    readonly temperatureComponentWeight: 1;
    readonly weatherComponentWeight: 0.5;
    readonly weightsAppliedBeforeCumulativeClipping: true;
  };
}

// retain v1 evidence while adding one static shrinkage view
export type TemperatureWeatherShrinkageResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_SHRINKAGE_RESEARCH_CONTRACT_VERSION;
  readonly weatherShrinkage: TemperatureWeatherShrinkageView;
};

// compare the fixed recent fit with the original full-history model
export interface TemperatureWeatherRecencyComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
  readonly recentTemperatureWeather: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the recency comparison
type TemperatureWeatherRecencyDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherRecencyComparison };
// reuse one lead diagnostic with the recency comparison
type TemperatureWeatherRecencyLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherRecencyComparison };
// reuse one date diagnostic with the recency comparison
type TemperatureWeatherRecencyLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherRecencyComparison };
// reuse one temperature diagnostic with the recency comparison
type TemperatureWeatherRecencyTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherRecencyComparison };
// reuse one weather diagnostic with the recency comparison
type TemperatureWeatherRecencyRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureWeatherRecencyComparison };

// expose one fixed recent-training experiment without input rows
export interface TemperatureWeatherRecencyTrainingView {
  readonly after48Hours: TemperatureWeatherRecencyComparison;
  readonly coverage: {
    readonly eventCount: number;
    readonly baselineIneligibleCount: number;
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly temperatureSupportLostCount: number;
    readonly weatherSupportLostCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly differsFromRawTemperatureWeatherCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherRecencyDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherRecencyLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherRecencyLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherRecencyLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherRecencyTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherRecencyRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureWeatherRecencyComparison;
  readonly modelSha256: string;
  readonly models: {
    readonly temperature: readonly TemperatureWeatherTemperatureCell[];
    readonly weather: readonly TemperatureWeatherWeatherCell[];
  };
  readonly overall: TemperatureWeatherRecencyComparison;
  readonly policy: {
    readonly allLeadHours: true;
    readonly datesConsumed: true;
    readonly inclusiveLocalDateBounds: true;
    readonly localCalendarArithmetic: true;
    readonly lookbackLocalDates: typeof TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES;
    readonly noAdaptiveCalibration: true;
    readonly noCoefficientScaling: true;
    readonly noHorizonGate: true;
    readonly noLookbackSearch: true;
    readonly noScoreOutcomeDependence: true;
    readonly productionActivationAllowed: false;
    readonly promotable: false;
    readonly researchOnly: true;
    readonly selectedAfterExaminingPriorResults: true;
    readonly trainingAnchor: "latest_admitted_training_local_date";
  };
  readonly trainingCoverage: {
    readonly available: TemperatureWeatherResearchReport["trainingCoverage"];
    readonly retained: TemperatureWeatherResearchReport["trainingCoverage"];
    readonly excludedEventCount: number;
  };
  readonly trainingWindow: {
    readonly lookbackLocalDates: typeof TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES;
    readonly fromLocalDate: string | null;
    readonly throughLocalDate: string | null;
    readonly firstRetainedValidAt: string | null;
    readonly lastRetainedValidAt: string | null;
  };
}

// retain v1 evidence while adding one fixed recent-training view
export type TemperatureWeatherRecencyResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_RECENCY_RESEARCH_CONTRACT_VERSION;
  readonly recencyTraining: TemperatureWeatherRecencyTrainingView;
};

// describe the exact synchronous trainer boundary
export interface TemperatureBoostedTrainingRequest {
  readonly featureNames: typeof TEMPERATURE_BOOSTED_FEATURE_NAMES;
  readonly trainingIds: readonly string[];
  readonly trainingFeatures: readonly (readonly (number | null)[])[];
  readonly trainingResiduals: readonly number[];
  readonly trainingWeights: readonly number[];
  readonly predictionIds: readonly string[];
  readonly predictionFeatures: readonly (readonly (number | null)[])[];
}

// describe the exact native trainer response
export interface TemperatureBoostedTrainingResult {
  readonly modelJson: string;
  readonly configJson: string;
  readonly predictionIds: readonly string[];
  readonly predictedResiduals: readonly number[];
}

// inject one synchronous native boosted trainer
export type TemperatureBoostedTrainer = (
  request: TemperatureBoostedTrainingRequest,
) => TemperatureBoostedTrainingResult;

// compare the boosted residual with both frozen controls
export interface TemperatureBoostedComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
  readonly boostedTemperature: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the boosted comparison
type TemperatureBoostedDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedComparison };
// reuse one lead diagnostic with the boosted comparison
type TemperatureBoostedLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedComparison };
// reuse one date diagnostic with the boosted comparison
type TemperatureBoostedLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedComparison };
// reuse one temperature diagnostic with the boosted comparison
type TemperatureBoostedTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedComparison };
// reuse one weather diagnostic with the boosted comparison
type TemperatureBoostedRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedComparison };

// expose one boosted residual experiment without raw rows
export interface TemperatureBoostedResidualView {
  readonly after48Hours: TemperatureBoostedComparison;
  readonly coverage: {
    readonly eventCount: number;
    readonly baselineIneligibleCount: number;
    readonly missingFeatureCount: number;
    readonly modelPredictionCount: number;
    readonly modelFallbackCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly differsFromRawTemperatureWeatherCount: number;
    readonly seenExactTrainingLeadCount: number;
    readonly unseenExactTrainingLeadCount: number;
    readonly belowTrainingLeadRangeCount: number;
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureBoostedDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureBoostedLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureBoostedLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureBoostedLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureBoostedTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureBoostedRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureBoostedComparison;
  readonly leadScopes: {
    readonly seenExactTrainingLead: TemperatureBoostedComparison;
    readonly unseenExactTrainingLead: TemperatureBoostedComparison;
    readonly belowTrainingLeadRange: TemperatureBoostedComparison;
  };
  readonly model: {
    readonly modelJson: string | null;
    readonly modelSha256: string | null;
    readonly configJson: string | null;
    readonly configSha256: string | null;
    readonly requestSha256: string;
    readonly featureSchemaSha256: string;
    readonly trainingIdentitySha256: string;
    readonly scoreIdentitySha256: string;
  };
  readonly overall: TemperatureBoostedComparison;
  readonly policy: {
    readonly allLeadHours: true;
    readonly calendarPredictors: "existing_local_season_and_daypart_one_hot";
    readonly continuousPredictors: "raw_temperature_humidity_wind_and_lead";
    readonly datesConsumed: true;
    readonly existingPredictorsOnly: true;
    readonly missingValuesUseNativeRouting: true;
    readonly noAdaptiveCalibration: true;
    readonly noCoefficientScaling: true;
    readonly noFeatureSearch: true;
    readonly noHorizonGate: true;
    readonly noHyperparameterSearch: true;
    readonly noLookbackSearch: true;
    readonly noRecencyFilter: true;
    readonly noScoreOutcomeDependence: true;
    readonly noFeatureSourceExpansion: true;
    readonly productionActivationAllowed: false;
    readonly promotable: false;
    readonly researchOnly: true;
    readonly selectedAfterExaminingPriorResults: true;
    readonly target: "actual_minus_raw_temperature";
    readonly trainingRowWeighting: "equal_total_weight_per_valid_hour";
  };
  readonly trainingEvidence: {
    readonly available: TemperatureWeatherResearchReport["trainingCoverage"];
    readonly eligible: TemperatureWeatherResearchReport["trainingCoverage"];
    readonly eligibleEventCount: number;
    readonly weightSum: number;
    readonly perExactLead: readonly {
      readonly targetLeadHours: number;
      readonly eventCount: number;
    }[];
    readonly supportedExactLeads: readonly number[];
    readonly minimumTargetLeadHours: number | null;
    readonly maximumTargetLeadHours: number | null;
  };
}

// retain v1 evidence while adding one boosted residual view
export type TemperatureBoostedResearchReport = Omit<
  TemperatureWeatherResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_BOOSTED_RESEARCH_CONTRACT_VERSION;
  readonly boostedResidual: TemperatureBoostedResidualView;
};

// compare both hybrids with every inherited source strategy
export interface TemperatureBoostedHybridComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
  readonly boostedTemperature: TemperatureLeadResearchScore;
  readonly causalAdaptive: TemperatureLeadResearchScore;
  readonly hybrid: TemperatureLeadResearchScore;
  readonly boostedHybrid: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the boosted hybrid comparison
type TemperatureBoostedHybridDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedHybridComparison };
// reuse one lead diagnostic with the boosted hybrid comparison
type TemperatureBoostedHybridLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedHybridComparison };
// reuse one date diagnostic with the boosted hybrid comparison
type TemperatureBoostedHybridLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedHybridComparison };
// reuse one temperature diagnostic with the boosted hybrid comparison
type TemperatureBoostedHybridTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedHybridComparison };
// reuse one weather diagnostic with the boosted hybrid comparison
type TemperatureBoostedHybridRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureBoostedHybridComparison };

// freeze the selected boosted hybrid policy
export interface TemperatureBoostedHybridPolicy {
  readonly aboveThresholdStrategy: "boostedTemperature";
  readonly atOrBelowThresholdStrategy: "causalAdaptive";
  readonly calibration: TemperatureWeatherAdaptivePolicy;
  readonly datesConsumed: true;
  readonly fixedSourceModels: true;
  readonly noAdditionalPredictionCapping: true;
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly researchOnly: true;
  readonly selectedAfterExaminingPriorResults: true;
  readonly thresholdHours: typeof TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS;
}

// expose aggregate live results without private prediction rows
export interface TemperatureBoostedHybridEvaluatedView {
  readonly after48Hours: TemperatureBoostedHybridComparison;
  readonly causalAudit: {
    readonly selectionCount: number;
    readonly violationCount: number;
  };
  readonly coverage: {
    readonly eventCount: number;
    readonly first48EventCount: number;
    readonly after48EventCount: number;
    readonly first48CalibratedEventCount: number;
    readonly first48UncalibratedEventCount: number;
    readonly first48NonzeroCorrectionCount: number;
    readonly after48NonzeroCorrectionCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly modelPredictionCount: number;
    readonly modelFallbackCount: number;
    readonly missingFeatureCount: number;
    readonly differsFromPriorHybridCount: number;
    readonly first48AlphaSelectionCounts: readonly TemperatureWeatherAdaptiveAlphaSelectionCount[];
  };
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureBoostedHybridDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureBoostedHybridLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureBoostedHybridLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureBoostedHybridLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureBoostedHybridTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureBoostedHybridRegimeDiagnostic[];
  };
  readonly first48Hours: TemperatureBoostedHybridComparison;
  readonly overall: TemperatureBoostedHybridComparison;
  readonly policy: TemperatureBoostedHybridPolicy;
  readonly reason: null;
  readonly status: "empty_live_cohort" | "evaluated";
}

// keep archive controls explicit without fabricating hybrid scores
export interface TemperatureBoostedHybridArchiveView {
  readonly after48Hours: null;
  readonly causalAudit: null;
  readonly coverage: null;
  readonly diagnostics: null;
  readonly first48Hours: null;
  readonly overall: null;
  readonly policy: TemperatureBoostedHybridPolicy;
  readonly reason: "archive_has_no_observed_retrieval_time";
  readonly status: "not_applicable_archive_cohort";
}

// retain boosted evidence while adding one fixed live-only hybrid
export type TemperatureBoostedHybridResearchReport = Omit<
  TemperatureBoostedResearchReport,
  "contractVersion"
> & {
  readonly boostedHybrid:
    | TemperatureBoostedHybridArchiveView
    | TemperatureBoostedHybridEvaluatedView;
  readonly contractVersion: typeof TEMPERATURE_BOOSTED_HYBRID_RESEARCH_CONTRACT_VERSION;
};

// expose immutable private records only through an injected sink
export type TemperatureNearNowcastPrivateAuditCallback = (
  records: readonly TemperatureNowcastPrivateAuditRecord[],
) => void;

// compare the nowcast with its exact two controls
export interface TemperatureNearNowcastComparison {
  readonly raw: TemperatureLeadResearchScore;
  readonly boostedHybrid: TemperatureLeadResearchScore;
  readonly nearNowcast: TemperatureLeadResearchScore;
}

// reuse one daypart diagnostic with the near-nowcast comparison
type TemperatureNearNowcastDaypartDiagnostic = Omit<
  TemperatureWeatherDaypartDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureNearNowcastComparison };
// reuse one lead diagnostic with the near-nowcast comparison
type TemperatureNearNowcastLeadDiagnostic = Omit<
  TemperatureWeatherLeadDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureNearNowcastComparison };
// reuse one date diagnostic with the near-nowcast comparison
type TemperatureNearNowcastLocalDateDiagnostic = Omit<
  TemperatureWeatherLocalDateDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureNearNowcastComparison };
// reuse one temperature diagnostic with the near-nowcast comparison
type TemperatureNearNowcastTemperatureBinDiagnostic = Omit<
  TemperatureWeatherTemperatureBinDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureNearNowcastComparison };
// reuse one weather diagnostic with the near-nowcast comparison
type TemperatureNearNowcastRegimeDiagnostic = Omit<
  TemperatureWeatherRegimeDiagnostic,
  "comparison"
> & { readonly comparison: TemperatureNearNowcastComparison };

// group the same six diagnostic dimensions
export interface TemperatureNearNowcastDiagnostics {
  readonly byDaypart: readonly TemperatureNearNowcastDaypartDiagnostic[];
  readonly byLeadBand: readonly TemperatureNearNowcastLeadDiagnostic[];
  readonly byLocalDate: readonly TemperatureNearNowcastLocalDateDiagnostic[];
  readonly bySixHourBucket: readonly TemperatureNearNowcastLeadDiagnostic[];
  readonly byTemperatureBin: readonly TemperatureNearNowcastTemperatureBinDiagnostic[];
  readonly byWeatherRegime: readonly TemperatureNearNowcastRegimeDiagnostic[];
}

// freeze the selected recent-error persistence policy
export interface TemperatureNearNowcastPolicy {
  readonly after48HoursStrategy: "boostedTemperature";
  readonly assumedObservationAvailabilityLagHours: typeof TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS;
  readonly availabilityEvidenceStatus: "pseudo_real_time_retrospective_not_independently_validated";
  readonly correctionMaximumC: typeof TEMPERATURE_NOWCAST_MAXIMUM_CORRECTION_C;
  readonly correctionMinimumC: typeof TEMPERATURE_NOWCAST_MINIMUM_CORRECTION_C;
  readonly first12HoursStrategy: "recent_raw_error_persistence";
  readonly halfLifeHours: typeof TEMPERATURE_NOWCAST_HALF_LIFE_HOURS;
  readonly hours13To48Strategy: "causalAdaptive";
  readonly latestSourceReferenceTiePolicy: "prefer_lexicographically_greatest_key";
  readonly lookbackHours: typeof TEMPERATURE_NOWCAST_LOOKBACK_HOURS;
  readonly maximumSourceLeadHours: typeof TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS;
  readonly maximumTargetLeadHours: typeof TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS;
  readonly noArchiveWarmStart: true;
  readonly noNativeRefit: true;
  readonly noOldCorrectionAdded: true;
  readonly physicalMaximumC: typeof TEMPERATURE_NOWCAST_PHYSICAL_MAXIMUM_C;
  readonly physicalMinimumC: typeof TEMPERATURE_NOWCAST_PHYSICAL_MINIMUM_C;
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly requiredUniqueHours: typeof TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS;
  readonly researchOnly: true;
  readonly selectedAfterExaminingPriorResults: true;
  readonly sourceError: "actual_minus_raw_temperature";
  readonly sourceHourPolicy: "latest_three_distinct_valid_hours";
}

// expose aggregate live nowcast evidence without private rows
export interface TemperatureNearNowcastEvaluatedView {
  readonly after48Hours: TemperatureNearNowcastComparison;
  readonly causalAudit: {
    readonly auditSha256: string;
    readonly lookbackViolationCount: number;
    readonly maturityViolationCount: number;
    readonly recordCount: number;
    readonly referenceOrderViolationCount: number;
    readonly selectedSourceCount: number;
    readonly sourceLeadViolationCount: number;
  };
  readonly coverage: {
    readonly adjustedEventCount: number;
    readonly differsFromBoostedHybridCount: number;
    readonly eventCount: number;
    readonly fallbackCounts: Readonly<Record<TemperatureNowcastFallbackReason, number>>;
    readonly first12BaselineEligibleEventCount: number;
    readonly first12EventCount: number;
    readonly first12FallbackEventCount: number;
    readonly nonzeroCorrectionCount: number;
    readonly priorFallbackEventCount: number;
    readonly selectedSourceCount: number;
    readonly uniqueSelectedSourceHourCount: number;
  };
  readonly diagnostics: TemperatureNearNowcastDiagnostics;
  readonly first12Diagnostics: TemperatureNearNowcastDiagnostics;
  readonly first12Hours: TemperatureNearNowcastComparison;
  readonly first48Hours: TemperatureNearNowcastComparison;
  readonly first6Hours: TemperatureNearNowcastComparison;
  readonly hours13To24: TemperatureNearNowcastComparison;
  readonly hours13To48: TemperatureNearNowcastComparison;
  readonly hours25To48: TemperatureNearNowcastComparison;
  readonly hours7To12: TemperatureNearNowcastComparison;
  readonly overall: TemperatureNearNowcastComparison;
  readonly policy: TemperatureNearNowcastPolicy;
  readonly reason: null;
  readonly sourceAge: {
    readonly adjustedEventCount: number;
    readonly maximumLatestSourceAgeToTargetHours: number | null;
    readonly meanLatestSourceAgeToTargetHours: number | null;
    readonly minimumLatestSourceAgeToTargetHours: number | null;
  };
  readonly status: "empty_live_cohort" | "evaluated";
}

// keep archive controls explicit without fabricating nowcast scores
export interface TemperatureNearNowcastArchiveView {
  readonly after48Hours: null;
  readonly causalAudit: null;
  readonly coverage: null;
  readonly diagnostics: null;
  readonly first12Diagnostics: null;
  readonly first12Hours: null;
  readonly first48Hours: null;
  readonly first6Hours: null;
  readonly hours13To24: null;
  readonly hours13To48: null;
  readonly hours25To48: null;
  readonly hours7To12: null;
  readonly overall: null;
  readonly policy: TemperatureNearNowcastPolicy;
  readonly reason: "archive_has_no_observed_retrieval_time";
  readonly sourceAge: null;
  readonly status: "not_applicable_archive_cohort";
}

// retain the complete boosted hybrid evidence with one nowcast view
export type TemperatureNearNowcastResearchReport = Omit<
  TemperatureBoostedHybridResearchReport,
  "contractVersion"
> & {
  readonly contractVersion: typeof TEMPERATURE_NEAR_NOWCAST_RESEARCH_CONTRACT_VERSION;
  readonly nearNowcast:
    | TemperatureNearNowcastArchiveView
    | TemperatureNearNowcastEvaluatedView;
};

interface PreparedEvent extends TemperatureWeatherResearchEvent {
  readonly daypart: LocalDaypart;
  readonly humidityBin: HumidityBin;
  readonly informationBoundaryMilliseconds: number;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly localDate: string;
  readonly season: LocalMeteorologicalSeason;
  readonly sixHourBucket: string;
  readonly temperatureBin: number;
  readonly validAtMilliseconds: number;
  readonly windSpeedBin: WindBin;
}

interface CellSupport {
  readonly localDateCount: number;
  readonly uniqueValidHours: number;
}

interface EvaluatedEvent extends PreparedEvent {
  readonly predictions: Readonly<Record<TemperatureWeatherStrategy, number>>;
  readonly rawTemperatureDelta: number;
  readonly rawTemperatureOnlyPrediction: number;
  readonly rawWeatherDelta: number;
  readonly support: {
    readonly calendarTemperature: boolean;
    readonly calendarWeather: "ineligible" | "missing" | "supported" | "unsupported";
    readonly rawTemperature: boolean;
    readonly rawWeather: "ineligible" | "missing" | "supported" | "unsupported";
  };
}

interface ModelCells {
  readonly temperature: readonly TemperatureWeatherTemperatureCell[];
  readonly temperatureByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>;
  readonly weather: readonly TemperatureWeatherWeatherCell[];
  readonly weatherByKey: ReadonlyMap<string, TemperatureWeatherWeatherCell>;
}

interface EvaluatedEventGroups {
  readonly byDaypart: ReadonlyMap<string, readonly EvaluatedEvent[]>;
  readonly byLeadBand: ReadonlyMap<string, readonly EvaluatedEvent[]>;
  readonly byLocalDate: ReadonlyMap<string, readonly EvaluatedEvent[]>;
  readonly bySixHourBucket: ReadonlyMap<string, readonly EvaluatedEvent[]>;
  readonly byTemperatureBin: ReadonlyMap<string, readonly EvaluatedEvent[]>;
  readonly byWeatherRegime: ReadonlyMap<string, readonly EvaluatedEvent[]>;
}

interface TemperatureWeatherAnalysisCore {
  readonly evaluated: readonly EvaluatedEvent[];
  readonly groups: EvaluatedEventGroups;
  readonly report: TemperatureWeatherResearchReport;
  readonly trainingEvents: readonly PreparedEvent[];
}

interface AdaptiveSelection {
  readonly calibrated: boolean;
  readonly selectedAlpha: TemperatureWeatherAdaptiveAlpha;
}

const EXACT_EVENT_KEYS = [
  "actual",
  "baselineAdjusted",
  "baselineEligible",
  "rawForecast",
  "rawRelativeHumidityPercent",
  "rawWindSpeedMps",
  "referenceAt",
  "targetLeadHours",
  "validAt",
] as const;

// normalize one canonical UTC instant
function normalizeUtcInstant(value: string, field: string): string {
  // reject offsets, malformed values, and invalid instants
  if (!UTC_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  const normalized = new Date(value).toISOString();

  // reject calendar rollover while allowing omitted zero milliseconds
  if (normalized !== value && normalized !== value.replace("Z", ".000Z")) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return normalized;
}

// require one finite numeric field
function requireFinite(value: number, field: string): number {
  // reject non-finite model material
  if (!Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

// require one nullable bounded predictor
function requireNullableRange(
  value: number | null,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  // preserve explicit missing predictors
  if (value === null) {
    return null;
  }

  // reject invalid forecast predictors
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be null or between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

// reject missing or additional event fields
function validateExactEventShape(event: TemperatureWeatherResearchEvent): void {
  const keys = Object.keys(event).sort();
  const expected = [...EXACT_EVENT_KEYS].sort();

  // bind runtime inputs to the frozen event schema
  if (
    keys.length !== expected.length ||
    keys.some(
      // compare each sorted schema field
      (key, index) => key !== expected[index],
    )
  ) {
    throw new RangeError("temperature weather event fields must match the frozen schema");
  }
}

// map forecast temperature to a five-degree floor bin
function temperatureBinFor(temperatureC: number): number {
  return Math.floor(temperatureC / 5);
}

// map forecast humidity to the frozen regime
function humidityBinFor(relativeHumidityPercent: number | null): HumidityBin {
  // preserve missing forecast humidity
  if (relativeHumidityPercent === null) {
    return "missing";
  }

  // isolate dry forecast conditions
  if (relativeHumidityPercent < 50) {
    return "<50";
  }

  // isolate moderate forecast humidity
  if (relativeHumidityPercent < 80) {
    return "[50,80)";
  }

  return ">=80";
}

// map forecast wind speed to the frozen regime
function windSpeedBinFor(windSpeedMps: number | null): WindBin {
  // preserve missing forecast wind speed
  if (windSpeedMps === null) {
    return "missing";
  }

  // isolate calm forecast conditions
  if (windSpeedMps < 2) {
    return "<2";
  }

  // isolate moderate forecast wind
  if (windSpeedMps < 5) {
    return "[2,5)";
  }

  return ">=5";
}

// derive one six-hour lead bucket label
function sixHourBucketFor(targetLeadHours: number): string {
  const minimumHours = Math.floor((targetLeadHours - 1) / 6) * 6 + 1;
  const maximumHours = minimumHours + 5;
  return `${String(minimumHours).padStart(3, "0")}-${String(maximumHours).padStart(3, "0")}`;
}

// prepare and validate one frozen event
function prepareEvent(
  event: TemperatureWeatherResearchEvent,
  cohort: TemperatureWeatherScoreCohort,
  purpose: "score" | "training",
): PreparedEvent {
  validateExactEventShape(event);
  const validAt = normalizeUtcInstant(event.validAt, "validAt");
  const validAtMilliseconds = Date.parse(validAt);

  // require exact hourly forecast targets
  if (validAtMilliseconds % MILLISECONDS_PER_HOUR !== 0) {
    throw new RangeError("validAt must be aligned to an exact UTC hour");
  }

  // require all supported leads
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("targetLeadHours must be an integer between 1 and 168");
  }

  // require fixed training anchors and archive score anchors
  if (
    (purpose === "training" || cohort === "fixed_lead_anchor") &&
    !FIXED_ANCHOR_LEADS.has(event.targetLeadHours)
  ) {
    throw new RangeError(
      "fixed lead anchors must use 24-hour increments through 168 hours",
    );
  }

  let referenceAt: string | null = null;
  let informationBoundaryMilliseconds =
    validAtMilliseconds - event.targetLeadHours * MILLISECONDS_PER_HOUR;

  // require null references for fixed anchors
  if (purpose === "training" || cohort === "fixed_lead_anchor") {
    // reject invented archive issue timestamps
    if (event.referenceAt !== null) {
      throw new RangeError("fixed lead anchors must have a null referenceAt");
    }
  } else {
    // require a truthful live retrieval reference
    if (event.referenceAt === null) {
      throw new RangeError("legacy retrieval scores require referenceAt");
    }

    referenceAt = normalizeUtcInstant(event.referenceAt, "referenceAt");
    informationBoundaryMilliseconds = Date.parse(referenceAt);
    const continuousLeadHours =
      (validAtMilliseconds - informationBoundaryMilliseconds) /
      MILLISECONDS_PER_HOUR;

    // bind the live reference to its claimed positive lead
    if (
      continuousLeadHours <= 0 ||
      Math.ceil(continuousLeadHours) !== event.targetLeadHours
    ) {
      throw new RangeError("targetLeadHours must match validAt and referenceAt");
    }
  }

  // require one literal eligibility flag
  if (typeof event.baselineEligible !== "boolean") {
    throw new RangeError("baselineEligible must be boolean");
  }

  const actual = requireFinite(event.actual, "actual");
  const baselineAdjusted = requireFinite(event.baselineAdjusted, "baselineAdjusted");
  const rawForecast = requireFinite(event.rawForecast, "rawForecast");

  // reject temperatures outside the frozen physical domain
  if (
    actual < -100 ||
    actual > 70 ||
    baselineAdjusted < -100 ||
    baselineAdjusted > 70 ||
    rawForecast < -100 ||
    rawForecast > 70
  ) {
    throw new RangeError("temperature values must be between -100 and 70");
  }

  const rawRelativeHumidityPercent = requireNullableRange(
    event.rawRelativeHumidityPercent,
    "rawRelativeHumidityPercent",
    0,
    100,
  );
  const rawWindSpeedMps = requireNullableRange(
    event.rawWindSpeedMps,
    "rawWindSpeedMps",
    0,
    150,
  );
  const calendar = localCalendarFeaturesFor(validAt);

  return {
    actual,
    baselineAdjusted,
    baselineEligible: event.baselineEligible,
    daypart: calendar.daypart,
    humidityBin: humidityBinFor(rawRelativeHumidityPercent),
    informationBoundaryMilliseconds,
    key: `${validAt}|${event.targetLeadHours}`,
    leadBand: forecastLeadBandFor(event.targetLeadHours),
    localDate: calendar.localDate,
    rawForecast,
    rawRelativeHumidityPercent,
    rawWindSpeedMps,
    referenceAt,
    season: calendar.season,
    sixHourBucket: sixHourBucketFor(event.targetLeadHours),
    targetLeadHours: event.targetLeadHours,
    temperatureBin: temperatureBinFor(rawForecast),
    validAt,
    validAtMilliseconds,
    windSpeedBin: windSpeedBinFor(rawWindSpeedMps),
  };
}

// sort model inputs independently from arrival order
function comparePreparedEvents(left: PreparedEvent, right: PreparedEvent): number {
  return (
    left.validAt.localeCompare(right.validAt) ||
    left.targetLeadHours - right.targetLeadHours ||
    (left.referenceAt ?? "").localeCompare(right.referenceAt ?? "")
  );
}

// prepare one cohort and reject duplicate forecast identities
function prepareEvents(
  events: readonly TemperatureWeatherResearchEvent[],
  cohort: TemperatureWeatherScoreCohort,
  purpose: "score" | "training",
): readonly PreparedEvent[] {
  // require actual arrays rather than array-like objects
  if (!Array.isArray(events)) {
    throw new RangeError(`${purpose}Events must be an array`);
  }

  const prepared = events.map(
    // validate every retained event
    (event) => prepareEvent(event, cohort, purpose),
  ).sort(comparePreparedEvents);
  const identities = new Set<string>();

  // reject unresolved valid-time and lead duplicates
  for (const event of prepared) {
    // reject duplicate model-count units
    if (identities.has(event.key)) {
      throw new RangeError(
        `${purpose}Events must have unique validAt and targetLeadHours identities`,
      );
    }

    identities.add(event.key);
  }

  return prepared;
}

// bind training availability to the earliest scoring boundary
function validateTemporalSeparation(
  trainingEvents: readonly PreparedEvent[],
  scoreEvents: readonly PreparedEvent[],
): void {
  // leave explicit empty cohorts without a fabricated separation claim
  if (trainingEvents.length === 0 || scoreEvents.length === 0) {
    return;
  }

  let latestTrainingValidAt = Number.NEGATIVE_INFINITY;
  let earliestScoreBoundary = Number.POSITIVE_INFINITY;

  // find the latest training observation without argument spreading
  for (const event of trainingEvents) {
    latestTrainingValidAt = Math.max(
      latestTrainingValidAt,
      event.validAtMilliseconds,
    );
  }

  // find the earliest score boundary without argument spreading
  for (const event of scoreEvents) {
    earliestScoreBoundary = Math.min(
      earliestScoreBoundary,
      event.informationBoundaryMilliseconds,
    );
  }

  // require all training observations to be available before scoring
  if (latestTrainingValidAt + MILLISECONDS_PER_HOUR > earliestScoreBoundary) {
    throw new RangeError("training observations cross the earliest score information boundary");
  }
}

// build one stable temperature cell key
function temperatureCellKey(event: PreparedEvent): string {
  return [
    event.leadBand,
    event.season,
    event.daypart,
    String(event.temperatureBin),
  ].join("|");
}

// build one stable supported weather cell key
function weatherCellKey(event: PreparedEvent): string | null {
  // reject incomplete weather regimes from model fitting and lookup
  if (event.humidityBin === "missing" || event.windSpeedBin === "missing") {
    return null;
  }

  return [
    event.leadBand,
    event.season,
    event.daypart,
    event.humidityBin,
    event.windSpeedBin,
  ].join("|");
}

// group eligible events by one stable cell key
function groupEvents(
  events: readonly PreparedEvent[],
  keyFor: (event: PreparedEvent) => string | null,
): ReadonlyMap<string, readonly PreparedEvent[]> {
  const groups = new Map<string, PreparedEvent[]>();

  // exclude the common baseline-ineligible mask
  for (const event of events) {
    // skip ineligible rows for every fitted path
    if (!event.baselineEligible) {
      continue;
    }

    const key = keyFor(event);

    // skip missing-feature weather cells
    if (key === null) {
      continue;
    }

    let rows = groups.get(key);

    // initialize one cell group
    if (rows === undefined) {
      rows = [];
      groups.set(key, rows);
    }

    rows.push(event);
  }

  return groups;
}

// count the frozen independent support dimensions
function cellSupport(events: readonly PreparedEvent[]): CellSupport {
  return {
    localDateCount: new Set(events.map(
      // count unique local dates
      (event) => event.localDate,
    )).size,
    uniqueValidHours: new Set(events.map(
      // count unique valid hours
      (event) => event.validAt,
    )).size,
  };
}

// create one deterministic unit-weight residual
function residualObservation(
  event: PreparedEvent,
  residual: number,
  stage: "temperature" | "weather",
): WeightedResidualObservation {
  return {
    referenceAt: null,
    residual,
    stableId: `${stage}|${event.validAt}|${event.targetLeadHours}`,
    targetLeadHours: event.targetLeadHours,
    validAt: event.validAt,
    weight: 1,
  };
}

// fit supported temperature cells for one independent path
function fitTemperatureCells(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
): {
  readonly cells: readonly TemperatureWeatherTemperatureCell[];
  readonly cellsByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>;
} {
  const groups = groupEvents(trainingEvents, temperatureCellKey);
  const cells: TemperatureWeatherTemperatureCell[] = [];
  const cellsByKey = new Map<string, TemperatureWeatherTemperatureCell>();
  const policy = metricPolicyFor("temperatureC");

  // fit cells in stable lexical order
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key);

    // guard the stable group traversal
    if (rows === undefined) {
      throw new Error("temperature research group disappeared");
    }

    const support = cellSupport(rows);

    // inherit zero below either frozen support floor
    if (
      support.localDateCount < TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES ||
      support.uniqueValidHours < TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS
    ) {
      continue;
    }

    const observations = rows.map(
      // fit residuals from the independent path start
      (event) => {
        const baseDelta = path === "calendar_start"
          ? event.baselineAdjusted - event.rawForecast
          : 0;
        return residualObservation(
          event,
          event.actual - (event.rawForecast + baseDelta),
          "temperature",
        );
      },
    );
    const fitted = fitCoefficientCell(observations, {
      direction: false,
      minimumEffectiveEvents: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      policy,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
    });

    // guard support already proven above
    if (fitted === null) {
      throw new Error("supported temperature research cell did not fit");
    }

    const representative = rows[0];

    // guard the nonempty supported group
    if (representative === undefined) {
      throw new Error("supported temperature research cell is empty");
    }

    const cell: TemperatureWeatherTemperatureCell = {
      coefficient: fitted.coefficient,
      daypart: representative.daypart,
      effectiveEventCount: fitted.effectiveEventCount,
      key,
      leadBand: representative.leadBand,
      path,
      rawCoefficient: fitted.rawCoefficient,
      season: representative.season,
      supportLocalDateCount: support.localDateCount,
      supportUniqueValidHours: support.uniqueValidHours,
      temperatureBin: representative.temperatureBin,
      temperatureMaximumExclusiveC: (representative.temperatureBin + 1) * 5,
      temperatureMinimumC: representative.temperatureBin * 5,
    };
    cells.push(cell);
    cellsByKey.set(key, cell);
  }

  return { cells, cellsByKey };
}

// fit supported weather cells after one path's temperature stage
function fitWeatherCells(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
  temperatureByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>,
): {
  readonly cells: readonly TemperatureWeatherWeatherCell[];
  readonly cellsByKey: ReadonlyMap<string, TemperatureWeatherWeatherCell>;
} {
  const groups = groupEvents(trainingEvents, weatherCellKey);
  const cells: TemperatureWeatherWeatherCell[] = [];
  const cellsByKey = new Map<string, TemperatureWeatherWeatherCell>();
  const policy = metricPolicyFor("temperatureC");

  // fit cells in stable lexical order
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key);

    // guard the stable group traversal
    if (rows === undefined) {
      throw new Error("weather research group disappeared");
    }

    const support = cellSupport(rows);

    // inherit zero below either frozen support floor
    if (
      support.localDateCount < TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES ||
      support.uniqueValidHours < TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS
    ) {
      continue;
    }

    const observations = rows.map(
      // fit the unclipped residual after the preceding stages
      (event) => {
        const baseDelta = path === "calendar_start"
          ? event.baselineAdjusted - event.rawForecast
          : 0;
        const temperatureDelta =
          temperatureByKey.get(temperatureCellKey(event))?.coefficient ?? 0;
        return residualObservation(
          event,
          event.actual - (event.rawForecast + baseDelta + temperatureDelta),
          "weather",
        );
      },
    );
    const fitted = fitCoefficientCell(observations, {
      direction: false,
      minimumEffectiveEvents: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      policy,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
    });

    // guard support already proven above
    if (fitted === null) {
      throw new Error("supported weather research cell did not fit");
    }

    const representative = rows[0];

    // guard the nonempty supported group
    if (
      representative === undefined ||
      representative.humidityBin === "missing" ||
      representative.windSpeedBin === "missing"
    ) {
      throw new Error("supported weather research cell is incomplete");
    }

    const cell: TemperatureWeatherWeatherCell = {
      coefficient: fitted.coefficient,
      daypart: representative.daypart,
      effectiveEventCount: fitted.effectiveEventCount,
      humidityBin: representative.humidityBin,
      key,
      leadBand: representative.leadBand,
      path,
      rawCoefficient: fitted.rawCoefficient,
      season: representative.season,
      supportLocalDateCount: support.localDateCount,
      supportUniqueValidHours: support.uniqueValidHours,
      windSpeedBin: representative.windSpeedBin,
    };
    cells.push(cell);
    cellsByKey.set(key, cell);
  }

  return { cells, cellsByKey };
}

// fit both stages for one independent path
function fitModelPath(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
): ModelCells {
  const temperature = fitTemperatureCells(trainingEvents, path);
  const weather = fitWeatherCells(
    trainingEvents,
    path,
    temperature.cellsByKey,
  );
  return {
    temperature: temperature.cells,
    temperatureByKey: temperature.cellsByKey,
    weather: weather.cells,
    weatherByKey: weather.cellsByKey,
  };
}

// constrain the cumulative correction and final temperature once
function finalPrediction(rawForecast: number, totalDelta: number): number {
  const cappedDelta = Math.min(5, Math.max(-5, totalDelta));
  return Math.min(70, Math.max(-100, rawForecast + cappedDelta));
}

// resolve one weather component and its fallback reason
function weatherComponent(
  event: PreparedEvent,
  model: ModelCells,
): {
  readonly coefficient: number;
  readonly state: "missing" | "supported" | "unsupported";
} {
  const key = weatherCellKey(event);

  // preserve the preceding stage when predictors are missing
  if (key === null) {
    return { coefficient: 0, state: "missing" };
  }

  const cell = model.weatherByKey.get(key);

  // preserve the preceding stage below cell support
  if (cell === undefined) {
    return { coefficient: 0, state: "unsupported" };
  }

  return { coefficient: cell.coefficient, state: "supported" };
}

// score all five strategies for one retained event
function evaluateEvent(
  event: PreparedEvent,
  calendarModel: ModelCells,
  rawModel: ModelCells,
): EvaluatedEvent {
  // force a common raw fallback outside the baseline mask
  if (!event.baselineEligible) {
    return {
      ...event,
      predictions: {
        calendarBaseline: event.rawForecast,
        calendarTemperature: event.rawForecast,
        calendarTemperatureWeather: event.rawForecast,
        raw: event.rawForecast,
        rawTemperatureWeather: event.rawForecast,
      },
      rawTemperatureDelta: 0,
      rawTemperatureOnlyPrediction: event.rawForecast,
      rawWeatherDelta: 0,
      support: {
        calendarTemperature: false,
        calendarWeather: "ineligible",
        rawTemperature: false,
        rawWeather: "ineligible",
      },
    };
  }

  const baseDelta = event.baselineAdjusted - event.rawForecast;
  const calendarTemperatureCell = calendarModel.temperatureByKey.get(
    temperatureCellKey(event),
  );
  const rawTemperatureCell = rawModel.temperatureByKey.get(
    temperatureCellKey(event),
  );
  const calendarTemperatureDelta = calendarTemperatureCell?.coefficient ?? 0;
  const rawTemperatureDelta = rawTemperatureCell?.coefficient ?? 0;
  const calendarWeather = weatherComponent(event, calendarModel);
  const rawWeather = weatherComponent(event, rawModel);

  return {
    ...event,
    predictions: {
      calendarBaseline: finalPrediction(event.rawForecast, baseDelta),
      calendarTemperature: finalPrediction(
        event.rawForecast,
        baseDelta + calendarTemperatureDelta,
      ),
      calendarTemperatureWeather: finalPrediction(
        event.rawForecast,
        baseDelta + calendarTemperatureDelta + calendarWeather.coefficient,
      ),
      raw: event.rawForecast,
      rawTemperatureWeather: finalPrediction(
        event.rawForecast,
        rawTemperatureDelta + rawWeather.coefficient,
      ),
    },
    rawTemperatureDelta,
    rawTemperatureOnlyPrediction: finalPrediction(
      event.rawForecast,
      rawTemperatureDelta,
    ),
    rawWeatherDelta: rawWeather.coefficient,
    support: {
      calendarTemperature: calendarTemperatureCell !== undefined,
      calendarWeather: calendarWeather.state,
      rawTemperature: rawTemperatureCell !== undefined,
      rawWeather: rawWeather.state,
    },
  };
}

// score one strategy over an exact common event subset
function scoreStrategy(
  events: readonly EvaluatedEvent[],
  strategy: TemperatureWeatherStrategy,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(
    events.map(
      // project one frozen strategy prediction
      (event) => ({
        event: {
          actual: event.actual,
          localDate: event.localDate,
          rawForecast: event.rawForecast,
          validAt: event.validAt,
        },
        prediction: event.predictions[strategy],
      }),
    ),
  );
}

// compare all strategies over an exact common event subset
function compareStrategies(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherResearchComparison {
  return {
    calendarBaseline: scoreStrategy(events, "calendarBaseline"),
    calendarTemperature: scoreStrategy(events, "calendarTemperature"),
    calendarTemperatureWeather: scoreStrategy(events, "calendarTemperatureWeather"),
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
  };
}

// group events for one complete diagnostic dimension
function groupEvaluatedEvents(
  events: readonly EvaluatedEvent[],
  keyFor: (event: EvaluatedEvent) => string,
): ReadonlyMap<string, readonly EvaluatedEvent[]> {
  const groups = new Map<string, EvaluatedEvent[]>();

  // retain every score event in one diagnostic cell
  for (const event of events) {
    const key = keyFor(event);
    let rows = groups.get(key);

    // initialize one diagnostic group
    if (rows === undefined) {
      rows = [];
      groups.set(key, rows);
    }

    rows.push(event);
  }

  return groups;
}

// summarize one input cohort without retaining rows
function inputCoverage(events: readonly PreparedEvent[]): {
  readonly baselineEligibleEventCount: number;
  readonly eventCount: number;
  readonly localDateCount: number;
  readonly uniqueValidHours: number;
} {
  return {
    baselineEligibleEventCount: events.filter(
      // count the shared model eligibility mask
      (event) => event.baselineEligible,
    ).length,
    eventCount: events.length,
    localDateCount: new Set(events.map(
      // count unique local dates
      (event) => event.localDate,
    )).size,
    uniqueValidHours: new Set(events.map(
      // count unique valid hours
      (event) => event.validAt,
    )).size,
  };
}

// count explicit score fallbacks over the common denominator
function fallbackCoverage(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherFallbackCoverage {
  const eligible = events.filter(
    // isolate the shared baseline mask
    (event) => event.baselineEligible,
  );
  // count one weather fallback state
  const countWeatherState = (
    path: "calendarWeather" | "rawWeather",
    state: "missing" | "supported" | "unsupported",
  ): number => eligible.filter(
    // count one explicit path fallback state
    (event) => event.support[path] === state,
  ).length;

  return {
    baselineEligibleCount: eligible.length,
    baselineIneligibleCount: events.length - eligible.length,
    calendarBaselineAppliedCount: eligible.length,
    calendarTemperature: {
      temperatureSupportedCount: eligible.filter(
        // count supported calendar temperature cells
        (event) => event.support.calendarTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported calendar temperature cells
        (event) => !event.support.calendarTemperature,
      ).length,
    },
    calendarTemperatureWeather: {
      temperatureSupportedCount: eligible.filter(
        // count supported calendar temperature cells
        (event) => event.support.calendarTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported calendar temperature cells
        (event) => !event.support.calendarTemperature,
      ).length,
      weatherFeatureMissingCount: countWeatherState(
        "calendarWeather",
        "missing",
      ),
      weatherSupportedCount: countWeatherState("calendarWeather", "supported"),
      weatherUnsupportedCount: countWeatherState(
        "calendarWeather",
        "unsupported",
      ),
    },
    rawTemperatureWeather: {
      temperatureSupportedCount: eligible.filter(
        // count supported raw-start temperature cells
        (event) => event.support.rawTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported raw-start temperature cells
        (event) => !event.support.rawTemperature,
      ).length,
      weatherFeatureMissingCount: countWeatherState("rawWeather", "missing"),
      weatherSupportedCount: countWeatherState("rawWeather", "supported"),
      weatherUnsupportedCount: countWeatherState("rawWeather", "unsupported"),
    },
  };
}

// prepare one frozen weather analysis for compatible report views
function analyzeTemperatureWeatherCore(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherAnalysisCore {
  // require one frozen score cohort
  if (
    input.scoreCohort !== "fixed_lead_anchor" &&
    input.scoreCohort !== "legacy_v4_retrieval_snapshot"
  ) {
    throw new RangeError("scoreCohort must be a supported forecast cohort");
  }

  const trainingEvents = prepareEvents(
    input.trainingEvents,
    "fixed_lead_anchor",
    "training",
  );
  const scoreEvents = prepareEvents(
    input.scoreEvents,
    input.scoreCohort,
    "score",
  );
  validateTemporalSeparation(trainingEvents, scoreEvents);
  const calendarModel = fitModelPath(trainingEvents, "calendar_start");
  const rawModel = fitModelPath(trainingEvents, "raw_start");
  const evaluated = scoreEvents.map(
    // score one retained event under every strategy
    (event) => evaluateEvent(event, calendarModel, rawModel),
  );
  const byDaypart = groupEvaluatedEvents(
    evaluated,
    // group by forecast-valid local daypart
    (event) => event.daypart,
  );
  const byLeadBand = groupEvaluatedEvents(
    evaluated,
    // group by frozen forecast lead band
    (event) => event.leadBand,
  );
  const byLocalDate = groupEvaluatedEvents(
    evaluated,
    // group by forecast-valid local date
    (event) => event.localDate,
  );
  const bySixHourBucket = groupEvaluatedEvents(
    evaluated,
    // group by frozen six-hour lead bucket
    (event) => event.sixHourBucket,
  );
  const byTemperatureBin = groupEvaluatedEvents(
    evaluated,
    // group by forecast temperature only
    (event) => String(event.temperatureBin),
  );
  const byWeatherRegime = groupEvaluatedEvents(
    evaluated,
    // group by exact-row forecast humidity and wind
    (event) => `${event.humidityBin}|${event.windSpeedBin}`,
  );
  const localDates = [...byLocalDate.keys()].sort();
  const temperatureBins = [...byTemperatureBin.keys()].sort(
    // preserve numeric temperature-bin order
    (left, right) => Number(left) - Number(right),
  );
  const weatherRegimes = HUMIDITY_BINS.flatMap(
    // emit every frozen humidity and wind combination
    (humidityBin) => WIND_BINS.map(
      // bind one complete joint regime
      (windBin) => `${humidityBin}|${windBin}`,
    ),
  );
  const evidenceStatus = scoreEvents.length === 0
    ? "empty_score_cohort"
    : trainingEvents.length === 0
      ? "empty_training_cohort"
      : "retrospective_comparison_only";

  const report: TemperatureWeatherResearchReport = {
    contractVersion: TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION,
    coverage: fallbackCoverage(evaluated),
    diagnostics: {
      byDaypart: DAYPARTS.map(
        // emit every frozen daypart
        (daypart) => ({
          comparison: compareStrategies(byDaypart.get(daypart) ?? []),
          daypart,
        }),
      ),
      byLeadBand: FORECAST_LEAD_BANDS.map(
        // emit every frozen broad lead band
        (band) => ({
          comparison: compareStrategies(byLeadBand.get(band.key) ?? []),
          key: band.key,
          maximumHours: band.maximumHours,
          minimumHours: band.minimumHours,
        }),
      ),
      byLocalDate: localDates.map(
        // emit each observed local date
        (localDate) => ({
          comparison: compareStrategies(byLocalDate.get(localDate) ?? []),
          localDate,
        }),
      ),
      bySixHourBucket: Array.from(
        { length: 28 },
        // emit every frozen six-hour bucket
        (_unused, index) => {
          const minimumHours = index * 6 + 1;
          const maximumHours = minimumHours + 5;
          const key = sixHourBucketFor(minimumHours);
          return {
            comparison: compareStrategies(bySixHourBucket.get(key) ?? []),
            key,
            maximumHours,
            minimumHours,
          };
        },
      ),
      byTemperatureBin: temperatureBins.map(
        // emit each observed forecast-temperature bin
        (temperatureBinText) => {
          const index = Number(temperatureBinText);
          return {
            comparison: compareStrategies(
              byTemperatureBin.get(temperatureBinText) ?? [],
            ),
            temperatureBin: {
              index,
              maximumExclusiveC: (index + 1) * 5,
              minimumC: index * 5,
            },
          };
        },
      ),
      byWeatherRegime: weatherRegimes.map(
        // emit every forecast humidity and wind regime
        (key) => {
          const [humidityBin, windSpeedBin] = key.split("|") as [
            HumidityBin,
            WindBin,
          ];
          return {
            comparison: compareStrategies(byWeatherRegime.get(key) ?? []),
            humidityBin,
            windSpeedBin,
          };
        },
      ),
    },
    evidenceStatus,
    first48Hours: compareStrategies(evaluated.filter(
      // isolate the near-term forecast window
      (event) => event.targetLeadHours <= 48,
    )),
    inputCoverage: inputCoverage(scoreEvents),
    models: {
      calendarStart: {
        temperature: calendarModel.temperature,
        weather: calendarModel.weather,
      },
      rawStart: {
        temperature: rawModel.temperature,
        weather: rawModel.weather,
      },
    },
    overall: compareStrategies(evaluated),
    policy: {
      componentCorrectionMaximumC: 5,
      componentCorrectionMinimumC: -5,
      finalCorrectionMaximumC: 5,
      finalCorrectionMinimumC: -5,
      finalTemperatureMaximumC: 70,
      finalTemperatureMinimumC: -100,
      minimumLocalDates: TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES,
      minimumUniqueValidHours: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
      scoreDenominator: "all_matched_temperature_events",
      scoreInformationBoundary: "live_referenceAt_or_anchor_validAt_minus_targetLeadHours",
      trainingObservationAvailableAt: "validAt_plus_1_hour",
      unsupportedComponent: 0,
      weatherResidualUsesUnclippedPrecedingStages: true,
    },
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    runtimeBundleCreated: false,
    scoreCohort: input.scoreCohort,
    trainingCoverage: inputCoverage(trainingEvents),
  };

  return {
    evaluated,
    groups: {
      byDaypart,
      byLeadBand,
      byLocalDate,
      bySixHourBucket,
      byTemperatureBin,
      byWeatherRegime,
    },
    report,
    trainingEvents,
  };
}

// choose the fixed raw-near-term horizon prediction
function gatedAfter48Prediction(event: EvaluatedEvent): number {
  // protect the first forty-eight lead hours exactly
  if (event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS) {
    return event.rawForecast;
  }

  return event.predictions.rawTemperatureWeather;
}

// score the fixed horizon gate over one exact event subset
function scoreGatedAfter48Hours(
  events: readonly EvaluatedEvent[],
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project the literal horizon-gated prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: gatedAfter48Prediction(event),
    }),
  ));
}

// compare the gate with its two source strategies
function compareHorizonGate(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherHorizonComparison {
  return {
    gatedAfter48Hours: scoreGatedAfter48Hours(events),
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
  };
}

// count the protected and adjusted horizon partitions
function horizonGateCoverage(
  events: readonly EvaluatedEvent[],
  overall: TemperatureWeatherHorizonComparison,
): TemperatureWeatherHorizonGate["coverage"] {
  const after48 = events.filter(
    // isolate only forecasts eligible for the adjusted side of the gate
    (event) => event.targetLeadHours > TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const rawPath = fallbackCoverage(after48).rawTemperatureWeather;
  const after48BaselineIneligibleCount = after48.filter(
    // count common-mask fallbacks after the threshold
    (event) => !event.baselineEligible,
  ).length;

  return {
    after48BaselineIneligibleCount,
    after48EventCount: after48.length,
    after48TemperatureSupportedCount: rawPath.temperatureSupportedCount,
    after48TemperatureUnsupportedCount: rawPath.temperatureUnsupportedCount,
    after48WeatherFeatureMissingCount: rawPath.weatherFeatureMissingCount,
    after48WeatherSupportedCount: rawPath.weatherSupportedCount,
    after48WeatherUnsupportedCount: rawPath.weatherUnsupportedCount,
    eventCount: events.length,
    nonzeroCorrectionCount: overall.gatedAfter48Hours.correctionUseCount,
    rawProtectedEventCount: events.length - after48.length,
  };
}

// project the same six diagnostic dimensions for each frozen comparison
function createWeatherDiagnostics<Comparison>(
  core: TemperatureWeatherAnalysisCore,
  compare: (events: readonly EvaluatedEvent[]) => Comparison,
) {
  return {
    byDaypart: core.report.diagnostics.byDaypart.map(
      // preserve every v1 daypart slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.byDaypart.get(item.daypart) ?? [],
        ),
        daypart: item.daypart,
      }),
    ),
    byLeadBand: core.report.diagnostics.byLeadBand.map(
      // preserve every v1 lead-band slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.byLeadBand.get(item.key) ?? [],
        ),
        key: item.key,
        maximumHours: item.maximumHours,
        minimumHours: item.minimumHours,
      }),
    ),
    byLocalDate: core.report.diagnostics.byLocalDate.map(
      // preserve every v1 local-date slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.byLocalDate.get(item.localDate) ?? [],
        ),
        localDate: item.localDate,
      }),
    ),
    bySixHourBucket: core.report.diagnostics.bySixHourBucket.map(
      // preserve every v1 six-hour slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.bySixHourBucket.get(item.key) ?? [],
        ),
        key: item.key,
        maximumHours: item.maximumHours,
        minimumHours: item.minimumHours,
      }),
    ),
    byTemperatureBin: core.report.diagnostics.byTemperatureBin.map(
      // preserve every v1 forecast-temperature slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.byTemperatureBin.get(String(item.temperatureBin.index)) ?? [],
        ),
        temperatureBin: item.temperatureBin,
      }),
    ),
    byWeatherRegime: core.report.diagnostics.byWeatherRegime.map(
      // preserve every v1 forecast-weather slice and its metadata
      (item) => ({
        comparison: compare(
          core.groups.byWeatherRegime.get(
            `${item.humidityBin}|${item.windSpeedBin}`,
          ) ?? [],
        ),
        humidityBin: item.humidityBin,
        windSpeedBin: item.windSpeedBin,
      }),
    ),
  };
}

// build one descriptive gate view over the already-fitted analysis
function createHorizonGate(
  core: TemperatureWeatherAnalysisCore,
): TemperatureWeatherHorizonGate {
  const overall = compareHorizonGate(core.evaluated);
  const first48 = core.evaluated.filter(
    // isolate the raw-protected side of the gate
    (event) => event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const after48 = core.evaluated.filter(
    // isolate the adjusted side of the gate
    (event) => event.targetLeadHours > TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );

  return {
    after48Hours: compareHorizonGate(after48),
    contractVersion: TEMPERATURE_WEATHER_HORIZON_GATE_CONTRACT_VERSION,
    coverage: horizonGateCoverage(core.evaluated, overall),
    diagnostics: createWeatherDiagnostics(core, compareHorizonGate),
    first48Hours: compareHorizonGate(first48),
    overall,
    policy: {
      aboveThresholdStrategy: "rawTemperatureWeather",
      atOrBelowThresholdStrategy: "raw",
      first48RawByConstruction: true,
      productionActivationAllowed: false,
      promotable: false,
      selectedAfterExaminingPriorResults: true,
      thresholdHours: TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
    },
  };
}

// score the isolated raw-start temperature stage
function scoreRawTemperatureOnly(
  events: readonly EvaluatedEvent[],
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project the private stage-ablation prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: event.rawTemperatureOnlyPrediction,
    }),
  ));
}

// compare the isolated stage with raw and the complete raw-start path
function compareTemperatureOnly(
  events: readonly EvaluatedEvent[],
): TemperatureOnlyResearchComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureOnly: scoreRawTemperatureOnly(events),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
  };
}

// count isolated-stage support and prediction changes
function temperatureOnlyCoverage(
  events: readonly EvaluatedEvent[],
  overall: TemperatureOnlyResearchComparison,
): TemperatureOnlyAblation["coverage"] {
  const eligible = events.filter(
    // isolate the common model eligibility mask
    (event) => event.baselineEligible,
  );

  return {
    eventCount: events.length,
    baselineIneligibleCount: events.length - eligible.length,
    temperatureSupportedCount: eligible.filter(
      // count supported raw-start temperature cells
      (event) => event.support.rawTemperature,
    ).length,
    temperatureUnsupportedCount: eligible.filter(
      // count eligible raw fallbacks below cell support
      (event) => !event.support.rawTemperature,
    ).length,
    nonzeroCorrectionCount: overall.rawTemperatureOnly.correctionUseCount,
    differsFromRawTemperatureWeatherCount: events.filter(
      // count exact differences from the complete raw-start path
      (event) =>
        event.rawTemperatureOnlyPrediction !==
        event.predictions.rawTemperatureWeather,
    ).length,
  };
}

// build one descriptive stage view over the already-fitted analysis
function createTemperatureOnlyAblation(
  core: TemperatureWeatherAnalysisCore,
): TemperatureOnlyAblation {
  const overall = compareTemperatureOnly(core.evaluated);
  const first48 = core.evaluated.filter(
    // isolate the near-term forecast window
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the longer forecast window
    (event) => event.targetLeadHours > 48,
  );

  return {
    after48Hours: compareTemperatureOnly(after48),
    coverage: temperatureOnlyCoverage(core.evaluated, overall),
    diagnostics: createWeatherDiagnostics(core, compareTemperatureOnly),
    first48Hours: compareTemperatureOnly(first48),
    overall,
    policy: {
      calendarComponentIncluded: false,
      datesConsumed: true,
      productionActivationAllowed: false,
      promotable: false,
      researchOnly: true,
      selectedAfterExaminingPriorResults: true,
      weatherComponentIncluded: false,
    },
  };
}

// apply half of the fitted weather component before final clipping
function rawTemperatureHalfWeatherPrediction(event: EvaluatedEvent): number {
  // preserve the common eligibility fallback exactly
  if (!event.baselineEligible) {
    return event.rawForecast;
  }

  return finalPrediction(
    event.rawForecast,
    event.rawTemperatureDelta + 0.5 * event.rawWeatherDelta,
  );
}

// score half-weather predictions over one exact event subset
function scoreRawTemperatureHalfWeather(
  events: readonly EvaluatedEvent[],
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one private half-weather prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: rawTemperatureHalfWeatherPrediction(event),
    }),
  ));
}

// compare shrinkage with both unchanged component endpoints
function compareWeatherShrinkage(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherShrinkageComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureOnly: scoreRawTemperatureOnly(events),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
    rawTemperatureHalfWeather: scoreRawTemperatureHalfWeather(events),
  };
}

// count support and exact endpoint differences
function weatherShrinkageCoverage(
  events: readonly EvaluatedEvent[],
  overall: TemperatureWeatherShrinkageComparison,
): TemperatureWeatherShrinkageView["coverage"] {
  const eligible = events.filter(
    // isolate the common model eligibility mask
    (event) => event.baselineEligible,
  );

  return {
    eventCount: events.length,
    baselineIneligibleCount: events.length - eligible.length,
    temperatureSupportedCount: eligible.filter(
      // count supported raw-start temperature cells
      (event) => event.support.rawTemperature,
    ).length,
    temperatureUnsupportedCount: eligible.filter(
      // count temperature fallbacks
      (event) => !event.support.rawTemperature,
    ).length,
    weatherSupportedCount: eligible.filter(
      // count supported raw-start weather cells
      (event) => event.support.rawWeather === "supported",
    ).length,
    weatherUnsupportedCount: eligible.filter(
      // count unsupported raw-start weather cells
      (event) => event.support.rawWeather === "unsupported",
    ).length,
    weatherFeatureMissingCount: eligible.filter(
      // count missing raw-start weather predictors
      (event) => event.support.rawWeather === "missing",
    ).length,
    nonzeroCorrectionCount:
      overall.rawTemperatureHalfWeather.correctionUseCount,
    differsFromRawTemperatureOnlyCount: events.filter(
      // compare the half-weather candidate with temperature only
      (event) =>
        rawTemperatureHalfWeatherPrediction(event) !==
        event.rawTemperatureOnlyPrediction,
    ).length,
    differsFromRawTemperatureWeatherCount: events.filter(
      // compare the half-weather candidate with full weather
      (event) =>
        rawTemperatureHalfWeatherPrediction(event) !==
        event.predictions.rawTemperatureWeather,
    ).length,
  };
}

// build one static half-weather view over the shared fit
function createWeatherShrinkageView(
  core: TemperatureWeatherAnalysisCore,
): TemperatureWeatherShrinkageView {
  const overall = compareWeatherShrinkage(core.evaluated);
  const first48 = core.evaluated.filter(
    // isolate the near-term forecast window
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the longer forecast window
    (event) => event.targetLeadHours > 48,
  );

  return {
    after48Hours: compareWeatherShrinkage(after48),
    coverage: weatherShrinkageCoverage(core.evaluated, overall),
    diagnostics: createWeatherDiagnostics(core, compareWeatherShrinkage),
    first48Hours: compareWeatherShrinkage(first48),
    overall,
    policy: {
      allLeadHours: true,
      calendarComponentIncluded: false,
      datesConsumed: true,
      noAdaptiveCalibration: true,
      noHorizonGate: true,
      noRefittingOrCoefficientSearch: true,
      notAnAverageOfCappedPredictions: true,
      productionActivationAllowed: false,
      promotable: false,
      researchOnly: true,
      selectedAfterExaminingPriorResults: true,
      temperatureComponentWeight: 1,
      weatherComponentWeight: 0.5,
      weightsAppliedBeforeCumulativeClipping: true,
    },
  };
}

// select the fixed inclusive recent-training window
function selectRecentTrainingEvents(
  events: readonly PreparedEvent[],
): {
  readonly events: readonly PreparedEvent[];
  readonly window: TemperatureWeatherRecencyTrainingView["trainingWindow"];
} {
  // preserve explicit empty training bounds
  if (events.length === 0) {
    return {
      events: [],
      window: {
        lookbackLocalDates: TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES,
        fromLocalDate: null,
        throughLocalDate: null,
        firstRetainedValidAt: null,
        lastRetainedValidAt: null,
      },
    };
  }

  let throughLocalDate = events[0]?.localDate;

  // find the latest admitted local date including ineligible rows
  for (const event of events) {
    // advance the training-derived anchor
    if (throughLocalDate === undefined || event.localDate > throughLocalDate) {
      throughLocalDate = event.localDate;
    }
  }

  // guard the nonempty training anchor
  if (throughLocalDate === undefined) {
    throw new Error("recent temperature training anchor is missing");
  }

  const fromLocalDate = addLocalCalendarDays(
    throughLocalDate,
    -(TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES - 1),
  );
  const retained = events.filter(
    // retain both inclusive local-date boundaries
    (event) =>
      event.localDate >= fromLocalDate && event.localDate <= throughLocalDate,
  );

  return {
    events: retained,
    window: {
      lookbackLocalDates: TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES,
      fromLocalDate,
      throughLocalDate,
      firstRetainedValidAt: retained[0]?.validAt ?? null,
      lastRetainedValidAt: retained.at(-1)?.validAt ?? null,
    },
  };
}

// bind recent evaluations to original score identities
function recentEventsByKey(
  events: readonly EvaluatedEvent[],
): ReadonlyMap<string, EvaluatedEvent> {
  return new Map(events.map(
    // retain one recent evaluation per canonical score identity
    (event) => [event.key, event],
  ));
}

// require one recent evaluation for an original score row
function matchingRecentEvent(
  event: EvaluatedEvent,
  recentByKey: ReadonlyMap<string, EvaluatedEvent>,
): EvaluatedEvent {
  const recent = recentByKey.get(event.key);

  // reject an incomplete internal candidate evaluation
  if (recent === undefined) {
    throw new Error("recent temperature evaluation is missing");
  }

  return recent;
}

// select matching recent evaluations for one original subset
function matchingRecentEvents(
  events: readonly EvaluatedEvent[],
  recentByKey: ReadonlyMap<string, EvaluatedEvent>,
): readonly EvaluatedEvent[] {
  return events.map(
    // require one recent evaluation for every original score row
    (event) => matchingRecentEvent(event, recentByKey),
  );
}

// compare the recent fit with the unchanged full-history model
function compareRecencyTraining(
  events: readonly EvaluatedEvent[],
  recentByKey: ReadonlyMap<string, EvaluatedEvent>,
): TemperatureWeatherRecencyComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
    recentTemperatureWeather: scoreStrategy(
      matchingRecentEvents(events, recentByKey),
      "rawTemperatureWeather",
    ),
  };
}

// count recent support, support losses and prediction changes
function recencyTrainingCoverage(
  events: readonly EvaluatedEvent[],
  recentByKey: ReadonlyMap<string, EvaluatedEvent>,
  overall: TemperatureWeatherRecencyComparison,
): TemperatureWeatherRecencyTrainingView["coverage"] {
  const eligible = events.filter(
    // isolate the common model eligibility mask
    (event) => event.baselineEligible,
  );
  const recentEligible = matchingRecentEvents(eligible, recentByKey);

  return {
    eventCount: events.length,
    baselineIneligibleCount: events.length - eligible.length,
    temperatureSupportedCount: recentEligible.filter(
      // count supported recent temperature cells
      (event) => event.support.rawTemperature,
    ).length,
    temperatureUnsupportedCount: recentEligible.filter(
      // count unsupported recent temperature cells
      (event) => !event.support.rawTemperature,
    ).length,
    weatherSupportedCount: recentEligible.filter(
      // count supported recent weather cells
      (event) => event.support.rawWeather === "supported",
    ).length,
    weatherUnsupportedCount: recentEligible.filter(
      // count unsupported recent weather cells
      (event) => event.support.rawWeather === "unsupported",
    ).length,
    weatherFeatureMissingCount: recentEligible.filter(
      // count missing recent weather predictors
      (event) => event.support.rawWeather === "missing",
    ).length,
    temperatureSupportLostCount: eligible.filter(
      // count original temperature support absent from the recent fit
      (event) =>
        event.support.rawTemperature &&
        !matchingRecentEvent(event, recentByKey).support.rawTemperature,
    ).length,
    weatherSupportLostCount: eligible.filter(
      // count original weather support absent from the recent fit
      (event) =>
        event.support.rawWeather === "supported" &&
        matchingRecentEvent(event, recentByKey).support.rawWeather !== "supported",
    ).length,
    nonzeroCorrectionCount: overall.recentTemperatureWeather.correctionUseCount,
    differsFromRawTemperatureWeatherCount: events.filter(
      // compare recent and original full-weather predictions exactly
      (event) =>
        matchingRecentEvent(event, recentByKey)
          .predictions.rawTemperatureWeather !==
        event.predictions.rawTemperatureWeather,
    ).length,
  };
}

// build one static recent-training view over the original analysis
function createRecencyTrainingView(
  core: TemperatureWeatherAnalysisCore,
): TemperatureWeatherRecencyTrainingView {
  const selected = selectRecentTrainingEvents(core.trainingEvents);
  const recentModel = fitModelPath(selected.events, "raw_start");
  const recentEvaluated = core.evaluated.map(
    // pass twice because only recent raw-start output is consumed
    (event) => evaluateEvent(event, recentModel, recentModel),
  );
  const recentByKey = recentEventsByKey(recentEvaluated);
  const overall = compareRecencyTraining(core.evaluated, recentByKey);
  const first48 = core.evaluated.filter(
    // isolate the near-term forecast window
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the longer forecast window
    (event) => event.targetLeadHours > 48,
  );
  const models = {
    temperature: recentModel.temperature,
    weather: recentModel.weather,
  };

  return {
    after48Hours: compareRecencyTraining(after48, recentByKey),
    coverage: recencyTrainingCoverage(core.evaluated, recentByKey, overall),
    diagnostics: createWeatherDiagnostics(
      core,
      // score each unchanged slice with the frozen experiment state
      (events) => compareRecencyTraining(events, recentByKey),
    ),
    first48Hours: compareRecencyTraining(first48, recentByKey),
    modelSha256: canonicalSha256(models as unknown as JsonValue),
    models,
    overall,
    policy: {
      allLeadHours: true,
      datesConsumed: true,
      inclusiveLocalDateBounds: true,
      localCalendarArithmetic: true,
      lookbackLocalDates: TEMPERATURE_WEATHER_RECENCY_LOOKBACK_LOCAL_DATES,
      noAdaptiveCalibration: true,
      noCoefficientScaling: true,
      noHorizonGate: true,
      noLookbackSearch: true,
      noScoreOutcomeDependence: true,
      productionActivationAllowed: false,
      promotable: false,
      researchOnly: true,
      selectedAfterExaminingPriorResults: true,
      trainingAnchor: "latest_admitted_training_local_date",
    },
    trainingCoverage: {
      available: inputCoverage(core.trainingEvents),
      retained: inputCoverage(selected.events),
      excludedEventCount: core.trainingEvents.length - selected.events.length,
    },
    trainingWindow: selected.window,
  };
}

interface TemperatureBoostedPredictionState {
  readonly byEventKey: ReadonlyMap<string, number>;
  readonly modelAvailable: boolean;
}

// encode one row from existing continuous and calendar predictors
function boostedFeatureRow(
  event: PreparedEvent,
): readonly (number | null)[] {
  return [
    event.rawForecast,
    event.rawRelativeHumidityPercent,
    event.rawWindSpeedMps,
    event.targetLeadHours,
    event.season === "winter" ? 1 : 0,
    event.season === "spring" ? 1 : 0,
    event.season === "summer" ? 1 : 0,
    event.season === "autumn" ? 1 : 0,
    event.daypart === "night" ? 1 : 0,
    event.daypart === "morning" ? 1 : 0,
    event.daypart === "afternoon" ? 1 : 0,
    event.daypart === "evening" ? 1 : 0,
  ];
}

// hash exact native JSON bytes
function nativeTextSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// reject non-finite numbers anywhere in parsed JSON
function validateFiniteJson(value: unknown, field: string): void {
  // reject non-finite numeric material
  if (typeof value === "number") {
    // bind native artifacts to ordinary JSON numbers
    if (!Number.isFinite(value)) {
      throw new RangeError(`${field} must contain only finite numbers`);
    }

    return;
  }

  // inspect every array element
  if (Array.isArray(value)) {
    // validate nested array material
    for (const item of value) {
      validateFiniteJson(item, field);
    }

    return;
  }

  // inspect every object value
  if (value !== null && typeof value === "object") {
    // validate nested object material
    for (const item of Object.values(value)) {
      validateFiniteJson(item, field);
    }
  }
}

// validate one native JSON artifact without normalizing its bytes
function validateNativeJson(
  value: unknown,
  field: "configJson" | "modelJson",
  requireObject: boolean,
): string {
  // require one retained native string
  if (typeof value !== "string") {
    throw new RangeError(`${field} must be a JSON string`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    // reject malformed native artifacts
    throw new RangeError(`${field} must contain valid JSON`);
  }

  validateFiniteJson(parsed, field);

  // require the fitted model to be a JSON object
  if (
    requireObject &&
    (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new RangeError("modelJson must contain a JSON object");
  }

  return value;
}

// freeze one isolated trainer request before crossing the injected boundary
function freezeBoostedRequest(
  request: TemperatureBoostedTrainingRequest,
): TemperatureBoostedTrainingRequest {
  return Object.freeze({
    featureNames: Object.freeze([...request.featureNames]) as unknown as
      typeof TEMPERATURE_BOOSTED_FEATURE_NAMES,
    trainingIds: Object.freeze([...request.trainingIds]),
    trainingFeatures: Object.freeze(request.trainingFeatures.map(
      // isolate and freeze every training row
      (row) => Object.freeze([...row]),
    )),
    trainingResiduals: Object.freeze([...request.trainingResiduals]),
    trainingWeights: Object.freeze([...request.trainingWeights]),
    predictionIds: Object.freeze([...request.predictionIds]),
    predictionFeatures: Object.freeze(request.predictionFeatures.map(
      // isolate and freeze every prediction row
      (row) => Object.freeze([...row]),
    )),
  });
}

// snapshot and validate one exact trainer response
function validateBoostedResult(
  value: unknown,
  expectedPredictionIds: readonly string[],
): TemperatureBoostedTrainingResult {
  // require one plain response object
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError("temperature boosted trainer result must be an object");
  }

  const result = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(result).sort();
  const expectedKeys = [
    "configJson",
    "modelJson",
    "predictedResiduals",
    "predictionIds",
  ].sort();

  // reject omitted or additional response fields
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      // compare each exact response field
      (key, index) => key !== expectedKeys[index],
    )
  ) {
    throw new RangeError("temperature boosted trainer result fields must match the frozen schema");
  }

  // require one prediction identity per requested row
  if (
    !Array.isArray(result.predictionIds) ||
    result.predictionIds.length !== expectedPredictionIds.length ||
    result.predictionIds.some(
      // bind each prediction to its exact requested row
      (id, index) => id !== expectedPredictionIds[index],
    )
  ) {
    throw new RangeError("temperature boosted trainer predictionIds must match request order");
  }

  // require one finite residual per requested row
  if (
    !Array.isArray(result.predictedResiduals) ||
    result.predictedResiduals.length !== expectedPredictionIds.length ||
    result.predictedResiduals.some(
      // reject non-numeric or non-finite predictions
      (prediction) =>
        typeof prediction !== "number" || !Number.isFinite(prediction),
    )
  ) {
    throw new RangeError("temperature boosted trainer predictions must be finite and complete");
  }

  return {
    configJson: validateNativeJson(result.configJson, "configJson", false),
    modelJson: validateNativeJson(result.modelJson, "modelJson", true),
    predictionIds: [...result.predictionIds] as string[],
    predictedResiduals: [...result.predictedResiduals] as number[],
  };
}

// bind full prepared source identities without retaining rows
function boostedIdentitySha256(events: readonly PreparedEvent[]): string {
  const identities = events.map(
    // retain only source identity and partition fields
    (event) => ({
      baselineEligible: event.baselineEligible,
      key: event.key,
      referenceAt: event.referenceAt,
    }),
  );
  return canonicalSha256(identities as unknown as JsonValue);
}

// create one isolated and canonically ordered trainer request
function createBoostedRequest(
  trainingEvents: readonly PreparedEvent[],
  scoreEvents: readonly EvaluatedEvent[],
): {
  readonly eligibleTrainingEvents: readonly PreparedEvent[];
  readonly request: TemperatureBoostedTrainingRequest;
} {
  const eligibleTrainingEvents = trainingEvents.filter(
    // isolate the unchanged baseline eligibility mask
    (event) => event.baselineEligible,
  );
  const countByValidAt = new Map<string, number>();

  // count eligible anchors sharing each valid hour
  for (const event of eligibleTrainingEvents) {
    countByValidAt.set(
      event.validAt,
      (countByValidAt.get(event.validAt) ?? 0) + 1,
    );
  }

  const trainingWeights = eligibleTrainingEvents.map(
    // give every valid hour total weight one
    (event) => {
      const count = countByValidAt.get(event.validAt);

      // guard the complete same-hour count map
      if (count === undefined || count < 1) {
        throw new Error("temperature boosted training weight count is missing");
      }

      return 1 / count;
    },
  );

  const request = freezeBoostedRequest({
    featureNames: [...TEMPERATURE_BOOSTED_FEATURE_NAMES] as unknown as
      typeof TEMPERATURE_BOOSTED_FEATURE_NAMES,
    trainingIds: eligibleTrainingEvents.map(
      // retain ordered eligible training identities
      (event) => event.key,
    ),
    trainingFeatures: eligibleTrainingEvents.map(
      // encode every eligible training row independently
      (event) => boostedFeatureRow(event),
    ),
    trainingResiduals: eligibleTrainingEvents.map(
      // fit the raw-start temperature residual
      (event) => event.actual - event.rawForecast,
    ),
    trainingWeights,
    predictionIds: scoreEvents.map(
      // retain all ordered score identities
      (event) => event.key,
    ),
    predictionFeatures: scoreEvents.map(
      // encode all score rows without their outcomes
      (event) => boostedFeatureRow(event),
    ),
  });

  return {
    eligibleTrainingEvents,
    request,
  };
}

// fit one model and bind every returned residual to its event identity
function fitBoostedPredictions(
  request: TemperatureBoostedTrainingRequest,
  trainer: TemperatureBoostedTrainer,
): {
  readonly configJson: string | null;
  readonly modelJson: string | null;
  readonly predictions: TemperatureBoostedPredictionState;
} {
  // preserve a complete raw fallback when no eligible training exists
  if (request.trainingIds.length === 0) {
    return {
      configJson: null,
      modelJson: null,
      predictions: {
        byEventKey: new Map<string, number>(),
        modelAvailable: false,
      },
    };
  }

  // require a callable injected native boundary
  if (typeof trainer !== "function") {
    throw new RangeError("temperature boosted trainer must be a function");
  }

  const result = validateBoostedResult(
    trainer(request),
    request.predictionIds,
  );
  const byEventKey = new Map<string, number>();

  // bind each snapshotted prediction to its echoed identity
  for (let index = 0; index < result.predictionIds.length; index += 1) {
    const id = result.predictionIds[index];
    const prediction = result.predictedResiduals[index];

    // guard the already-validated parallel arrays
    if (id === undefined || prediction === undefined) {
      throw new Error("temperature boosted trainer result snapshot is incomplete");
    }

    byEventKey.set(id, prediction);
  }

  return {
    configJson: result.configJson,
    modelJson: result.modelJson,
    predictions: {
      byEventKey,
      modelAvailable: true,
    },
  };
}

// resolve one boosted prediction with the common raw fallback
function boostedPrediction(
  event: EvaluatedEvent,
  state: TemperatureBoostedPredictionState,
): number {
  // preserve raw outside the common eligibility mask or without a fit
  if (!event.baselineEligible || !state.modelAvailable) {
    return event.rawForecast;
  }

  const residual = state.byEventKey.get(event.key);

  // reject incomplete fitted prediction maps
  if (residual === undefined) {
    throw new Error("temperature boosted prediction is missing");
  }

  return finalPrediction(event.rawForecast, residual);
}

// score boosted predictions over one exact event subset
function scoreBoosted(
  events: readonly EvaluatedEvent[],
  state: TemperatureBoostedPredictionState,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one boosted residual prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: boostedPrediction(event, state),
    }),
  ));
}

// compare the boosted model with both frozen controls
function compareBoosted(
  events: readonly EvaluatedEvent[],
  state: TemperatureBoostedPredictionState,
): TemperatureBoostedComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
    boostedTemperature: scoreBoosted(events, state),
  };
}

// count eligible training rows by exact lead
function boostedTrainingLeadEvidence(
  events: readonly PreparedEvent[],
): Pick<
  TemperatureBoostedResidualView["trainingEvidence"],
  | "maximumTargetLeadHours"
  | "minimumTargetLeadHours"
  | "perExactLead"
  | "supportedExactLeads"
> {
  const countByLead = new Map<number, number>();

  // count each eligible training lead
  for (const event of events) {
    countByLead.set(
      event.targetLeadHours,
      (countByLead.get(event.targetLeadHours) ?? 0) + 1,
    );
  }

  const supportedExactLeads = [...countByLead.keys()].sort(
    // retain numeric lead order
    (left, right) => left - right,
  );

  return {
    maximumTargetLeadHours: supportedExactLeads.at(-1) ?? null,
    minimumTargetLeadHours: supportedExactLeads[0] ?? null,
    perExactLead: supportedExactLeads.map(
      // expose one aggregate exact-lead count
      (targetLeadHours) => ({
        eventCount: countByLead.get(targetLeadHours) ?? 0,
        targetLeadHours,
      }),
    ),
    supportedExactLeads,
  };
}

// build one aggregate boosted residual analysis
function createBoostedResidualAnalysis(
  core: TemperatureWeatherAnalysisCore,
  trainer: TemperatureBoostedTrainer,
): {
  readonly state: TemperatureBoostedPredictionState;
  readonly view: TemperatureBoostedResidualView;
} {
  const prepared = createBoostedRequest(core.trainingEvents, core.evaluated);
  const request = prepared.request;
  const fitted = fitBoostedPredictions(request, trainer);
  const state = fitted.predictions;
  const trainingLeadEvidence = boostedTrainingLeadEvidence(
    prepared.eligibleTrainingEvents,
  );
  const supportedLeadSet = new Set(
    trainingLeadEvidence.supportedExactLeads,
  );
  const seenExactTrainingLead = core.evaluated.filter(
    // isolate score rows with an exact eligible training lead
    (event) => supportedLeadSet.has(event.targetLeadHours),
  );
  const unseenExactTrainingLead = core.evaluated.filter(
    // retain unseen leads without gating their model predictions
    (event) => !supportedLeadSet.has(event.targetLeadHours),
  );
  const belowTrainingLeadRange = core.evaluated.filter(
    // describe leads below the fitted range without gating
    (event) =>
      trainingLeadEvidence.minimumTargetLeadHours !== null &&
      event.targetLeadHours < trainingLeadEvidence.minimumTargetLeadHours,
  );
  const first48 = core.evaluated.filter(
    // isolate the near-term forecast window
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the longer forecast window
    (event) => event.targetLeadHours > 48,
  );
  const eligibleScore = core.evaluated.filter(
    // isolate score rows receiving fitted predictions
    (event) => event.baselineEligible,
  );
  const overall = compareBoosted(core.evaluated, state);
  const modelPredictionCount = state.modelAvailable ? eligibleScore.length : 0;

  const view: TemperatureBoostedResidualView = {
    after48Hours: compareBoosted(after48, state),
    coverage: {
      eventCount: core.evaluated.length,
      baselineIneligibleCount: core.evaluated.length - eligibleScore.length,
      missingFeatureCount: eligibleScore.filter(
        // count natively routed missing weather inputs
        (event) =>
          event.rawRelativeHumidityPercent === null ||
          event.rawWindSpeedMps === null,
      ).length,
      modelPredictionCount,
      modelFallbackCount: core.evaluated.length - modelPredictionCount,
      nonzeroCorrectionCount: overall.boostedTemperature.correctionUseCount,
      differsFromRawTemperatureWeatherCount: core.evaluated.filter(
        // compare the candidate with the original full-weather prediction
        (event) =>
          boostedPrediction(event, state) !==
          event.predictions.rawTemperatureWeather,
      ).length,
      seenExactTrainingLeadCount: seenExactTrainingLead.length,
      unseenExactTrainingLeadCount: unseenExactTrainingLead.length,
      belowTrainingLeadRangeCount: belowTrainingLeadRange.length,
    },
    diagnostics: createWeatherDiagnostics(
      core,
      // score each unchanged slice with the frozen experiment state
      (events) => compareBoosted(events, state),
    ),
    first48Hours: compareBoosted(first48, state),
    leadScopes: {
      seenExactTrainingLead: compareBoosted(seenExactTrainingLead, state),
      unseenExactTrainingLead: compareBoosted(unseenExactTrainingLead, state),
      belowTrainingLeadRange: compareBoosted(belowTrainingLeadRange, state),
    },
    model: {
      modelJson: fitted.modelJson,
      modelSha256: fitted.modelJson === null
        ? null
        : nativeTextSha256(fitted.modelJson),
      configJson: fitted.configJson,
      configSha256: fitted.configJson === null
        ? null
        : nativeTextSha256(fitted.configJson),
      requestSha256: canonicalSha256(request as unknown as JsonValue),
      featureSchemaSha256: canonicalSha256(
        TEMPERATURE_BOOSTED_FEATURE_NAMES as unknown as JsonValue,
      ),
      trainingIdentitySha256: boostedIdentitySha256(core.trainingEvents),
      scoreIdentitySha256: boostedIdentitySha256(core.evaluated),
    },
    overall,
    policy: {
      allLeadHours: true,
      calendarPredictors: "existing_local_season_and_daypart_one_hot",
      continuousPredictors: "raw_temperature_humidity_wind_and_lead",
      datesConsumed: true,
      existingPredictorsOnly: true,
      missingValuesUseNativeRouting: true,
      noAdaptiveCalibration: true,
      noCoefficientScaling: true,
      noFeatureSearch: true,
      noFeatureSourceExpansion: true,
      noHorizonGate: true,
      noHyperparameterSearch: true,
      noLookbackSearch: true,
      noRecencyFilter: true,
      noScoreOutcomeDependence: true,
      productionActivationAllowed: false,
      promotable: false,
      researchOnly: true,
      selectedAfterExaminingPriorResults: true,
      target: "actual_minus_raw_temperature",
      trainingRowWeighting: "equal_total_weight_per_valid_hour",
    },
    trainingEvidence: {
      available: inputCoverage(core.trainingEvents),
      eligible: inputCoverage(prepared.eligibleTrainingEvents),
      eligibleEventCount: prepared.eligibleTrainingEvents.length,
      weightSum: request.trainingWeights.reduce(
        // sum the exact weights sent to the trainer
        (sum, weight) => sum + weight,
        0,
      ),
      ...trainingLeadEvidence,
    },
  };

  return { state, view };
}

// preserve the original boosted-only construction boundary
function createBoostedResidualView(
  core: TemperatureWeatherAnalysisCore,
  trainer: TemperatureBoostedTrainer,
): TemperatureBoostedResidualView {
  return createBoostedResidualAnalysis(core, trainer).view;
}

// create the fixed live-only adaptive policy
function adaptivePolicy(): TemperatureWeatherAdaptivePolicy {
  return {
    alphaGrid: TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID,
    alphaTiePolicy: "prefer_smaller_alpha",
    availabilityEvidenceStatus:
      "pseudo_real_time_retrospective_not_independently_validated",
    bucketWidthHours: 6,
    datesConsumed: true,
    liveOnly: true,
    minimumPriorLocalDates:
      TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES,
    minimumPriorUniqueValidHours:
      TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS,
    noArchiveWarmStart: true,
    observationAvailableAtRule: "validAt_plus_1_hour",
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    sourceStrategy: "rawTemperatureWeather",
    unsupportedAlpha: 0,
  };
}

// calibrate the already-fitted raw-start correction causally
function adaptiveSelections(
  events: readonly EvaluatedEvent[],
): {
  readonly audit: {
    readonly selectionCount: number;
    readonly violationCount: number;
  };
  readonly byEventKey: ReadonlyMap<string, AdaptiveSelection>;
} {
  const calibration = analyzeTemperatureLeadResearch(events.map(
    // include every score row and its exact raw-start prediction
    (event) => {
      // require the live cohort before adapting
      if (event.referenceAt === null) {
        throw new Error("adaptive temperature calibration requires live references");
      }

      return {
        actual: event.actual,
        baselineAdjusted: event.predictions.rawTemperatureWeather,
        rawForecast: event.rawForecast,
        referenceAt: event.referenceAt,
        targetLeadHours: event.targetLeadHours,
        validAt: event.validAt,
      };
    },
  ));
  const byEventKey = new Map<string, AdaptiveSelection>();
  let violationCount = 0;

  // retain only the selection needed to score each canonical event
  for (const selection of calibration.causalTrace) {
    const key = `${selection.validAt}|${selection.targetLeadHours}`;
    const availabilityViolation =
      selection.latestConsumedObservationAvailableAt !== null &&
      selection.latestConsumedObservationAvailableAt > selection.referenceAt;
    const supportViolation = selection.calibrated && (
      selection.supportLocalDateCount <
        TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES ||
      selection.supportUniqueValidHours <
        TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS
    );

    // count every causal or supported-selection violation
    if (availabilityViolation || supportViolation) {
      violationCount += 1;
    }

    // reject impossible duplicate oracle selections
    if (byEventKey.has(key)) {
      throw new Error("adaptive temperature calibration produced duplicate selections");
    }

    byEventKey.set(key, {
      calibrated: selection.calibrated,
      selectedAlpha: selection.selectedAlpha,
    });
  }

  // require one auditable selection per score event
  if (byEventKey.size !== events.length) {
    throw new Error("adaptive temperature calibration omitted selections");
  }

  // fail closed on any temporal or support breach
  if (violationCount !== 0) {
    throw new Error("adaptive temperature calibration violated causal support");
  }

  return {
    audit: {
      selectionCount: byEventKey.size,
      violationCount,
    },
    byEventKey,
  };
}

// require one private selection for a scored event
function adaptiveSelectionFor(
  event: EvaluatedEvent,
  selections: ReadonlyMap<string, AdaptiveSelection>,
): AdaptiveSelection {
  const selection = selections.get(event.key);

  // reject incomplete private calibration traces
  if (selection === undefined) {
    throw new Error("adaptive temperature selection is missing");
  }

  return selection;
}

// apply one selected fraction of the complete raw-start correction
function adaptivePrediction(
  event: EvaluatedEvent,
  selections: ReadonlyMap<string, AdaptiveSelection>,
): number {
  const alpha = adaptiveSelectionFor(event, selections).selectedAlpha;
  return event.rawForecast +
    alpha * (event.predictions.rawTemperatureWeather - event.rawForecast);
}

// score causal adaptive predictions over one exact event subset
function scoreAdaptive(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one privately selected correction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: adaptivePrediction(event, selections),
    }),
  ));
}

// compare the adaptive result with both source strategies
function compareAdaptive(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
): TemperatureWeatherAdaptiveComparison {
  return {
    causalAdaptive: scoreAdaptive(events, selections),
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
  };
}

// count every frozen alpha and calibration-support partition
function adaptiveAlphaSelectionCounts(
  selections: ReadonlyMap<string, AdaptiveSelection>,
): readonly TemperatureWeatherAdaptiveAlphaSelectionCount[] {
  return TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.map(
    // emit one explicit count for each fixed alpha
    (alpha) => {
      const matches = [...selections.values()].filter(
        // isolate one selected alpha
        (selection) => selection.selectedAlpha === alpha,
      );
      const calibratedSelectionCount = matches.filter(
        // count supported selections
        (selection) => selection.calibrated,
      ).length;

      return {
        alpha,
        calibratedSelectionCount,
        selectionCount: matches.length,
        uncalibratedSelectionCount:
          matches.length - calibratedSelectionCount,
      };
    },
  );
}

// build one aggregate live-only adaptive view
function createAdaptiveEvaluatedView(
  core: TemperatureWeatherAnalysisCore,
): TemperatureWeatherAdaptiveEvaluatedView {
  const calibration = core.evaluated.length === 0
    ? {
      audit: { selectionCount: 0, violationCount: 0 },
      byEventKey: new Map<string, AdaptiveSelection>(),
    }
    : adaptiveSelections(core.evaluated);
  const selections = calibration.byEventKey;
  const calibrated = core.evaluated.filter(
    // retain only causally supported score events
    (event) => adaptiveSelectionFor(event, selections).calibrated,
  );
  const first48 = core.evaluated.filter(
    // isolate the near-term score window
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the longer score window
    (event) => event.targetLeadHours > 48,
  );
  const overall = compareAdaptive(core.evaluated, selections);

  return {
    after48Hours: compareAdaptive(after48, selections),
    calibratedSubset: compareAdaptive(calibrated, selections),
    causalAudit: calibration.audit,
    coverage: {
      alphaSelectionCounts: adaptiveAlphaSelectionCounts(selections),
      calibratedEventCount: calibrated.length,
      eventCount: core.evaluated.length,
      nonzeroCorrectionCount: overall.causalAdaptive.correctionUseCount,
      uncalibratedEventCount: core.evaluated.length - calibrated.length,
    },
    diagnostics: createWeatherDiagnostics(
      core,
      // score each unchanged slice with the frozen experiment state
      (events) => compareAdaptive(events, selections),
    ),
    first48Hours: compareAdaptive(first48, selections),
    overall,
    policy: adaptivePolicy(),
    reason: null,
    status: core.evaluated.length === 0 ? "empty_live_cohort" : "evaluated",
  };
}

// build one explicit archive control view
function createAdaptiveArchiveView(): TemperatureWeatherAdaptiveArchiveView {
  return {
    after48Hours: null,
    calibratedSubset: null,
    causalAudit: null,
    coverage: null,
    diagnostics: null,
    first48Hours: null,
    overall: null,
    policy: adaptivePolicy(),
    reason: "archive_has_no_observed_retrieval_time",
    status: "not_applicable_archive_cohort",
  };
}

// create the fixed hybrid policy
function hybridPolicy(): TemperatureWeatherHybridPolicy {
  return {
    aboveThresholdStrategy: "rawTemperatureWeather",
    atOrBelowThresholdStrategy: "causalAdaptive",
    calibration: adaptivePolicy(),
    datesConsumed: true,
    productionActivationAllowed: false,
    promotable: false,
    selectedAfterExaminingPriorResults: true,
    thresholdHours: TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  };
}

// choose one fixed hybrid prediction
function hybridPrediction(
  event: EvaluatedEvent,
  selections: ReadonlyMap<string, AdaptiveSelection>,
): number {
  // adapt only the first forty-eight lead hours
  if (event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS) {
    return adaptivePrediction(event, selections);
  }

  return event.predictions.rawTemperatureWeather;
}

// score fixed hybrid predictions over one exact event subset
function scoreHybrid(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one fixed hybrid prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: hybridPrediction(event, selections),
    }),
  ));
}

// compare the hybrid with every inherited source strategy
function compareHybrid(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
): TemperatureWeatherHybridComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
    causalAdaptive: scoreAdaptive(events, selections),
    gatedAfter48Hours: scoreGatedAfter48Hours(events),
    hybrid: scoreHybrid(events, selections),
  };
}

// count fixed alphas over one exact event subset
function adaptiveAlphaSelectionCountsForEvents(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
): readonly TemperatureWeatherAdaptiveAlphaSelectionCount[] {
  const subset = new Map(events.map(
    // retain each requested private selection
    (event) => [event.key, adaptiveSelectionFor(event, selections)],
  ));
  return adaptiveAlphaSelectionCounts(subset);
}

// build one aggregate live-only hybrid view
function createHybridEvaluatedView(
  core: TemperatureWeatherAnalysisCore,
): TemperatureWeatherHybridEvaluatedView {
  const calibration = core.evaluated.length === 0
    ? {
      audit: { selectionCount: 0, violationCount: 0 },
      byEventKey: new Map<string, AdaptiveSelection>(),
    }
    : adaptiveSelections(core.evaluated);
  const selections = calibration.byEventKey;
  const first48 = core.evaluated.filter(
    // isolate the adaptive side of the hybrid
    (event) => event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const after48 = core.evaluated.filter(
    // isolate the complete-correction side of the hybrid
    (event) => event.targetLeadHours > TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const first48CalibratedEventCount = first48.filter(
    // count supported near-term selections
    (event) => adaptiveSelectionFor(event, selections).calibrated,
  ).length;
  const first48NonzeroCorrectionCount = scoreAdaptive(
    first48,
    selections,
  ).correctionUseCount;
  const after48NonzeroCorrectionCount = scoreStrategy(
    after48,
    "rawTemperatureWeather",
  ).correctionUseCount;
  const overall = compareHybrid(core.evaluated, selections);
  const differsFromGatedAfter48HoursCount = core.evaluated.filter(
    // count hybrid changes from the prior fixed gate
    (event) => hybridPrediction(event, selections) !== gatedAfter48Prediction(event),
  ).length;

  return {
    after48Hours: compareHybrid(after48, selections),
    causalAudit: calibration.audit,
    coverage: {
      eventCount: core.evaluated.length,
      first48EventCount: first48.length,
      after48EventCount: after48.length,
      first48CalibratedEventCount,
      first48UncalibratedEventCount:
        first48.length - first48CalibratedEventCount,
      first48NonzeroCorrectionCount,
      after48NonzeroCorrectionCount,
      nonzeroCorrectionCount: overall.hybrid.correctionUseCount,
      differsFromGatedAfter48HoursCount,
      first48AlphaSelectionCounts: adaptiveAlphaSelectionCountsForEvents(
        first48,
        selections,
      ),
    },
    diagnostics: createWeatherDiagnostics(
      core,
      // score each unchanged slice with the frozen experiment state
      (events) => compareHybrid(events, selections),
    ),
    first48Hours: compareHybrid(first48, selections),
    overall,
    policy: hybridPolicy(),
    reason: null,
    status: core.evaluated.length === 0 ? "empty_live_cohort" : "evaluated",
  };
}

// build one explicit archive hybrid control view
function createHybridArchiveView(): TemperatureWeatherHybridArchiveView {
  return {
    after48Hours: null,
    causalAudit: null,
    coverage: null,
    diagnostics: null,
    first48Hours: null,
    overall: null,
    policy: hybridPolicy(),
    reason: "archive_has_no_observed_retrieval_time",
    status: "not_applicable_archive_cohort",
  };
}

// create the fixed boosted hybrid policy
function boostedHybridPolicy(): TemperatureBoostedHybridPolicy {
  return {
    aboveThresholdStrategy: "boostedTemperature",
    atOrBelowThresholdStrategy: "causalAdaptive",
    calibration: adaptivePolicy(),
    datesConsumed: true,
    fixedSourceModels: true,
    noAdditionalPredictionCapping: true,
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    thresholdHours: TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  };
}

// choose one fixed boosted hybrid prediction
function boostedHybridPrediction(
  event: EvaluatedEvent,
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
): number {
  // retain causal adaptation through the exact boundary
  if (event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS) {
    return adaptivePrediction(event, selections);
  }

  // reuse the already-capped boosted prediction unchanged
  return boostedPrediction(event, boostedState);
}

// score fixed boosted hybrid predictions over one exact subset
function scoreBoostedHybrid(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one fixed boosted hybrid prediction
    (event) => ({
      event: {
        actual: event.actual,
        localDate: event.localDate,
        rawForecast: event.rawForecast,
        validAt: event.validAt,
      },
      prediction: boostedHybridPrediction(event, selections, boostedState),
    }),
  ));
}

// compare the boosted hybrid with every fixed component
function compareBoostedHybrid(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
): TemperatureBoostedHybridComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
    boostedTemperature: scoreBoosted(events, boostedState),
    causalAdaptive: scoreAdaptive(events, selections),
    hybrid: scoreHybrid(events, selections),
    boostedHybrid: scoreBoostedHybrid(events, selections, boostedState),
  };
}

// build one aggregate live-only boosted hybrid analysis
function createBoostedHybridEvaluatedAnalysis(
  core: TemperatureWeatherAnalysisCore,
  boostedState: TemperatureBoostedPredictionState,
): {
  readonly selections: ReadonlyMap<string, AdaptiveSelection>;
  readonly view: TemperatureBoostedHybridEvaluatedView;
} {
  const calibration = core.evaluated.length === 0
    ? {
      audit: { selectionCount: 0, violationCount: 0 },
      byEventKey: new Map<string, AdaptiveSelection>(),
    }
    : adaptiveSelections(core.evaluated);
  const selections = calibration.byEventKey;
  const first48 = core.evaluated.filter(
    // isolate the adaptive component
    (event) => event.targetLeadHours <= TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const after48 = core.evaluated.filter(
    // isolate the boosted component
    (event) => event.targetLeadHours > TEMPERATURE_WEATHER_HORIZON_GATE_THRESHOLD_HOURS,
  );
  const first48CalibratedEventCount = first48.filter(
    // count causally supported near-term rows
    (event) => adaptiveSelectionFor(event, selections).calibrated,
  ).length;
  const eligibleAfter48 = after48.filter(
    // isolate longer-range rows eligible for native predictions
    (event) => event.baselineEligible,
  );
  const first48NonzeroCorrectionCount = scoreAdaptive(
    first48,
    selections,
  ).correctionUseCount;
  const after48NonzeroCorrectionCount = scoreBoosted(
    after48,
    boostedState,
  ).correctionUseCount;
  const overall = compareBoostedHybrid(
    core.evaluated,
    selections,
    boostedState,
  );
  const modelPredictionCount = boostedState.modelAvailable
    ? eligibleAfter48.length
    : 0;

  const view: TemperatureBoostedHybridEvaluatedView = {
    after48Hours: compareBoostedHybrid(after48, selections, boostedState),
    causalAudit: calibration.audit,
    coverage: {
      eventCount: core.evaluated.length,
      first48EventCount: first48.length,
      after48EventCount: after48.length,
      first48CalibratedEventCount,
      first48UncalibratedEventCount:
        first48.length - first48CalibratedEventCount,
      first48NonzeroCorrectionCount,
      after48NonzeroCorrectionCount,
      nonzeroCorrectionCount: overall.boostedHybrid.correctionUseCount,
      modelPredictionCount,
      modelFallbackCount: after48.length - modelPredictionCount,
      missingFeatureCount: eligibleAfter48.filter(
        // count natively routed longer-range weather gaps
        (event) =>
          event.rawRelativeHumidityPercent === null ||
          event.rawWindSpeedMps === null,
      ).length,
      differsFromPriorHybridCount: core.evaluated.filter(
        // compare only exact composed predictions
        (event) =>
          boostedHybridPrediction(event, selections, boostedState) !==
          hybridPrediction(event, selections),
      ).length,
      first48AlphaSelectionCounts: adaptiveAlphaSelectionCountsForEvents(
        first48,
        selections,
      ),
    },
    diagnostics: createWeatherDiagnostics(
      core,
      // score each unchanged slice with the frozen experiment state
      (events) => compareBoostedHybrid(events, selections, boostedState),
    ),
    first48Hours: compareBoostedHybrid(first48, selections, boostedState),
    overall,
    policy: boostedHybridPolicy(),
    reason: null,
    status: core.evaluated.length === 0 ? "empty_live_cohort" : "evaluated",
  };

  return { selections, view };
}

// preserve the original boosted hybrid construction boundary
function createBoostedHybridEvaluatedView(
  core: TemperatureWeatherAnalysisCore,
  boostedState: TemperatureBoostedPredictionState,
): TemperatureBoostedHybridEvaluatedView {
  return createBoostedHybridEvaluatedAnalysis(core, boostedState).view;
}

// build one explicit archive boosted hybrid control
function createBoostedHybridArchiveView(): TemperatureBoostedHybridArchiveView {
  return {
    after48Hours: null,
    causalAudit: null,
    coverage: null,
    diagnostics: null,
    first48Hours: null,
    overall: null,
    policy: boostedHybridPolicy(),
    reason: "archive_has_no_observed_retrieval_time",
    status: "not_applicable_archive_cohort",
  };
}

// freeze the selected recent-error nowcast policy
function nearNowcastPolicy(): TemperatureNearNowcastPolicy {
  return {
    after48HoursStrategy: "boostedTemperature",
    assumedObservationAvailabilityLagHours:
      TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS,
    availabilityEvidenceStatus:
      "pseudo_real_time_retrospective_not_independently_validated",
    correctionMaximumC: TEMPERATURE_NOWCAST_MAXIMUM_CORRECTION_C,
    correctionMinimumC: TEMPERATURE_NOWCAST_MINIMUM_CORRECTION_C,
    first12HoursStrategy: "recent_raw_error_persistence",
    halfLifeHours: TEMPERATURE_NOWCAST_HALF_LIFE_HOURS,
    hours13To48Strategy: "causalAdaptive",
    latestSourceReferenceTiePolicy:
      "prefer_lexicographically_greatest_key",
    lookbackHours: TEMPERATURE_NOWCAST_LOOKBACK_HOURS,
    maximumSourceLeadHours: TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS,
    maximumTargetLeadHours: TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS,
    noArchiveWarmStart: true,
    noNativeRefit: true,
    noOldCorrectionAdded: true,
    physicalMaximumC: TEMPERATURE_NOWCAST_PHYSICAL_MAXIMUM_C,
    physicalMinimumC: TEMPERATURE_NOWCAST_PHYSICAL_MINIMUM_C,
    productionActivationAllowed: false,
    promotable: false,
    requiredUniqueHours: TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    sourceError: "actual_minus_raw_temperature",
    sourceHourPolicy: "latest_three_distinct_valid_hours",
  };
}

// snapshot and validate one optional private audit callback
function nearNowcastAuditCallback(
  value: TemperatureNearNowcastPrivateAuditCallback | undefined,
): TemperatureNearNowcastPrivateAuditCallback | undefined {
  // preserve a missing private sink
  if (value === undefined) {
    return undefined;
  }

  // reject non-callable JavaScript inputs
  if (typeof value !== "function") {
    throw new RangeError("onPrivatePredictionAudit must be a function");
  }

  return value;
}

// deep-freeze isolated private audit records
function freezeNearNowcastAuditRecords(
  records: readonly TemperatureNowcastPrivateAuditRecord[],
): readonly TemperatureNowcastPrivateAuditRecord[] {
  return Object.freeze(records.map(
    // isolate every target record
    (record) => Object.freeze({
      ...record,
      selectedSources: Object.freeze(record.selectedSources.map(
        // isolate every selected source record
        (source) => Object.freeze({ ...source }),
      )),
    }),
  ));
}

// map one evaluated event into the isolated pure algorithm
function temperatureNowcastEvent(
  event: EvaluatedEvent,
  priorPrediction: number,
): TemperatureNowcastResearchEvent {
  // require truthful live references for the nowcast
  if (event.referenceAt === null) {
    throw new Error("temperature nowcast requires live references");
  }

  return {
    actual: event.actual,
    baselineEligible: event.baselineEligible,
    daypart: event.daypart,
    humidityBin: event.humidityBin,
    key: event.key,
    leadBand: event.leadBand,
    localDate: event.localDate,
    priorPrediction,
    rawForecast: event.rawForecast,
    rawRelativeHumidityPercent: event.rawRelativeHumidityPercent,
    rawWindSpeedMps: event.rawWindSpeedMps,
    referenceAt: event.referenceAt,
    season: event.season,
    sixHourBucket: event.sixHourBucket,
    targetLeadHours: event.targetLeadHours,
    temperatureBin: event.temperatureBin,
    validAt: event.validAt,
    windSpeedBin: event.windSpeedBin,
  };
}

// score private nowcast predictions over one exact subset
function scoreNearNowcast(
  events: readonly EvaluatedEvent[],
  audit: TemperatureNowcastPredictionAudit,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(events.map(
    // project one privately retained nowcast prediction
    (event) => {
      const prediction = audit.predictionByKey.get(event.key);

      // reject incomplete private prediction maps
      if (prediction === undefined) {
        throw new Error("temperature nowcast prediction is missing");
      }

      return {
        event: {
          actual: event.actual,
          localDate: event.localDate,
          rawForecast: event.rawForecast,
          validAt: event.validAt,
        },
        prediction,
      };
    },
  ));
}

// compare the nowcast with both exact controls
function compareNearNowcast(
  events: readonly EvaluatedEvent[],
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
  audit: TemperatureNowcastPredictionAudit,
): TemperatureNearNowcastComparison {
  return {
    raw: scoreStrategy(events, "raw"),
    boostedHybrid: scoreBoostedHybrid(events, selections, boostedState),
    nearNowcast: scoreNearNowcast(events, audit),
  };
}

// build all six diagnostics over one optional horizon subset
function createNearNowcastDiagnostics(
  core: TemperatureWeatherAnalysisCore,
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
  audit: TemperatureNowcastPredictionAudit,
  include: (event: EvaluatedEvent) => boolean,
): TemperatureNearNowcastDiagnostics {
  return createWeatherDiagnostics(
    core,
    // retain every diagnostic slice while filtering its scored horizon
    (events) => compareNearNowcast(
      events.filter(include),
      selections,
      boostedState,
      audit,
    ),
  );
}

// count one fallback reason across the private audit
function nearNowcastFallbackCount(
  records: readonly TemperatureNowcastPrivateAuditRecord[],
  reason: TemperatureNowcastFallbackReason,
): number {
  return records.filter(
    // isolate one complete fallback partition
    (record) => record.fallbackReason === reason,
  ).length;
}

// verify every selected source causality boundary
function nearNowcastCausalAudit(
  records: readonly TemperatureNowcastPrivateAuditRecord[],
  auditSha256: string,
): TemperatureNearNowcastEvaluatedView["causalAudit"] {
  let lookbackViolationCount = 0;
  let maturityViolationCount = 0;
  let referenceOrderViolationCount = 0;
  let selectedSourceCount = 0;
  let sourceLeadViolationCount = 0;

  // inspect every private target and selected source
  for (const record of records) {
    const targetReferenceMilliseconds = Date.parse(record.referenceAt);

    // inspect each selected causal source
    for (const source of record.selectedSources) {
      selectedSourceCount += 1;

      // count unsupported source leads
      if (source.targetLeadHours > TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS) {
        sourceLeadViolationCount += 1;
      }

      // count nonpreceding source vintages
      if (Date.parse(source.referenceAt) >= targetReferenceMilliseconds) {
        referenceOrderViolationCount += 1;
      }

      // count observations not yet assumed available
      if (Date.parse(source.availableAt) > targetReferenceMilliseconds) {
        maturityViolationCount += 1;
      }

      // count sources outside the inclusive valid-time window
      if (
        source.ageHoursAtReference < 0 ||
        source.ageHoursAtReference > TEMPERATURE_NOWCAST_LOOKBACK_HOURS
      ) {
        lookbackViolationCount += 1;
      }
    }
  }

  return {
    auditSha256,
    lookbackViolationCount,
    maturityViolationCount,
    recordCount: records.length,
    referenceOrderViolationCount,
    selectedSourceCount,
    sourceLeadViolationCount,
  };
}

// build the aggregate live-only nowcast view
function createNearNowcastEvaluatedView(
  core: TemperatureWeatherAnalysisCore,
  selections: ReadonlyMap<string, AdaptiveSelection>,
  boostedState: TemperatureBoostedPredictionState,
  callback: TemperatureNearNowcastPrivateAuditCallback | undefined,
): TemperatureNearNowcastEvaluatedView {
  const audit = createTemperatureNowcastPredictionAudit(core.evaluated.map(
    // retain each exact old hybrid prediction as the fallback
    (event) => temperatureNowcastEvent(
      event,
      boostedHybridPrediction(event, selections, boostedState),
    ),
  ));
  const records = freezeNearNowcastAuditRecords(audit.records);
  const auditSha256 = canonicalSha256(records as unknown as JsonValue);

  // expose private rows exactly once when requested
  if (callback !== undefined) {
    callback(records);
  }

  const first6 = core.evaluated.filter(
    // isolate leads through six hours
    (event) => event.targetLeadHours <= 6,
  );
  const hours7To12 = core.evaluated.filter(
    // isolate leads seven through twelve
    (event) => event.targetLeadHours >= 7 && event.targetLeadHours <= 12,
  );
  const first12 = core.evaluated.filter(
    // isolate the primary nowcast horizon
    (event) => event.targetLeadHours <= 12,
  );
  const hours13To24 = core.evaluated.filter(
    // isolate leads thirteen through twenty-four
    (event) => event.targetLeadHours >= 13 && event.targetLeadHours <= 24,
  );
  const hours25To48 = core.evaluated.filter(
    // isolate leads twenty-five through forty-eight
    (event) => event.targetLeadHours >= 25 && event.targetLeadHours <= 48,
  );
  const hours13To48 = core.evaluated.filter(
    // isolate the unchanged adaptive interval
    (event) => event.targetLeadHours >= 13 && event.targetLeadHours <= 48,
  );
  const first48 = core.evaluated.filter(
    // isolate the full near-term interval
    (event) => event.targetLeadHours <= 48,
  );
  const after48 = core.evaluated.filter(
    // isolate the unchanged boosted interval
    (event) => event.targetLeadHours > 48,
  );
  const adjustedRecords = records.filter(
    // retain targets with complete persistence support
    (record) => record.fallbackReason === null,
  );
  const latestSourceAges = adjustedRecords.map(
    // retain one decay age for each adjusted target
    (record) => record.latestSourceAgeToTargetHours,
  ).filter(
    // narrow complete adjusted ages
    (age): age is number => age !== null,
  );
  const selectedSourceHours = new Set(records.flatMap(
    // retain every selected source valid hour
    (record) => record.selectedSources.map(
      // project one unique valid-hour identity
      (source) => source.validAt,
    ),
  ));
  const overall = compareNearNowcast(
    core.evaluated,
    selections,
    boostedState,
    audit,
  );

  return {
    after48Hours: compareNearNowcast(after48, selections, boostedState, audit),
    causalAudit: nearNowcastCausalAudit(records, auditSha256),
    coverage: {
      adjustedEventCount: adjustedRecords.length,
      differsFromBoostedHybridCount: records.filter(
        // count exact changes from the frozen source hybrid
        (record) =>
          record.nearNowcastPrediction !==
          record.priorBoostedHybridPrediction,
      ).length,
      eventCount: records.length,
      fallbackCounts: {
        baseline_ineligible: nearNowcastFallbackCount(
          records,
          "baseline_ineligible",
        ),
        insufficient_unique_source_hours: nearNowcastFallbackCount(
          records,
          "insufficient_unique_source_hours",
        ),
        outside_first_12_hours: nearNowcastFallbackCount(
          records,
          "outside_first_12_hours",
        ),
      },
      first12BaselineEligibleEventCount: first12.filter(
        // count eligible primary-horizon rows
        (event) => event.baselineEligible,
      ).length,
      first12EventCount: first12.length,
      first12FallbackEventCount: records.filter(
        // count primary-horizon rows retaining the prior prediction
        (record) =>
          record.targetLeadHours <= TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS &&
          record.fallbackReason !== null,
      ).length,
      nonzeroCorrectionCount: adjustedRecords.filter(
        // count only nonzero corrections introduced by this challenger
        (record) =>
          record.nowcastCorrection !== null && record.nowcastCorrection !== 0,
      ).length,
      priorFallbackEventCount: records.length - adjustedRecords.length,
      selectedSourceCount: records.reduce(
        // sum every selected source occurrence
        (sum, record) => sum + record.selectedSources.length,
        0,
      ),
      uniqueSelectedSourceHourCount: selectedSourceHours.size,
    },
    diagnostics: createNearNowcastDiagnostics(
      core,
      selections,
      boostedState,
      audit,
      // include the complete score cohort
      () => true,
    ),
    first12Diagnostics: createNearNowcastDiagnostics(
      core,
      selections,
      boostedState,
      audit,
      // isolate the primary horizon in every diagnostic
      (event) => event.targetLeadHours <= TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS,
    ),
    first12Hours: compareNearNowcast(first12, selections, boostedState, audit),
    first48Hours: compareNearNowcast(first48, selections, boostedState, audit),
    first6Hours: compareNearNowcast(first6, selections, boostedState, audit),
    hours13To24: compareNearNowcast(hours13To24, selections, boostedState, audit),
    hours13To48: compareNearNowcast(hours13To48, selections, boostedState, audit),
    hours25To48: compareNearNowcast(hours25To48, selections, boostedState, audit),
    hours7To12: compareNearNowcast(hours7To12, selections, boostedState, audit),
    overall,
    policy: nearNowcastPolicy(),
    reason: null,
    sourceAge: {
      adjustedEventCount: latestSourceAges.length,
      maximumLatestSourceAgeToTargetHours:
        latestSourceAges.length === 0 ? null : Math.max(...latestSourceAges),
      meanLatestSourceAgeToTargetHours: latestSourceAges.length === 0
        ? null
        : latestSourceAges.reduce(
          // average each complete latest-source age
          (sum, age) => sum + age,
          0,
        ) / latestSourceAges.length,
      minimumLatestSourceAgeToTargetHours:
        latestSourceAges.length === 0 ? null : Math.min(...latestSourceAges),
    },
    status: core.evaluated.length === 0 ? "empty_live_cohort" : "evaluated",
  };
}

// build one explicit archive nowcast control
function createNearNowcastArchiveView(): TemperatureNearNowcastArchiveView {
  return {
    after48Hours: null,
    causalAudit: null,
    coverage: null,
    diagnostics: null,
    first12Diagnostics: null,
    first12Hours: null,
    first48Hours: null,
    first6Hours: null,
    hours13To24: null,
    hours13To48: null,
    hours25To48: null,
    hours7To12: null,
    overall: null,
    policy: nearNowcastPolicy(),
    reason: "archive_has_no_observed_retrieval_time",
    sourceAge: null,
    status: "not_applicable_archive_cohort",
  };
}

// run the frozen offline weather-conditioning experiment
export function analyzeTemperatureWeatherResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherResearchReport {
  return analyzeTemperatureWeatherCore(input).report;
}

// run the fixed horizon ablation without refitting its source model
export function analyzeTemperatureWeatherHorizonResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherHorizonResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    contractVersion: TEMPERATURE_WEATHER_HORIZON_RESEARCH_CONTRACT_VERSION,
    horizonGate: createHorizonGate(core),
  };
}

// run the raw-start temperature-only ablation without refitting
export function analyzeTemperatureOnlyResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureOnlyResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    contractVersion: TEMPERATURE_ONLY_RESEARCH_CONTRACT_VERSION,
    temperatureOnly: createTemperatureOnlyAblation(core),
  };
}

// run live causal scaling without refitting the source weather model
export function analyzeTemperatureWeatherAdaptiveResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherAdaptiveResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    adaptiveCorrection: input.scoreCohort === "fixed_lead_anchor"
      ? createAdaptiveArchiveView()
      : createAdaptiveEvaluatedView(core),
    contractVersion: TEMPERATURE_WEATHER_ADAPTIVE_RESEARCH_CONTRACT_VERSION,
  };
}

// run the fixed live hybrid without refitting either source strategy
export function analyzeTemperatureWeatherHybridResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherHybridResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    contractVersion: TEMPERATURE_WEATHER_HYBRID_RESEARCH_CONTRACT_VERSION,
    hybridCorrection: input.scoreCohort === "fixed_lead_anchor"
      ? createHybridArchiveView()
      : createHybridEvaluatedView(core),
  };
}

// run static weather shrinkage without refitting either component
export function analyzeTemperatureWeatherShrinkageResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherShrinkageResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    contractVersion: TEMPERATURE_WEATHER_SHRINKAGE_RESEARCH_CONTRACT_VERSION,
    weatherShrinkage: createWeatherShrinkageView(core),
  };
}

// run the fixed recent-training experiment without changing original controls
export function analyzeTemperatureWeatherRecencyResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherRecencyResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    contractVersion: TEMPERATURE_WEATHER_RECENCY_RESEARCH_CONTRACT_VERSION,
    recencyTraining: createRecencyTrainingView(core),
  };
}

// run one injected boosted residual experiment over the frozen controls
export function analyzeTemperatureBoostedResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainer: TemperatureBoostedTrainer;
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureBoostedResearchReport {
  const core = analyzeTemperatureWeatherCore(input);

  return {
    ...core.report,
    boostedResidual: createBoostedResidualView(core, input.trainer),
    contractVersion: TEMPERATURE_BOOSTED_RESEARCH_CONTRACT_VERSION,
  };
}

// run the fixed boosted hybrid without refitting either component
export function analyzeTemperatureBoostedHybridResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainer: TemperatureBoostedTrainer;
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureBoostedHybridResearchReport {
  const core = analyzeTemperatureWeatherCore(input);
  const boosted = createBoostedResidualAnalysis(core, input.trainer);

  return {
    ...core.report,
    boostedResidual: boosted.view,
    boostedHybrid: input.scoreCohort === "fixed_lead_anchor"
      ? createBoostedHybridArchiveView()
      : createBoostedHybridEvaluatedView(core, boosted.state),
    contractVersion: TEMPERATURE_BOOSTED_HYBRID_RESEARCH_CONTRACT_VERSION,
  };
}

// run one first-twelve-hour persistence challenger over the fixed hybrid
export function analyzeTemperatureNearNowcastResearch(input: {
  readonly onPrivatePredictionAudit?: TemperatureNearNowcastPrivateAuditCallback;
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainer: TemperatureBoostedTrainer;
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureNearNowcastResearchReport {
  const callback = nearNowcastAuditCallback(input.onPrivatePredictionAudit);
  const core = analyzeTemperatureWeatherCore(input);
  const boosted = createBoostedResidualAnalysis(core, input.trainer);

  // retain explicit archive non-applicability without private rows
  if (input.scoreCohort === "fixed_lead_anchor") {
    return {
      ...core.report,
      boostedResidual: boosted.view,
      boostedHybrid: createBoostedHybridArchiveView(),
      contractVersion: TEMPERATURE_NEAR_NOWCAST_RESEARCH_CONTRACT_VERSION,
      nearNowcast: createNearNowcastArchiveView(),
    };
  }

  const boostedHybrid = createBoostedHybridEvaluatedAnalysis(
    core,
    boosted.state,
  );

  return {
    ...core.report,
    boostedResidual: boosted.view,
    boostedHybrid: boostedHybrid.view,
    contractVersion: TEMPERATURE_NEAR_NOWCAST_RESEARCH_CONTRACT_VERSION,
    nearNowcast: createNearNowcastEvaluatedView(
      core,
      boostedHybrid.selections,
      boosted.state,
      callback,
    ),
  };
}
