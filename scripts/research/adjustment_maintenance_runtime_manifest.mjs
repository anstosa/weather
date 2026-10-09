const FORECAST_ADJUSTMENT_FILES = Object.freeze([
  "algorithm-v1.js",
  "apply.js",
  "bootstrap-v1.js",
  "calendar.js",
  "candidate.js",
  "evaluate.js",
  "evidence.js",
  "holdout-ledger.js",
  "maintenance-policy.js",
  "maintenance-runtime-package.js",
  "maintenance-revision-projection.js",
  "maintenance-shadow-catalog.js",
  "maintenance-shadow-comparator.js",
  "maintenance-shadow-values.js",
  "rain-hurdle-wind-artifact.js",
  "rain-hurdle-wind.js",
  "rain-maintenance-controls.js",
  "rain-fixed-gauge-target.js",
  "runtime-bundle.js",
  "runtime-loader.js",
  "temperature-canary.js",
  "temperature-lead-research.js",
  "temperature-mos-runtime.js",
  "temperature-nowcast-research.js",
  "temperature-weather-research.js",
  "wind-canary.js",
]);
const DOMAIN_FILES = Object.freeze([
  "forecast-adjustment.js",
  "forecast-anchor-record.js",
  "index.js",
  "ingestion.js",
  "provenance.js",
  "rain-collection.js",
  "weather-record.js",
]);
const FIT_ONLY_FORECAST_ADJUSTMENT_FILES = Object.freeze([
  "index.js",
  "maintenance-capture-epoch.js",
  "performance-scorecard.js",
  "rain-runtime-registry.js",
  "temperature-analog-research.js",
  "temperature-analog-shrinkage.js",
  "temperature-analog-stress-validation.js",
  "temperature-analog-validation.js",
  "temperature-causal-guard.js",
  "temperature-frozen-replay.js",
  "temperature-live-replay-events.js",
]);

// bind each committed snapshot to its reviewed compiler output
export const ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_GENERATED_FILES = Object.freeze([
  ...FORECAST_ADJUSTMENT_FILES.map(
    // retain one exact forecast source and committed snapshot pair
    (name) => Object.freeze({
      generatedSource: `packages/forecast-adjustment/dist/${name}`,
      snapshot: `scripts/research/adjustment-maintenance-runtime/forecast/${name}`,
    }),
  ),
  ...DOMAIN_FILES.map(
    // retain one exact domain source and committed snapshot pair
    (name) => Object.freeze({
      generatedSource: `packages/domain/dist/${name}`,
      snapshot: `scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/dist/${name}`,
    }),
  ),
]);

// bind fit-only compiled entrypoints to committed runtime snapshots
export const ADJUSTMENT_FIT_RUNTIME_GENERATED_FILES = Object.freeze([
  ...FIT_ONLY_FORECAST_ADJUSTMENT_FILES.map(
    // retain one exact forecast fitter source and committed snapshot pair
    (name) => Object.freeze({
      generatedSource: `packages/forecast-adjustment/dist/${name}`,
      snapshot: `scripts/research/adjustment-maintenance-runtime/forecast/${name}`,
    }),
  ),
  Object.freeze({
    generatedSource: "apps/worker/dist/forecast-adjustment-wind-refresh-cli.js",
    snapshot: "scripts/research/adjustment-maintenance-runtime/worker/forecast-adjustment-wind-refresh-cli.js",
  }),
]);

// enumerate fit-only committed snapshots outside the adapter import graph
export const ADJUSTMENT_FIT_RUNTIME_SOURCE_FILES = Object.freeze(
  ADJUSTMENT_FIT_RUNTIME_GENERATED_FILES.map(
    // install every snapshot at its import-independent repository path
    ({ snapshot }) => Object.freeze({ destination: snapshot, source: snapshot }),
  ),
);

// freeze the complete installed plain-js dependency closure
export const ADJUSTMENT_MAINTENANCE_RUNTIME_ADAPTER_SOURCE_FILES = Object.freeze([
  Object.freeze({
    destination: "scripts/research/adjustment_maintenance_runtime_adapter.mjs",
    source: "scripts/research/adjustment_maintenance_runtime_adapter.mjs",
  }),
  Object.freeze({
    destination: "scripts/research/adjustment_maintenance_runtime_manifest.mjs",
    source: "scripts/research/adjustment_maintenance_runtime_manifest.mjs",
  }),
  Object.freeze({
    destination: "deploy/scripts/adjustment-evidence-store.mjs",
    source: "deploy/scripts/adjustment-evidence-store.mjs",
  }),
  Object.freeze({
    destination: "scripts/research/adjustment_plaintext_archive.mjs",
    source: "scripts/research/adjustment_plaintext_archive.mjs",
  }),
  Object.freeze({
    destination: "scripts/research/adjustment_rain_model_package.mjs",
    source: "scripts/research/adjustment_rain_model_package.mjs",
  }),
  Object.freeze({
    destination: "scripts/research/adjustment-maintenance-runtime/forecast/package.json",
    source: "scripts/research/adjustment-maintenance-runtime/forecast/package.json",
  }),
  ...FORECAST_ADJUSTMENT_FILES.map(
    // preserve each reviewed forecast runtime at its import-relative path
    (name) => Object.freeze({
      destination: `scripts/research/adjustment-maintenance-runtime/forecast/${name}`,
      source: `scripts/research/adjustment-maintenance-runtime/forecast/${name}`,
    }),
  ),
  Object.freeze({
    destination: "scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/package.json",
    source: "scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/package.json",
  }),
  ...DOMAIN_FILES.map(
    // install the workspace dependency under its declared package name
    (name) => Object.freeze({
      destination: `scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/dist/${name}`,
      source: `scripts/research/adjustment-maintenance-runtime/node_modules/@weather/domain/dist/${name}`,
    }),
  ),
]);
