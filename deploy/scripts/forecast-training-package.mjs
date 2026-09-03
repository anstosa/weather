#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { gzipSync, gunzipSync } from "node:zlib";

const PACKAGE_VERSION = "forecast-training-export-package/v1";
const MANIFEST_VERSION = "forecast-training-export-manifest/v1";
const SITE_KEY = "ballydidean";
const SITE_TIMEZONE = "America/Los_Angeles";
const MAX_DAYS = 450;
const MAX_ROWS = 4_000_000;
const CONSERVATIVE_EXPORT_ROWS = 3_045_600;
const EXPORT_ROW_HEADROOM = 954_400;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_COMPONENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const QUERY_CONTRACT_VERSION = "forecast-training-export-query/v2";
const SCHEMA_MIGRATION = "0010_forecast_training_export.sql";
const EXPECTED_MANIFEST_HASHES = {
  aggregation_contract_sha256:
    "9c309ef5a00780167570746ad6c31b9128c266db50954fe4645287e1f2b31e64",
  coordinate_manifest_sha256:
    "04bfd93a03c393e977c8767a9aca6fe2a4cba9c263cb46e6987fa733b666ba58",
  metric_eligibility_sha256:
    "53731954b347836a26500b05a195ca15cf26214c4d561fe482c5ff87ef56a82e",
  query_contract_sha256:
    "3b7926c47bbdb208ac2e305ee7798bfe4ea9590ce2863f556e752a71d1158e76",
  row_schema_sha256:
    "2717b6c3c704a1b52c7748b59c37d635efd92d92efb9dc97ea4ddef97cd504fc",
  source_lineage_sha256:
    "261a134589a12c1bbbd9a783343950317fd1fbc87e08383e60e805b7761566cc",
  spatial_weights_sha256:
    "8ed5ce70d33edd4a5166049d9938cbaaf800151b6a0b3345d3005419e9041c74",
  station_manifest_sha256:
    "a1f76440c056987bbb434d5315e4916f961deeb2951fe889d785943f559cdd49",
};
const EXPECTED_MIGRATIONS = {
  checksums: [
    "f4264482606a3476b4b54e3089e66c900f0ad5104ea678a9bf17e5e5ba385a62",
    "954731c9ddb791c85defc3bffd887a3d30e9ff9fb5c9dac96e050ac52a796f03",
    "250e9b49176fda732b23f797a6dbce6878ca93818fa1bf6a408b5d6611ee5a48",
    "5487c90a4e70f8e049f9ed48c3ee3f025eb9f1908ed04a1febfb736c22f30d34",
    "462be10d1a35419b52068d09ae5254134e0168fed0ada66f957c87d290c8e6f1",
    "33f3fc5b1b475add0e862b45488a4a3482435df0ae674599005bafd37c3886a8",
    "4e2ed3037ea82011e947e48102149a6ea6456e5fb9f504436f7ec35f6e191390",
    "3934568dcdbb840f5026a09bab676bede7ad7d2571c1d7415efdabb902dd8b81",
    "e144415b6ac8e19338cc4b53d7daeffbf3d32650af880ab7acb809c6f71ded20",
    "2590423b7787b0e5e5668bfa4af21db775b8926540b1d2e339d6656aa3f27dc8",
    "ebf5789636095982e6010a868cdfdd4d7449ca79fb1057adf3b8dd8f49a337dc",
    "663ed323104bb70f4d0e735c3b546fb111038be4d0fee83e0c76c018cf0da15c",
  ],
  names: [
    "0001_initial_weather.sql",
    "0002_worker_migration_readiness.sql",
    "0003_ecowitt_measurements.sql",
    "0004_tempest_metadata.sql",
    "0005_source_supersession.sql",
    "0006_station_coordinates.sql",
    "0007_tide_sources.sql",
    "0008_ecowitt_property_sensors.sql",
    "0009_forecast_anchor_records.sql",
    "0010_forecast_training_export.sql",
    "0011_forecast_runtime_provenance.sql",
    "0012_hide_archive_only_forecasts_from_live_reads.sql",
  ],
};
const ROW_KEYS = [
  "adapter_contracts",
  "collision_count",
  "content_hashes",
  "contract_epoch",
  "dataset",
  "exclusion_reason_codes",
  "ingestion_run_ids",
  "physical_station_key",
  "provider_family",
  "record_kind",
  "received_at",
  "reference_at",
  "reference_kind",
  "relative_humidity_percent",
  "site_key",
  "source_config_fingerprints",
  "source_keys",
  "target_lead_hours",
  "temperature_c",
  "upstream_model",
  "valid_at",
  "wind_direction_degrees",
  "wind_gust_mps",
  "wind_speed_mps",
].sort();
const UPSTREAM_MANIFEST_KEYS = [
  "aggregation_contract_sha256",
  "contract_version",
  "coordinate_manifest_sha256",
  "metric_eligibility_sha256",
  "migration_checksums",
  "migration_history_sha256",
  "migration_names",
  "query_contract_sha256",
  "query_contract_version",
  "row_schema_sha256",
  "schema_migration",
  "site_key",
  "site_timezone",
  "source_lineage_sha256",
  "spatial_weights_sha256",
  "station_manifest_sha256",
].sort();
const STATION_SOURCES = new Map([
  ["ambient-maxweather-observations-v1", ["ambient-maxweather", "7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4", "ambient-device-data/v1"]],
  ["ambient-merlin-observations-v1", ["ambient-merlin", "c3829701bfc25a050022dc3965569d3a87376e8a43b5fdcb7621533f1ae3c65d", "ambient-device-data/v1"]],
  ["ecowitt-88f15505d89f-local-live-v1", ["ballydidean-ecowitt", "0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d", "ecowitt-local-live/v1"]],
  ["netatmo-nearby-observations-v1", ["netatmo-nearby", "5495917dd2465a32d9878e73c68781a229b432901cdc4867875726351efbdbbc", "netatmo-public-measures/v1"]],
  ["tempest-126537-observations-v2", ["tempest-126537", "34dafbd6584c93d55ed4d3d43dc7e74a0876165d4ddfc921413f7b826dff7ab7", "tempest-observations/v2"]],
  ["tempest-168853-observations-v2", ["tempest-168853", "1c7a402337a44a5441775246cbc02da7994599dad6ab83dc04b248303facfea5", "tempest-observations/v2"]],
  ["tempest-201058-observations-v2", ["tempest-201058", "a61cce798cddf682da9608dc245659fc7734a6d5304068939d3115ae7d81a50e", "tempest-observations/v2"]],
  ["tempest-203055-observations-v2", ["tempest-203055", "9ead4c5359a6a9640f334be91397180aa62b90b0f0ce813b9ff26fe84537acc4", "tempest-observations/v2"]],
  ["tempest-225947-observations-v2", ["tempest-225947", "b4dd6105d9a56a7c5d0dc4063f830e1cf28d693222a8de15536dd83d3a6178c4", "tempest-observations/v2"]],
  ["tempest-38270-observations-v2", ["tempest-38270", "ce162067aced4ab3522fb83145a21e608ff24dec189097726188e96fd6cca52f", "tempest-observations/v2"]],
  ["tempest-64255-observations-v2", ["tempest-64255", "8eb488a358375fc3526347d9ef6c9f23080095a22ea874a42ec400b0317d868a", "tempest-observations/v2"]],
  ["wunderground-maxweather-history-v1", ["ambient-maxweather", "52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c", "wunderground-pws-history/v1"]],
]);
const FORECAST_SOURCES = new Map([
  ["open-meteo-forecast-v4", ["ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4", "forecast-daily/v4"]],
  ["open-meteo-previous-runs-v1", ["3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e", "previous-runs-hourly/v1"]],
]);
const STATION_SOURCE_HOUR_INTERVALS = new Map([
  ["ambient-maxweather-observations-v1", ["2026-08-24T00:00:00.000Z", null]],
  ["ambient-merlin-observations-v1", ["2021-01-01T00:00:00.000Z", null]],
  ["ecowitt-88f15505d89f-local-live-v1", [null, null]],
  ["netatmo-nearby-observations-v1", ["2022-06-21T00:00:00.000Z", null]],
  ["tempest-126537-observations-v2", ["2023-12-17T00:00:00.000Z", null]],
  ["tempest-168853-observations-v2", ["2025-01-22T00:00:00.000Z", null]],
  ["tempest-201058-observations-v2", ["2025-12-22T00:00:00.000Z", null]],
  ["tempest-203055-observations-v2", ["2025-12-25T00:00:00.000Z", null]],
  ["tempest-225947-observations-v2", ["2026-07-14T00:00:00.000Z", null]],
  ["tempest-38270-observations-v2", ["2021-01-04T00:00:00.000Z", null]],
  ["tempest-64255-observations-v2", ["2021-12-10T00:00:00.000Z", null]],
  ["wunderground-maxweather-history-v1", [
    "2024-11-29T00:00:00.000Z",
    "2026-08-24T00:00:00.000Z",
  ]],
]);
const STATION_PROVIDERS = new Map([
  ["ambient-maxweather", "ambient"],
  ["ambient-merlin", "ambient"],
  ["ballydidean-ecowitt", "ecowitt"],
  ["netatmo-nearby", "netatmo"],
  ["tempest-126537", "tempest"],
  ["tempest-168853", "tempest"],
  ["tempest-201058", "tempest"],
  ["tempest-203055", "tempest"],
  ["tempest-225947", "tempest"],
  ["tempest-38270", "tempest"],
  ["tempest-64255", "tempest"],
]);
const ALL_SOURCE_IDENTITIES = [
  ...[...STATION_SOURCES.entries()].map(([sourceKey, source]) => ({
    adapterContract: source[2],
    sourceConfigFingerprint: source[1],
    sourceKey,
  })),
  ...[...FORECAST_SOURCES.entries()].map(([sourceKey, source]) => ({
    adapterContract: source[1],
    sourceConfigFingerprint: source[0],
    sourceKey,
  })),
].sort((left, right) => left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0);
const PACKAGE_MANIFEST_KEYS = [
  "aggregationContractSha256",
  "contractVersion",
  "coordinateManifestSha256",
  "createdAtUtc",
  "databaseManifest",
  "fromLocalDate",
  "limits",
  "members",
  "metricEligibilitySha256",
  "migrationHistorySha256",
  "observedSourceIdentities",
  "queryContractSha256",
  "queryContractVersion",
  "rowSchemaSha256",
  "siteKey",
  "siteTimezone",
  "sourceIdentities",
  "sourceLineageSha256",
  "spatialWeightsSha256",
  "stationMetricCoverage",
  "stationManifestSha256",
  "toLocalDate",
  "totalRowCount",
  "transaction",
  "usageBoundary",
].sort();
const MEMBER_KEYS = [
  "localDate",
  "maxValidAt",
  "minValidAt",
  "path",
  "plaintextBytes",
  "recordKind",
  "rowCount",
  "sha256",
  "sizeBytes",
  "stationKey",
].sort();
const SOURCE_IDENTITY_KEYS = [
  "adapterContract",
  "sourceConfigFingerprint",
  "sourceKey",
].sort();
const STATION_METRIC_COVERAGE_KEYS = [
  "eligibleMetricNonNullLocalDates",
  "stationKey",
].sort();
const STATION_METRIC_FIELDS = [
  "relative_humidity_percent",
  "temperature_c",
  "wind_direction_degrees",
  "wind_gust_mps",
  "wind_speed_mps",
].sort();
const LIMIT_KEYS = [
  "conservativeExportRowFormula",
  "conservativeExportRows",
  "exportRowHeadroom",
  "maxDays",
  "maxRows",
  "rowCountMeaning",
].sort();
const TRANSACTION_KEYS = [
  "idleInTransactionSessionTimeout",
  "isolationLevel",
  "lockTimeout",
  "readOnly",
  "statementTimeout",
].sort();
const USAGE_KEYS = [
  "databaseImportAllowed",
  "productionDerived",
  "snapshotOnly",
].sort();
const RAW_TRANSACTION_KEYS = [
  "created_at_utc",
  "from_local_date",
  "idle_in_transaction_session_timeout",
  "isolation_level",
  "lock_timeout",
  "read_only",
  "statement_timeout",
  "to_local_date",
].sort();
const STATION_EXCLUSION_REASON_CODES = [
  "metric_ineligible",
  "metric_missing",
  "quality_flag_rejected",
  "quality_status_rejected",
  "source_interval_out_of_range",
  "source_superseded",
  "station_coverage_insufficient",
  "station_direction_calm",
  "station_gust_coverage_incomplete",
];
const STATION_EXCLUSION_REASONS = new Set(STATION_EXCLUSION_REASON_CODES);
const formatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: SITE_TIMEZONE,
  year: "numeric",
});

// normalize canonical JSON
function canonicalize(value) {
  // preserve array order
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  // sort object keys
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

// encode canonical JSON
function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

// hash exact bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// require a plain object
function requireObject(value, description) {
  // reject arrays and null
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }

  return value;
}

// require exact object keys
function requireExactKeys(value, expected, description) {
  const actual = Object.keys(value).sort();

  // reject schema drift
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} has unexpected fields`);
  }
}

// require one SHA-256 value
function requireHash(value, description) {
  // reject malformed digests
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${description} must be a SHA-256 digest`);
  }

  return value;
}

// require one safe path component
function requireSafeComponent(value, description) {
  // reject traversal and control bytes
  if (typeof value !== "string" || !SAFE_COMPONENT_PATTERN.test(value)) {
    throw new Error(`${description} is invalid`);
  }

  return value;
}

// require one ISO instant
function requireInstant(value, description, nullable = false) {
  // preserve an allowed null
  if (nullable && value === null) {
    return null;
  }

  // reject ambiguous timestamps
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${description} must be an ISO UTC instant`);
  }

  const normalized = new Date(value).toISOString();

  // reject calendar rollover
  if (normalized.slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`${description} must be a real UTC instant`);
  }

  return normalized;
}

// require one real calendar date
function requireDate(value, description) {
  // reject noncanonical and rollover dates
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`${description} must use YYYY-MM-DD`);
  }

  const instant = new Date(`${value}T00:00:00.000Z`);

  // require an exact UTC round trip
  if (!Number.isFinite(instant.valueOf()) || instant.toISOString().slice(0, 10) !== value) {
    throw new Error(`${description} is not a real calendar date`);
  }

  return value;
}

// require one ordered bounded date range
function requireDateRange(fromDateInput, toDateInput) {
  const fromDate = requireDate(fromDateInput, "from date");
  const toDate = requireDate(toDateInput, "to date");
  const fromTime = Date.parse(`${fromDate}T00:00:00.000Z`);
  const toTime = Date.parse(`${toDate}T00:00:00.000Z`);
  const days = ((toTime - fromTime) / 86_400_000) + 1;

  // reject reverse and overlong windows
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`export date range must contain 1 to ${MAX_DAYS} inclusive dates`);
  }

  return { days, fromDate, toDate };
}

// enumerate inclusive calendar labels
function dateLabels(fromDate, toDate) {
  const labels = [];
  const end = Date.parse(`${toDate}T00:00:00.000Z`);

  // advance by UTC labels only
  for (
    let current = Date.parse(`${fromDate}T00:00:00.000Z`);
    current <= end;
    current += 86_400_000
  ) {
    labels.push(new Date(current).toISOString().slice(0, 10));
  }

  return labels;
}

// create empty sanitized station coverage
function createStationMetricDateCoverage() {
  return new Map(
    [...STATION_PROVIDERS.keys()].sort().map((stationKey) => [
      stationKey,
      new Map(STATION_METRIC_FIELDS.map((metric) => [metric, new Set()])),
    ]),
  );
}

// collect non-null metric date upper bounds
function recordStationMetricDateCoverage(coverage, validated) {
  // skip forecast rows
  if (validated.recordKind !== "station-hour") {
    return;
  }

  const stationCoverage = coverage.get(validated.stationKey);

  // reject internal station drift
  if (stationCoverage === undefined) {
    throw new Error("station coverage identity is invalid");
  }

  // count each metric at most once per local date
  for (const metric of STATION_METRIC_FIELDS) {
    // preserve a conservative non-null upper bound
    if (validated.row[metric] !== null) {
      stationCoverage.get(metric).add(validated.date);
    }
  }
}

// serialize sanitized station coverage
function summarizeStationMetricDateCoverage(coverage) {
  return [...STATION_PROVIDERS.keys()].sort().map((stationKey) => ({
    eligibleMetricNonNullLocalDates: Object.fromEntries(
      STATION_METRIC_FIELDS.map((metric) => [
        metric,
        coverage.get(stationKey).get(metric).size,
      ]),
    ),
    stationKey,
  }));
}

// validate sanitized station coverage schema
function validateStationMetricCoverage(value, maximumDates) {
  const expectedStationKeys = [...STATION_PROVIDERS.keys()].sort();

  // require exactly one entry per frozen station
  if (!Array.isArray(value) || value.length !== expectedStationKeys.length) {
    throw new Error("package station metric coverage is invalid");
  }

  // validate every station and metric count
  for (const entry of value) {
    const coverage = requireObject(entry, "station metric coverage");
    requireExactKeys(
      coverage,
      STATION_METRIC_COVERAGE_KEYS,
      "station metric coverage",
    );
    const metricCounts = requireObject(
      coverage.eligibleMetricNonNullLocalDates,
      "station metric coverage counts",
    );
    requireExactKeys(
      metricCounts,
      STATION_METRIC_FIELDS,
      "station metric coverage counts",
    );

    // reject impossible or fractional date counts
    if (
      Object.values(metricCounts).some(
        (count) =>
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > maximumDates,
      )
    ) {
      throw new Error("package station metric coverage is invalid");
    }
  }

  // bind canonical station order and identity
  if (
    JSON.stringify(value.map((entry) => entry.stationKey)) !==
    JSON.stringify(expectedStationKeys)
  ) {
    throw new Error("package station metric coverage is invalid");
  }
}

// enumerate real UTC hours for one local date
function localDateUtcHours(date) {
  const hours = [];
  const center = Date.parse(`${date}T00:00:00.000Z`);

  // include every possible offset and DST hour
  for (let current = center - 43_200_000; current <= center + 129_600_000; current += 3_600_000) {
    const instant = new Date(current).toISOString();

    // retain only the requested local label
    if (localDate(instant) === date) {
      hours.push(instant);
    }
  }

  // require one real timezone day
  if (![23, 24, 25].includes(hours.length)) {
    throw new Error("local station grid has an invalid DST hour count");
  }

  return hours;
}

// derive one Ballydidean local date
function localDate(instant) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// enforce the hard row ceiling
export function assertExportRowCount(rowCount) {
  // reject malformed or over-cap counts
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > MAX_ROWS) {
    throw new Error(`export row count exceeds ${MAX_ROWS}`);
  }

  return rowCount;
}

// reject unsafe local database targets
export function assertLocalReadOnlyTarget(databaseUrl, productionMarker = "") {
  let parsed;

  // reject production-marked evidence
  if (
    /production|prod-db|ballydidean\.farm/iu.test(productionMarker) ||
    /production|prod-db|ballydidean\.farm/iu.test(databaseUrl)
  ) {
    throw new Error("production-marked data cannot be imported into a database");
  }

  // parse one PostgreSQL URL
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("local database URL is invalid");
  }

  // reject non-PostgreSQL and non-loopback targets
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("local database target must be credential-free PostgreSQL on loopback");
  }

  // require an explicit read-only marker
  if (parsed.searchParams.get("options") !== "-c default_transaction_read_only=on") {
    throw new Error("local database target must force read-only transactions");
  }

  // reject every additional connection option
  if ([...parsed.searchParams].length !== 1) {
    throw new Error("local database target contains an unreviewed option");
  }

  return "local-read-only-target-valid";
}

// validate the database manifest projection
function validateUpstreamManifest(value) {
  const manifest = requireObject(value, "database manifest");
  requireExactKeys(manifest, UPSTREAM_MANIFEST_KEYS, "database manifest");

  // bind the fixed contract identity
  if (
    manifest.contract_version !== MANIFEST_VERSION ||
    manifest.site_key !== SITE_KEY ||
    manifest.site_timezone !== SITE_TIMEZONE ||
    manifest.query_contract_version !== QUERY_CONTRACT_VERSION ||
    manifest.schema_migration !== SCHEMA_MIGRATION
  ) {
    throw new Error("database manifest identity is invalid");
  }

  // validate every immutable contract hash
  for (const key of UPSTREAM_MANIFEST_KEYS.filter((key) => key.endsWith("_sha256"))) {
    requireHash(manifest[key], `database manifest ${key}`);
  }

  // bind every frozen contract digest
  for (const [key, expected] of Object.entries(EXPECTED_MANIFEST_HASHES)) {
    // reject self-consistent substitutions
    if (manifest[key] !== expected) {
      throw new Error(`database manifest ${key} does not match the frozen contract`);
    }
  }

  // require a sorted migration ledger
  if (
    !Array.isArray(manifest.migration_names) ||
    manifest.migration_names.length === 0 ||
    manifest.migration_names.some(
      (name) => typeof name !== "string" || !/^\d{4}_[a-z0-9_]+\.sql$/u.test(name),
    ) ||
    JSON.stringify(manifest.migration_names) !==
      JSON.stringify([...manifest.migration_names].sort()) ||
    !manifest.migration_names.includes(manifest.schema_migration) ||
    !Array.isArray(manifest.migration_checksums) ||
    manifest.migration_checksums.length !== manifest.migration_names.length ||
    manifest.migration_checksums.some((checksum) => !HASH_PATTERN.test(checksum))
  ) {
    throw new Error("database migration manifest is invalid");
  }

  // reject missing, unknown, or changed migrations
  if (
    JSON.stringify(manifest.migration_names) !== JSON.stringify(EXPECTED_MIGRATIONS.names) ||
    JSON.stringify(manifest.migration_checksums) !==
      JSON.stringify(EXPECTED_MIGRATIONS.checksums)
  ) {
    throw new Error("database migration manifest does not match the checked repository ledger");
  }

  return manifest;
}

// validate one fixed transaction envelope
function validateTransaction(value, fromDate, toDate) {
  const transaction = requireObject(value, "transaction evidence");
  requireExactKeys(transaction, RAW_TRANSACTION_KEYS, "transaction evidence");

  // require the same frozen transaction
  if (
    transaction.read_only !== "on" ||
    transaction.isolation_level !== "repeatable read" ||
    transaction.statement_timeout !== "15min" ||
    transaction.lock_timeout !== "5s" ||
    transaction.idle_in_transaction_session_timeout !== "30s" ||
    transaction.from_local_date !== fromDate ||
    transaction.to_local_date !== toDate
  ) {
    throw new Error("transaction evidence is invalid");
  }

  requireInstant(transaction.created_at_utc, "transaction created_at_utc");
  return transaction;
}

// classify and validate one export row
function validateRow(value, fromDate, toDate) {
  const row = requireObject(value, "export row");
  requireExactKeys(row, ROW_KEYS, "export row");

  // bind every row to Ballydidean
  if (row.site_key !== SITE_KEY) {
    throw new Error("export row has the wrong site identity");
  }

  // require aligned lineage arrays
  if (
    !Array.isArray(row.source_keys) ||
    !Array.isArray(row.source_config_fingerprints) ||
    !Array.isArray(row.adapter_contracts) ||
    !Array.isArray(row.ingestion_run_ids) ||
    !Array.isArray(row.content_hashes) ||
    !Array.isArray(row.exclusion_reason_codes) ||
    row.source_keys.length !== row.source_config_fingerprints.length ||
    row.source_keys.length !== row.adapter_contracts.length ||
    row.source_keys.some((sourceKey) =>
      typeof sourceKey !== "string" || !SAFE_COMPONENT_PATTERN.test(sourceKey)) ||
    row.source_config_fingerprints.some((fingerprint) => !HASH_PATTERN.test(fingerprint)) ||
    row.adapter_contracts.some((contract) =>
      typeof contract !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(contract)) ||
    row.ingestion_run_ids.some((id) =>
      !(typeof id === "string" && /^[1-9][0-9]*$/u.test(id)) &&
      !(Number.isSafeInteger(id) && id > 0)) ||
    row.content_hashes.some((hash) => !HASH_PATTERN.test(hash)) ||
    row.exclusion_reason_codes.some((reason) =>
      typeof reason !== "string" || !SAFE_COMPONENT_PATTERN.test(reason)) ||
    JSON.stringify(row.source_keys) !== JSON.stringify([...row.source_keys].sort()) ||
    new Set(row.source_keys).size !== row.source_keys.length ||
    JSON.stringify(row.ingestion_run_ids) !==
      JSON.stringify([...row.ingestion_run_ids].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)) ||
    new Set(row.ingestion_run_ids.map(String)).size !== row.ingestion_run_ids.length ||
    JSON.stringify(row.content_hashes) !== JSON.stringify([...row.content_hashes].sort()) ||
    new Set(row.content_hashes).size !== row.content_hashes.length ||
    JSON.stringify(row.exclusion_reason_codes) !==
      JSON.stringify([...row.exclusion_reason_codes].sort()) ||
    new Set(row.exclusion_reason_codes).size !== row.exclusion_reason_codes.length
  ) {
    throw new Error("export row lineage arrays are invalid");
  }

  // reject detected source collisions
  if (!Number.isInteger(row.collision_count) || row.collision_count !== 0) {
    throw new Error("export row contains a source collision");
  }

  const validAt = requireInstant(row.valid_at, "valid_at");
  requireInstant(row.reference_at, "reference_at", true);
  requireInstant(row.received_at, "received_at", true);
  const date = localDate(validAt);

  const metricBounds = [
    [row.temperature_c, -100, 70, "temperature_c"],
    [row.relative_humidity_percent, 0, 100, "relative_humidity_percent"],
    [row.wind_speed_mps, 0, 150, "wind_speed_mps"],
    [row.wind_gust_mps, 0, 150, "wind_gust_mps"],
    [row.wind_direction_degrees, 0, 360, "wind_direction_degrees"],
  ];
  const metricsPresent = metricBounds.some(([metric]) => metric !== null);

  // reject nonnumeric or impossible metric values
  for (const [metric, minimum, maximum, name] of metricBounds) {
    // preserve missing values only
    if (
      metric !== null &&
      (typeof metric !== "number" ||
        !Number.isFinite(metric) ||
        metric < minimum ||
        metric > maximum ||
        (name === "wind_direction_degrees" && metric === maximum))
    ) {
      throw new Error(`export row ${name} is invalid`);
    }
  }

  // reject rows outside requested local dates
  if (date < fromDate || date > toDate) {
    throw new Error("export row falls outside requested local dates");
  }

  let recordKind;
  let stationKey = null;

  // validate one station-hour projection
  if (row.record_kind === "station_hour") {
    stationKey = requireSafeComponent(row.physical_station_key, "physical station key");

    // reject malformed station-hour identity
    if (
      !STATION_PROVIDERS.has(stationKey) ||
      row.provider_family !== STATION_PROVIDERS.get(stationKey) ||
      row.reference_at !== null ||
      row.reference_kind !== null ||
      row.target_lead_hours !== null ||
      row.dataset !== null ||
      row.upstream_model !== null ||
      row.contract_epoch !== "physical-station-hourly/v1"
    ) {
      throw new Error("station-hour identity is invalid");
    }

    // reject unknown station exclusion reasons
    if (row.exclusion_reason_codes.some((reason) => !STATION_EXCLUSION_REASONS.has(reason))) {
      throw new Error("station-hour exclusion reason is invalid");
    }

    const hasCompleteStationProvenance =
      row.source_keys.length > 0 &&
      row.ingestion_run_ids.length > 0 &&
      row.content_hashes.length > 0 &&
      row.received_at !== null;
    const hasEmptyStationProvenance =
      row.source_keys.length === 0 &&
      row.ingestion_run_ids.length === 0 &&
      row.content_hashes.length === 0 &&
      row.received_at === null;

    // reject partial station evidence
    if (!hasCompleteStationProvenance && !hasEmptyStationProvenance) {
      throw new Error("station-hour provenance is incomplete");
    }

    // require evidence for populated station rows
    if (metricsPresent && !hasCompleteStationProvenance) {
      throw new Error("populated station hour lacks provenance");
    }

    const isProvenanceFreeGap =
      !metricsPresent &&
      hasEmptyStationProvenance;
    const hasCoverageInsufficient =
      row.exclusion_reason_codes.includes("station_coverage_insufficient");

    // bind explicit gap evidence in both directions
    if (
      (isProvenanceFreeGap && !hasCoverageInsufficient) ||
      (!isProvenanceFreeGap && hasCoverageInsufficient)
    ) {
      throw new Error("station-hour gap evidence is invalid");
    }

    // validate every contributing source lineage
    for (let index = 0; index < row.source_keys.length; index += 1) {
      const sourceKey = row.source_keys[index];
      const stationSource = STATION_SOURCES.get(sourceKey);
      const acceptedHourInterval = STATION_SOURCE_HOUR_INTERVALS.get(sourceKey);

      // reject source, station, or fingerprint drift
      if (
        stationSource === undefined ||
        acceptedHourInterval === undefined ||
        stationSource[0] !== stationKey ||
        stationSource[1] !== row.source_config_fingerprints[index] ||
        stationSource[2] !== row.adapter_contracts[index] ||
        (acceptedHourInterval[0] !== null && validAt < acceptedHourInterval[0]) ||
        (acceptedHourInterval[1] !== null && validAt > acceptedHourInterval[1])
      ) {
        throw new Error(`station lineage mismatch for ${sourceKey}`);
      }
    }

    recordKind = "station-hour";
  } else {
    // require exactly one forecast source identity
    if (
      row.physical_station_key !== null ||
      row.provider_family !== null ||
      row.source_keys.length !== 1 ||
      !FORECAST_SOURCES.has(row.source_keys[0]) ||
      row.source_config_fingerprints.length !== 1 ||
      row.adapter_contracts.length !== 1 ||
      row.source_config_fingerprints[0] !== FORECAST_SOURCES.get(row.source_keys[0])[0] ||
      row.adapter_contracts[0] !== FORECAST_SOURCES.get(row.source_keys[0])[1]
    ) {
      throw new Error("forecast source identity is invalid");
    }

    // reject exclusions on complete forecast cohorts
    if (row.exclusion_reason_codes.length !== 0) {
      throw new Error("forecast row exclusion reason is invalid");
    }

    // distinguish immutable forecast cohorts
    if (row.record_kind === "fixed_lead_anchor") {
      // require the fixed-lead Previous Runs contract
      if (
        row.source_keys[0] !== "open-meteo-previous-runs-v1" ||
        row.reference_kind !== "fixed_lead_anchor" ||
        row.reference_at !== null ||
        row.dataset !== "previous_runs" ||
        row.upstream_model !== "best_match" ||
        row.contract_epoch !== "open-meteo-previous-runs-best-match/2026-09" ||
        row.received_at === null ||
        row.ingestion_run_ids.length === 0 ||
        row.ingestion_run_ids.length > 2 ||
        row.content_hashes.length !== 1 ||
        !metricsPresent ||
        ![24, 48, 72, 96, 120, 144, 168].includes(row.target_lead_hours)
      ) {
        throw new Error("Previous Runs row identity is invalid");
      }

      recordKind = "fixed-lead-anchor";
    } else if (row.record_kind === "legacy_v4_retrieval_snapshot") {
      // require the unchanged v4 retrieval cohort
      if (
        row.source_keys[0] !== "open-meteo-forecast-v4" ||
        row.reference_kind !== "retrieval_snapshot" ||
        row.reference_at === null ||
        row.received_at === null ||
        row.dataset !== "forecast" ||
        row.upstream_model !== "best_match" ||
        row.contract_epoch !==
          "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83" ||
        row.ingestion_run_ids.length !== 1 ||
        row.content_hashes.length !== 1 ||
        !metricsPresent ||
        !Number.isInteger(row.target_lead_hours) ||
        row.target_lead_hours < 1 ||
        row.target_lead_hours > 168
      ) {
        throw new Error("legacy v4 retrieval row identity is invalid");
      }

      const continuousLead =
        (Date.parse(validAt) - Date.parse(row.reference_at)) / 3_600_000;

      // require the exact projected lead
      if (continuousLead < 0 || Math.ceil(continuousLead) !== row.target_lead_hours) {
        throw new Error("legacy v4 retrieval lead is invalid");
      }

      recordKind = "legacy-v4-retrieval";
    } else {
      throw new Error("export row record kind is invalid");
    }
  }

  return { date, recordKind, row, stationKey, validAt };
}

// create one stable member path
function memberPath({ date, recordKind, stationKey }) {
  const stationComponent = stationKey ?? "forecast";
  requireSafeComponent(date, "member date");
  requireSafeComponent(recordKind, "member record kind");
  requireSafeComponent(stationComponent, "member station");
  return `members/${date}/${recordKind}/${stationComponent}.jsonl.gz`;
}

// close one cached member handle
async function closeOldestHandle(handles) {
  const oldest = handles.entries().next().value;

  // preserve an empty cache
  if (oldest === undefined) {
    return;
  }

  const [path, handle] = oldest;
  handles.delete(path);
  await handle.close();
}

// append one ordered member row
async function appendMember(root, path, line, handles) {
  let handle = handles.get(path);

  // open a bounded number of member files
  if (handle === undefined) {
    // evict the oldest descriptor
    if (handles.size >= 32) {
      await closeOldestHandle(handles);
    }

    const plaintext = join(root, path.replace(/\.gz$/u, ""));
    await mkdir(dirname(plaintext), { recursive: true, mode: 0o700 });
    handle = await open(plaintext, "a", 0o600);
    handles.set(path, handle);
  }

  await handle.write(line);
}

// close every cached descriptor
async function closeHandles(handles) {
  // close in insertion order
  for (const handle of handles.values()) {
    await handle.close();
  }

  handles.clear();
}

// create one verified package directory
async function buildPackage(inputPath, outputRoot, fromDate, toDate) {
  requireDateRange(fromDate, toDate);
  const absoluteOutput = resolve(outputRoot);

  // reject replacement or symlink targets
  if (existsSync(absoluteOutput)) {
    throw new Error("package output already exists");
  }

  await mkdir(absoluteOutput, { recursive: false, mode: 0o700 });
  const input = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(inputPath, { encoding: "utf8" }),
  });
  const handles = new Map();
  const members = new Map();
  const sourceIdentities = new Map();
  const stationMetricDateCoverage = createStationMetricDateCoverage();
  let databaseManifest = null;
  let transaction = null;
  let rowCount = 0;

  try {
    // consume the ordered transaction stream
    for await (const line of input) {
      // reject blank or non-JSON records
      if (line.length === 0) {
        throw new Error("transaction stream contains a blank line");
      }

      const envelope = requireObject(JSON.parse(line), "transaction record");

      // accept exactly one leading manifest
      if (envelope.record_type === "manifest") {
        requireExactKeys(
          envelope,
          ["payload", "record_type", "transaction"],
          "transaction manifest record",
        );
        // reject duplicate or late manifests
        if (databaseManifest !== null || rowCount !== 0) {
          throw new Error("transaction stream contains an invalid manifest position");
        }

        databaseManifest = validateUpstreamManifest(envelope.payload);
        transaction = validateTransaction(envelope.transaction, fromDate, toDate);
        continue;
      }

      // reject rows before the manifest
      if (envelope.record_type !== "row" || databaseManifest === null) {
        throw new Error("transaction stream record type is invalid");
      }

      requireExactKeys(envelope, ["payload", "record_type"], "transaction row record");

      rowCount += 1;
      assertExportRowCount(rowCount);
      const validated = validateRow(envelope.payload, fromDate, toDate);
      recordStationMetricDateCoverage(stationMetricDateCoverage, validated);
      const path = memberPath(validated);
      const member = members.get(path) ?? {
        localDate: validated.date,
        maxValidAt: validated.validAt,
        minValidAt: validated.validAt,
        path,
        plaintextBytes: 0,
        recordKind: validated.recordKind,
        rowCount: 0,
        stationKey: validated.stationKey,
      };
      const rowLine = canonicalJson(validated.row);
      member.rowCount += 1;
      member.plaintextBytes += Buffer.byteLength(rowLine);
      member.minValidAt = validated.validAt < member.minValidAt
        ? validated.validAt
        : member.minValidAt;
      member.maxValidAt = validated.validAt > member.maxValidAt
        ? validated.validAt
        : member.maxValidAt;
      members.set(path, member);
      // record every observed aligned lineage
      for (let index = 0; index < validated.row.source_keys.length; index += 1) {
        sourceIdentities.set(
          `${validated.row.source_keys[index]}:${validated.row.source_config_fingerprints[index]}`,
          {
            adapterContract: validated.row.adapter_contracts[index],
            sourceConfigFingerprint: validated.row.source_config_fingerprints[index],
            sourceKey: validated.row.source_keys[index],
          },
        );
      }
      await appendMember(absoluteOutput, path, rowLine, handles);
    }
  } finally {
    await closeHandles(handles);
  }

  // require the database manifest even for zero rows
  if (databaseManifest === null || transaction === null) {
    throw new Error("transaction stream is missing its database manifest");
  }

  assertExportRowCount(rowCount);
  const finalizedMembers = [];

  // compress members in path order
  for (const path of [...members.keys()].sort()) {
    const member = members.get(path);
    const plaintextPath = join(absoluteOutput, path.replace(/\.gz$/u, ""));
    const compressedPath = join(absoluteOutput, path);
    const unordered = (await readFile(plaintextPath, "utf8")).trimEnd().split("\n");
    const plaintext = Buffer.from(`${unordered.sort().join("\n")}\n`);
    const compressed = gzipSync(plaintext, { level: 9, mtime: 0 });
    writeFileSync(compressedPath, compressed, { mode: 0o600 });
    await rm(plaintextPath);
    finalizedMembers.push({
      localDate: member.localDate,
      maxValidAt: member.maxValidAt,
      minValidAt: member.minValidAt,
      path,
      plaintextBytes: member.plaintextBytes,
      recordKind: member.recordKind,
      rowCount: member.rowCount,
      sha256: sha256(compressed),
      sizeBytes: compressed.byteLength,
      stationKey: member.stationKey,
    });
  }

  const manifest = {
    aggregationContractSha256: databaseManifest.aggregation_contract_sha256,
    contractVersion: PACKAGE_VERSION,
    coordinateManifestSha256: databaseManifest.coordinate_manifest_sha256,
    createdAtUtc: new Date(transaction.created_at_utc).toISOString(),
    databaseManifest,
    fromLocalDate: fromDate,
    limits: {
      conservativeExportRowFormula:
        "450 * ((24 * 264) + (11 * 24) + 168)",
      conservativeExportRows: CONSERVATIVE_EXPORT_ROWS,
      exportRowHeadroom: EXPORT_ROW_HEADROOM,
      maxDays: MAX_DAYS,
      maxRows: MAX_ROWS,
      rowCountMeaning: "export_rows_not_training_events",
    },
    members: finalizedMembers,
    metricEligibilitySha256: databaseManifest.metric_eligibility_sha256,
    migrationHistorySha256: databaseManifest.migration_history_sha256,
    queryContractSha256: databaseManifest.query_contract_sha256,
    queryContractVersion: databaseManifest.query_contract_version,
    rowSchemaSha256: databaseManifest.row_schema_sha256,
    siteKey: SITE_KEY,
    siteTimezone: SITE_TIMEZONE,
    observedSourceIdentities: [...sourceIdentities.values()].sort((left, right) =>
      left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0),
    sourceIdentities: ALL_SOURCE_IDENTITIES,
    sourceLineageSha256: databaseManifest.source_lineage_sha256,
    spatialWeightsSha256: databaseManifest.spatial_weights_sha256,
    stationMetricCoverage: summarizeStationMetricDateCoverage(
      stationMetricDateCoverage,
    ),
    stationManifestSha256: databaseManifest.station_manifest_sha256,
    toLocalDate: toDate,
    totalRowCount: rowCount,
    transaction: {
      idleInTransactionSessionTimeout:
        transaction.idle_in_transaction_session_timeout,
      isolationLevel: transaction.isolation_level,
      lockTimeout: transaction.lock_timeout,
      readOnly: transaction.read_only,
      statementTimeout: transaction.statement_timeout,
    },
    usageBoundary: {
      databaseImportAllowed: false,
      productionDerived: true,
      snapshotOnly: true,
    },
  };
  const manifestBytes = canonicalJson(manifest);
  const manifestHash = sha256(manifestBytes);
  writeFileSync(join(absoluteOutput, "manifest.json"), manifestBytes, { mode: 0o600 });
  writeFileSync(join(absoluteOutput, "manifest.sha256"), `${manifestHash}  manifest.json\n`, {
    mode: 0o600,
  });
  const verifiedHash = await verifyPackage(absoluteOutput);

  // require build and verification identities to agree
  if (verifiedHash !== manifestHash) {
    throw new Error("built package manifest identity changed during verification");
  }

  return manifestHash;
}

// list every package entry
function collectPackageEntries(root) {
  const output = [];

  // walk without following links
  function walk(directory) {
    // inspect entries in deterministic order
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(directory, entry.name);

      // reject every symbolic or special node
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error("package contains a symbolic or special file");
      }

      // descend only through real directories
      if (entry.isDirectory()) {
        output.push(`${relative(root, path).split(sep).join("/")}/`);
        walk(path);
      } else {
        output.push(relative(root, path).split(sep).join("/"));
      }
    }
  }

  walk(root);
  return output;
}

// verify one complete extracted package
async function verifyPackage(root) {
  const absoluteRoot = resolve(root);

  // reject symlink package roots
  if (!existsSync(absoluteRoot) || lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error("package root is missing or symbolic");
  }

  const canonicalRoot = realpathSync(absoluteRoot);

  // require a canonical caller path
  if (canonicalRoot !== absoluteRoot) {
    throw new Error("package root must be canonical");
  }

  const manifestPath = join(absoluteRoot, "manifest.json");
  const checksumPath = join(absoluteRoot, "manifest.sha256");

  // require regular control files
  if (
    !existsSync(manifestPath) ||
    !statSync(manifestPath).isFile() ||
    lstatSync(manifestPath).isSymbolicLink() ||
    !existsSync(checksumPath) ||
    !statSync(checksumPath).isFile() ||
    lstatSync(checksumPath).isSymbolicLink()
  ) {
    throw new Error("package control files are invalid");
  }

  const manifestBytes = readFileSync(manifestPath);
  const manifestHash = sha256(manifestBytes);
  const expectedChecksum = `${manifestHash}  manifest.json\n`;

  // reject a modified manifest
  if (readFileSync(checksumPath, "utf8") !== expectedChecksum) {
    throw new Error("manifest checksum mismatch");
  }

  const manifest = requireObject(JSON.parse(manifestBytes), "package manifest");

  // require canonical manifest bytes
  if (!manifestBytes.equals(Buffer.from(canonicalJson(manifest)))) {
    throw new Error("package manifest is not canonical JSON");
  }

  requireExactKeys(manifest, PACKAGE_MANIFEST_KEYS, "package manifest");
  requireExactKeys(requireObject(manifest.limits, "package limits"), LIMIT_KEYS, "package limits");
  requireExactKeys(
    requireObject(manifest.transaction, "package transaction"),
    TRANSACTION_KEYS,
    "package transaction",
  );
  requireExactKeys(
    requireObject(manifest.usageBoundary, "package usage boundary"),
    USAGE_KEYS,
    "package usage boundary",
  );
  requireDateRange(manifest.fromLocalDate, manifest.toLocalDate);

  // bind the immutable package boundary
  if (
    manifest.contractVersion !== PACKAGE_VERSION ||
    manifest.siteKey !== SITE_KEY ||
    manifest.siteTimezone !== SITE_TIMEZONE ||
    manifest.usageBoundary?.databaseImportAllowed !== false ||
    manifest.usageBoundary?.productionDerived !== true ||
    manifest.usageBoundary?.snapshotOnly !== true ||
    manifest.limits?.maxDays !== MAX_DAYS ||
    manifest.limits?.maxRows !== MAX_ROWS ||
    manifest.limits?.conservativeExportRows !== CONSERVATIVE_EXPORT_ROWS ||
    manifest.limits?.exportRowHeadroom !== EXPORT_ROW_HEADROOM ||
    manifest.limits?.rowCountMeaning !== "export_rows_not_training_events" ||
    manifest.limits?.conservativeExportRowFormula !==
      "450 * ((24 * 264) + (11 * 24) + 168)" ||
    manifest.transaction?.readOnly !== "on" ||
    manifest.transaction?.isolationLevel !== "repeatable read" ||
    manifest.transaction?.statementTimeout !== "15min" ||
    manifest.transaction?.lockTimeout !== "5s" ||
    manifest.transaction?.idleInTransactionSessionTimeout !== "30s"
  ) {
    throw new Error("package manifest boundary is invalid");
  }

  validateUpstreamManifest(manifest.databaseManifest);
  requireInstant(manifest.createdAtUtc, "package createdAtUtc");
  requireHash(manifest.rowSchemaSha256, "row schema hash");
  requireHash(manifest.queryContractSha256, "query contract hash");
  requireHash(manifest.stationManifestSha256, "station manifest hash");
  requireHash(manifest.sourceLineageSha256, "source lineage hash");
  requireHash(manifest.metricEligibilitySha256, "metric eligibility hash");
  requireHash(manifest.coordinateManifestSha256, "coordinate manifest hash");
  requireHash(manifest.spatialWeightsSha256, "spatial weights hash");
  requireHash(manifest.aggregationContractSha256, "aggregation contract hash");
  requireHash(manifest.migrationHistorySha256, "migration history hash");

  // require all duplicate hash bindings to agree
  if (
    manifest.rowSchemaSha256 !== manifest.databaseManifest.row_schema_sha256 ||
    manifest.queryContractSha256 !== manifest.databaseManifest.query_contract_sha256 ||
    manifest.stationManifestSha256 !== manifest.databaseManifest.station_manifest_sha256 ||
    manifest.sourceLineageSha256 !== manifest.databaseManifest.source_lineage_sha256 ||
    manifest.metricEligibilitySha256 !== manifest.databaseManifest.metric_eligibility_sha256 ||
    manifest.coordinateManifestSha256 !== manifest.databaseManifest.coordinate_manifest_sha256 ||
    manifest.spatialWeightsSha256 !== manifest.databaseManifest.spatial_weights_sha256 ||
    manifest.aggregationContractSha256 !==
      manifest.databaseManifest.aggregation_contract_sha256 ||
    manifest.migrationHistorySha256 !== manifest.databaseManifest.migration_history_sha256
  ) {
    throw new Error("package manifest cross-hash mismatch");
  }

  // bind duplicate query versions and migration ledger bytes
  if (
    manifest.queryContractVersion !== manifest.databaseManifest.query_contract_version ||
    manifest.migrationHistorySha256 !== sha256(
      `${manifest.databaseManifest.migration_names.map((name, index) =>
        `${name}:${manifest.databaseManifest.migration_checksums[index]}`).join("\n")}`,
    )
  ) {
    throw new Error("package contract version or migration history mismatch");
  }

  assertExportRowCount(manifest.totalRowCount);

  // require deterministic member order
  if (
    !Array.isArray(manifest.members) ||
    JSON.stringify(manifest.members.map((member) => member.path)) !==
      JSON.stringify(manifest.members.map((member) => member.path).sort())
  ) {
    throw new Error("package members are not ordered");
  }

  let verifiedRows = 0;
  const observedSources = new Map();
  const stationGrid = new Map();
  const stationMetricDateCoverage = createStationMetricDateCoverage();
  const expectedEntries = new Set(["manifest.json", "manifest.sha256"]);

  // require source lists before opening members
  if (
    !Array.isArray(manifest.sourceIdentities) ||
    !Array.isArray(manifest.observedSourceIdentities)
  ) {
    throw new Error("package source identity lists are invalid");
  }

  validateStationMetricCoverage(
    manifest.stationMetricCoverage,
    dateLabels(manifest.fromLocalDate, manifest.toLocalDate).length,
  );

  // validate complete source identity schemas before member reads
  for (const sourceIdentity of manifest.sourceIdentities) {
    requireExactKeys(
      requireObject(sourceIdentity, "source identity"),
      SOURCE_IDENTITY_KEYS,
      "source identity",
    );
  }

  // validate observed source identity schemas before member reads
  for (const sourceIdentity of manifest.observedSourceIdentities) {
    requireExactKeys(
      requireObject(sourceIdentity, "observed source identity"),
      SOURCE_IDENTITY_KEYS,
      "observed source identity",
    );
  }

  // bind the full frozen lineage before member reads
  if (
    canonicalJson(manifest.sourceIdentities) !== canonicalJson(ALL_SOURCE_IDENTITIES) ||
    manifest.observedSourceIdentities.some((identity) =>
      !ALL_SOURCE_IDENTITIES.some((expected) =>
        canonicalJson(expected) === canonicalJson(identity))) ||
    JSON.stringify(manifest.observedSourceIdentities.map((identity) => identity.sourceKey)) !==
      JSON.stringify(manifest.observedSourceIdentities.map((identity) => identity.sourceKey).sort())
  ) {
    throw new Error("package source identities mismatch");
  }

  // verify every compressed member and row
  for (const member of manifest.members) {
    requireExactKeys(requireObject(member, "package member"), MEMBER_KEYS, "package member");
    requireSafeComponent(
      member.path.split("/").at(-1).replace(/\.jsonl\.gz$/u, ""),
      "member leaf",
    );

    // reject unpartitioned paths
    if (
      typeof member.path !== "string" ||
      !/^members\/\d{4}-\d{2}-\d{2}\/(station-hour|fixed-lead-anchor|legacy-v4-retrieval)\/[a-z0-9._-]+\.jsonl\.gz$/u.test(member.path) ||
      member.path.includes("..")
    ) {
      throw new Error("member path is invalid");
    }

    const memberPathname = resolve(absoluteRoot, member.path);

    // keep every member inside the package root
    if (!memberPathname.startsWith(`${absoluteRoot}${sep}`)) {
      throw new Error("member escapes package root");
    }

    // reject missing and symbolic members
    if (
      !existsSync(memberPathname) ||
      lstatSync(memberPathname).isSymbolicLink() ||
      !statSync(memberPathname).isFile()
    ) {
      throw new Error("member is missing or symbolic");
    }

    const compressed = readFileSync(memberPathname);
    requireHash(member.sha256, "member hash");

    // reject member corruption
    if (sha256(compressed) !== member.sha256 || compressed.byteLength !== member.sizeBytes) {
      throw new Error("member checksum or size mismatch");
    }

    const plaintext = gunzipSync(compressed).toString("utf8");
    const lines = plaintext.length === 0 ? [] : plaintext.trimEnd().split("\n");

    // bind member row counts and bytes
    if (
      lines.length !== member.rowCount ||
      Buffer.byteLength(plaintext) !== member.plaintextBytes ||
      lines.length === 0
    ) {
      throw new Error("member count or plaintext size mismatch");
    }

    // require canonical member row order
    if (JSON.stringify(lines) !== JSON.stringify([...lines].sort())) {
      throw new Error("member rows are not canonically ordered");
    }

    let minimum = null;
    let maximum = null;
    let partition = null;
    const stationInstants = [];

    // verify every member row identity
    for (const line of lines) {
      const validated = validateRow(
        JSON.parse(line),
        manifest.fromLocalDate,
        manifest.toLocalDate,
      );
      const expectedPath = memberPath(validated);
      recordStationMetricDateCoverage(stationMetricDateCoverage, validated);

      // reject a row in the wrong partition
      if (expectedPath !== member.path) {
        throw new Error("row is stored in the wrong member partition");
      }

      partition ??= validated;

      // collect station-hour grid identities
      if (validated.recordKind === "station-hour") {
        stationInstants.push(validated.validAt);
      }

      minimum = minimum === null || validated.validAt < minimum ? validated.validAt : minimum;
      maximum = maximum === null || validated.validAt > maximum ? validated.validAt : maximum;

      // record every observed aligned lineage
      for (let index = 0; index < validated.row.source_keys.length; index += 1) {
        observedSources.set(
          `${validated.row.source_keys[index]}:${validated.row.source_config_fingerprints[index]}`,
          {
            adapterContract: validated.row.adapter_contracts[index],
            sourceConfigFingerprint: validated.row.source_config_fingerprints[index],
            sourceKey: validated.row.source_keys[index],
          },
        );
      }

      verifiedRows += 1;
    }

    // reject false member bounds
    if (
      minimum !== member.minValidAt ||
      maximum !== member.maxValidAt ||
      partition.date !== member.localDate ||
      partition.recordKind !== member.recordKind ||
      partition.stationKey !== member.stationKey
    ) {
      throw new Error("member date bounds mismatch");
    }

    // retain each station member for the global grid proof
    if (partition.recordKind === "station-hour") {
      stationGrid.set(member.path, stationInstants);
    }

    expectedEntries.add(member.path);
    const directoryParts = member.path.split("/").slice(0, -1);

    // bind every member directory
    while (directoryParts.length > 0) {
      expectedEntries.add(`${directoryParts.join("/")}/`);
      directoryParts.pop();
    }
  }

  // bind the package total
  if (verifiedRows !== manifest.totalRowCount) {
    throw new Error("package total row count mismatch");
  }

  // prove the complete DST-aware eleven-station grid
  for (const date of dateLabels(manifest.fromLocalDate, manifest.toLocalDate)) {
    const expectedHours = localDateUtcHours(date);

    // require every physical station on the date
    for (const stationKey of STATION_PROVIDERS.keys()) {
      const path = `members/${date}/station-hour/${stationKey}.jsonl.gz`;
      const actualHours = stationGrid.get(path);

      // reject missing, duplicate, or shifted station hours
      if (
        actualHours === undefined ||
        new Set(actualHours).size !== actualHours.length ||
        JSON.stringify([...actualHours].sort()) !== JSON.stringify(expectedHours)
      ) {
        throw new Error("package station-hour grid is incomplete");
      }
    }
  }

  const observedSourceList = [...observedSources.values()].sort((left, right) =>
    left.sourceKey < right.sourceKey ? -1 : left.sourceKey > right.sourceKey ? 1 : 0);

  // bind observed source identities
  if (
    canonicalJson(observedSourceList) !== canonicalJson(manifest.observedSourceIdentities) ||
    canonicalJson(manifest.sourceIdentities) !== canonicalJson(ALL_SOURCE_IDENTITIES)
  ) {
    throw new Error("package source identities mismatch");
  }

  // bind coverage metadata to verified member rows
  if (
    canonicalJson(summarizeStationMetricDateCoverage(stationMetricDateCoverage)) !==
    canonicalJson(manifest.stationMetricCoverage)
  ) {
    throw new Error("package station metric coverage mismatch");
  }

  const actualEntries = collectPackageEntries(absoluteRoot).sort();

  // reject unlisted or missing package entries
  if (JSON.stringify(actualEntries) !== JSON.stringify([...expectedEntries].sort())) {
    throw new Error("package file inventory mismatch");
  }

  return manifestHash;
}

// run one command-line mode
async function main(argumentsList) {
  const [mode, ...values] = argumentsList;

  // build one server package
  if (mode === "build") {
    // require fixed build operands
    if (values.length !== 4) {
      throw new Error("build requires INPUT OUTPUT FROM_DATE TO_DATE");
    }

    process.stdout.write(`${await buildPackage(...values)}\n`);
    return;
  }

  // verify one pulled package
  if (mode === "verify") {
    // require one package root
    if (values.length !== 1) {
      throw new Error("verify requires PACKAGE_ROOT");
    }

    process.stdout.write(`${await verifyPackage(values[0])}\n`);
    return;
  }

  // expose the local target deny boundary
  if (mode === "validate-local-target") {
    // require URL and optional marker only
    if (values.length < 1 || values.length > 2) {
      throw new Error("validate-local-target requires URL [MARKER]");
    }

    process.stdout.write(`${assertLocalReadOnlyTarget(values[0], values[1])}\n`);
    return;
  }

  throw new Error("unknown package operation");
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);

// run only as the command entrypoint
if (invokedPath === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown package failure";
    process.stderr.write(`forecast training package failed: ${message}\n`);
    process.exitCode = 1;
  });
}
