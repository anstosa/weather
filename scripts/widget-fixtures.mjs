import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { projectWidgetForecast } from "../apps/web/dist/widget-forecast.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixturesRoot = join(repositoryRoot, "mobile/shared/fixtures");
const HOUR_MS = 3_600_000;
const hashes = {
  bundle: "a".repeat(64),
  candidate: "b".repeat(64),
  report: "c".repeat(64),
  receipt: "d".repeat(64),
  source: "e".repeat(64),
  temperatureBundle: "f".repeat(64),
};
const site = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  name: "Ballydidean",
  slug: "ballydidean",
  stations: [],
  timezone: "America/Los_Angeles",
};

// expose deterministic input builders to the focused projection tests
export function createForecastFixture(options = {}) {
  const generatedAt = options.generatedAt ?? "2026-09-12T15:15:00.000Z";
  const receivedAt = options.receivedAt ?? "2026-09-12T15:15:01.000Z";
  const date = options.date ?? siteDate(generatedAt);
  const starts = dayStarts(date);
  const input = {
    data: starts.map(
      // build every real interval in the anchored local day
      (start, index) => forecastRecord(start, index, generatedAt, options),
    ),
    generatedAt,
    site: options.site ?? site,
  };

  // add only the requested vetted adjustment envelopes
  if (options.generic === true) {
    input.adjustmentRuntime = genericRuntime(options.genericExpiresAt ?? addMs(generatedAt, 2 * HOUR_MS));
  }

  // attach the independent temperature runtime once
  if (options.temperature === true) {
    input.temperatureAdjustmentRuntime = temperatureRuntime(
      options.temperatureExpiresAt ?? addMs(generatedAt, 2 * HOUR_MS),
    );
  }

  // attach the independent rain runtime once
  if (options.rain === true) {
    input.rainAdjustmentRuntime = rainRuntime(generatedAt, starts.length);
  }

  // preserve explicit admin settings, including malformed fixtures
  if (Object.hasOwn(options, "settings")) {
    input.adjustmentSettings = options.settings;
  }

  return { input, receivedAt };
}

// render the small platform-neutral semantic oracle used by native fixture tests
export function renderWidgetFixtureSemantics(snapshot, options) {
  const now = canonicalInstant(options.now);
  const unit = options.unit ?? "fahrenheit";

  // reject unreviewed unit values
  if (unit !== "celsius" && unit !== "fahrenheit") {
    throw new RangeError("widget fixture unit is invalid");
  }

  const nowEpoch = Date.parse(now);
  const cutoff = Date.parse(snapshot.calendar.cutoff);
  const dayStart = Date.parse(snapshot.calendar.dayStart);
  const hardExpiry = Math.min(
    Date.parse(snapshot.calendar.dayEnd),
    Date.parse(snapshot.receivedAt) + 24 * HOUR_MS,
  );
  const hardExpired = nowEpoch >= hardExpiry;
  const acquisitionAge = nowEpoch - Date.parse(snapshot.receivedAt);
  let first = snapshot.hours.findIndex(
    // choose the interval containing the injected clock
    (hour) => Date.parse(hour.start) <= nowEpoch && nowEpoch < Date.parse(hour.end),
  );

  // begin at the first interval before the local day starts
  if (first === -1 && nowEpoch < dayStart) {
    first = 0;
  }

  const remaining = first === -1 || nowEpoch >= cutoff
    ? []
    : snapshot.hours.slice(first).filter(
        // never include the 20:00 interval
        (hour) => Date.parse(hour.start) < cutoff,
      );
  const width = remaining.length === 0
    ? 1
    : Math.min(3, Math.max(1, Math.ceil(remaining.length / 7)));
  const groups = [];
  const effectiveFields = [];

  // retain contiguous fixed-membership groups
  for (let index = 0; index < remaining.length; index += width) {
    const members = remaining.slice(index, index + width);
    const temperatures = members.map(
      // recompute every temperature at the injected clock
      (hour) => effectiveField(hour.temperatureC, nowEpoch, hardExpired),
    );
    const rains = members.map(
      // recompute every rain value independently
      (hour) => effectiveField(hour.rainMmPerHour, nowEpoch, hardExpired),
    );
    effectiveFields.push(...temperatures, ...rains);
    groups.push({
      condition: rainCondition(rains),
      end: members.at(-1).end,
      hourCount: members.length,
      isNow: index === 0 && Date.parse(members[0].start) <= nowEpoch && nowEpoch < Date.parse(members[0].end),
      start: members[0].start,
      status: summarizeModes([...temperatures, ...rains].map((field) => field.mode)),
      temperature: temperatureRange(temperatures, unit),
    });
  }

  const sourceClockSkew = effectiveFields.some(
    // reject negative applicable clock ages as stale
    (field) => field.source !== null && sourceAges(field.source, nowEpoch).some((age) => age < 0),
  );
  const sourceTooOld = effectiveFields.some(
    // use the oldest applicable source clock
    (field) => field.source !== null && Math.max(...sourceAges(field.source, nowEpoch)) > 12 * HOUR_MS,
  );
  const stale = acquisitionAge < 0 || acquisitionAge > 90 * 60_000 || sourceClockSkew || sourceTooOld;
  const status = effectiveFields.length === 0
    ? hardExpired ? "unavailable" : snapshot.status
    : summarizeModes(effectiveFields.map((field) => field.mode));
  const presentation = hardExpired
    ? "unavailable"
    : groups.length === 0 ? "bedtime" : "weather";
  return {
    bedtime: presentation === "bedtime" || (presentation === "weather" && groups.length < 7),
    date: snapshot.calendar.date,
    footer: {
      attribution: snapshot.attribution.label,
      generatedAt: snapshot.generatedAt,
      status,
      sunset: hardExpired ? null : snapshot.calendar.sunset,
    },
    groups,
    hardExpired,
    now,
    presentation,
    schemaVersion: "weather-widget-semantic/v1",
    stale,
    status,
    unit,
  };
}

// build all reviewed cross-platform golden cases
export function buildWidgetFixtures() {
  const cases = [
    {
      name: "adjusted-standard",
      options: {
        generatedAt: "2026-09-12T07:00:00.000Z",
        generic: true,
        rain: true,
        receivedAt: "2026-09-12T07:00:01.000Z",
        row(index, record) {
          const localHour = Number(siteClock(record.validAt).slice(11, 13));
          const displayCelsius = new Map([
            [0, (60 - 32) * 5 / 9],
            [1, (63 - 32) * 5 / 9],
            [2, (61 - 32) * 5 / 9],
          ]);
          const rain = new Map([
            [0, 0],
            [1, 0],
            [2, 2.500001],
            [3, 0.000001],
            [4, 2.5],
            [5, 2.500001],
            [6, 12],
          ]);
          return {
            ...record,
            metrics: {
              ...record.metrics,
              precipitationMm: rain.get(localHour) ?? record.metrics.precipitationMm,
              precipitationRateMmPerHour: rain.get(localHour) ?? record.metrics.precipitationRateMmPerHour,
              temperatureC: displayCelsius.get(localHour) ?? [-1.5, -0.5, 0.5, 1.5][index % 4],
            },
          };
        },
        temperature: true,
      },
      render: { now: "2026-09-12T07:00:01.000Z", unit: "fahrenheit" },
    },
    {
      name: "spring-forward-23",
      options: {
        date: "2026-03-08",
        generatedAt: "2026-03-08T08:00:00.000Z",
        receivedAt: "2026-03-08T08:00:01.000Z",
      },
      render: { now: "2026-03-08T08:15:00.000Z", unit: "celsius" },
    },
    {
      name: "fall-back-25",
      options: {
        date: "2026-11-01",
        generatedAt: "2026-11-01T07:00:00.000Z",
        receivedAt: "2026-11-01T07:00:01.000Z",
      },
      render: { now: "2026-11-01T07:30:00.000Z", unit: "fahrenheit" },
    },
    {
      name: "missing-raw-at-expiry",
      options: {
        temperature: true,
        temperatureExpiresAt: "2026-09-12T16:00:00.000Z",
        row(index, record) {
          return index === 9
            ? { ...record, metrics: { ...record.metrics, temperatureC: null } }
            : record;
        },
      },
      render: { now: "2026-09-12T16:00:00.000Z", unit: "celsius" },
    },
    {
      name: "stale-old-source",
      options: {
        generatedAt: "2026-09-12T07:00:00.000Z",
        receivedAt: "2026-09-12T07:00:01.000Z",
        row(_index, record) {
          return { ...record, productRunAt: "2026-09-11T18:00:00.000Z" };
        },
      },
      render: { now: "2026-09-12T07:00:01.000Z", unit: "fahrenheit" },
    },
    {
      name: "midnight-race",
      options: {
        date: "2026-09-11",
        generatedAt: "2026-09-12T06:59:59.000Z",
        receivedAt: "2026-09-12T07:00:01.000Z",
      },
      render: { now: "2026-09-12T07:00:01.000Z", unit: "fahrenheit" },
    },
  ];

  return cases.map((fixture) => {
    const built = createForecastFixture(fixture.options);
    const snapshot = projectWidgetForecast(built.input, built.receivedAt);
    return {
      expected: renderWidgetFixtureSemantics(snapshot, fixture.render),
      input: { receivedAt: built.receivedAt, response: built.input },
      name: fixture.name,
      snapshot,
    };
  });
}

// create one complete public raw forecast row
function forecastRecord(validAt, index, generatedAt, options) {
  const productRunAt = addMs(generatedAt, -6 * HOUR_MS);
  const receivedAt = addMs(generatedAt, -5 * 60_000);
  let record = {
    freshness: { ageSeconds: 0, label: "Forecast hour", status: "fresh" },
    id: `fixture-${String(index).padStart(2, "0")}`,
    metadata: {
      device: null,
      provider: {
        dataset: "forecast",
        elevationM: null,
        gridCell: null,
        propertySensors: null,
      },
      quality: null,
      upstream: { model: "best_match", timezone: site.timezone },
    },
    metrics: {
      apparentTemperatureC: null,
      blackGlobeTemperatureC: null,
      cloudCoverPercent: null,
      pm25MicrogramsPerCubicMeter: null,
      precipitationMm: index % 5 === 0 ? 0 : index / 100,
      precipitationRateMmPerHour: index % 5 === 0 ? 0 : index / 100,
      pressureHpa: null,
      relativeHumidityPercent: 70,
      soilElectricalConductivityMicrosiemensPerCm: null,
      soilMoisturePercent: null,
      solarRadiationWm2: null,
      temperatureC: 10 + index / 10,
      uvIndex: null,
      wetBulbGlobeTemperatureC: null,
      windDirectionDegrees: null,
      windGustMps: null,
      windSpeedMps: null,
    },
    productRunAt,
    provenance: {
      attribution: { label: "Weather data by Open-Meteo", url: "https://open-meteo.com/" },
      label: "hourly forecast",
      providerKey: "open-meteo",
      sourceId: "fixture-private-source",
      sourceKey: "open-meteo-forecast-v4",
      sourceKind: "forecast",
      stationSlug: "open-meteo-virtual",
    },
    receivedAt,
    revisionCount: 0,
    validAt,
  };

  // apply deterministic case-specific raw metrics first
  if (typeof options.row === "function") {
    record = options.row(index, record);
  }

  // attach one valid generic decision per row
  if (options.generic === true) {
    record.adjustment = genericDecision(record);
  }

  // attach one valid independent temperature decision per row
  if (options.temperature === true) {
    record.temperatureAdjustment = temperatureDecision(record, generatedAt);
  }

  // attach one valid independent rain decision per row
  if (options.rain === true) {
    record.rainAdjustment = rainDecision(record, generatedAt);
  }

  return record;
}

// create one bounded generic runtime with an explicit required expiry
function genericRuntime(expiresAt) {
  return {
    activationMode: "qualified",
    activeBundle: hashes.bundle,
    authorizationSha256: null,
    candidateArtifactSha256: hashes.candidate,
    enabledMetrics: ["temperatureC"],
    evaluationReportSha256: hashes.report,
    expiresAt,
    loadedAt: addMs(expiresAt, -2 * HOUR_MS),
    qualificationReceiptSha256: hashes.receipt,
    reasonCode: null,
    state: "active",
    transferReportSha256: null,
  };
}

// create one exact generic temperature correction
function genericDecision(record) {
  const referenceAt = addMs(record.validAt, -HOUR_MS);
  return {
    adjustedMetrics: { temperatureC: record.metrics.temperatureC === null ? 18 : record.metrics.temperatureC + 2 },
    algorithmContractVersion: "robust-hierarchical-median/v1",
    appliedMetrics: ["temperatureC"],
    candidateArtifactSha256: hashes.candidate,
    contractVersion: "forecast-adjustment-decision/v1",
    evaluationReportSha256: hashes.report,
    leadBand: "001-024",
    qualificationReceiptSha256: hashes.receipt,
    rawForecastProvenance: {
      adapterVersion: "open-meteo-forecast-daily/v4",
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch: "legacy-v4/fixture",
      dataset: "forecast",
      referenceAt,
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: hashes.source,
      sourceKey: record.provenance.sourceKey,
      targetLeadHours: 1,
      upstreamModel: "best_match",
      validAt: record.validAt,
    },
    reasonCode: null,
    state: "active",
  };
}

// create one bounded independent temperature runtime
function temperatureRuntime(expiresAt) {
  return {
    activeBundle: hashes.temperatureBundle,
    authorizationSha256: "9".repeat(64),
    expiresAt,
    loadedAt: addMs(expiresAt, -2 * HOUR_MS),
    reasonCode: null,
    source: {
      adaptiveReady: false,
      firstReceivedAt: addMs(expiresAt, -10 * HOUR_MS),
      hourCount: 19,
      latestRunInitializedAt: addMs(expiresAt, -16 * HOUR_MS),
      stateReason: "cold_start",
      stateStatus: "cold",
    },
    state: "active",
  };
}

// create one causal independent temperature correction
function temperatureDecision(record, generatedAt) {
  const futureHours = Math.max(0, Math.ceil((Date.parse(record.validAt) - Date.parse(generatedAt)) / HOUR_MS));

  // retain a schema-complete raw fallback outside the canary horizon
  if (futureHours + 1 > 18) {
    return {
      branch: null,
      bundleSha256: hashes.temperatureBundle,
      contractVersion: "forecast-temperature-canary-decision/v1",
      correctedTemperatureC: null,
      rawBestMatchTemperatureC: record.metrics.temperatureC,
      reasonCode: "outside_operational_window",
      recentErrorStateSha256: null,
      sourceForecast: null,
      state: "raw_fallback",
    };
  }

  const lead = Math.max(7, futureHours + 1);
  const runInitializedAt = addMs(record.validAt, -lead * HOUR_MS);
  const firstReceivedAt = addMs(runInitializedAt, HOUR_MS);
  return {
    branch: "direct",
    bundleSha256: hashes.temperatureBundle,
    contractVersion: "forecast-temperature-canary-decision/v1",
    correctedTemperatureC: record.metrics.temperatureC === null ? 10 : record.metrics.temperatureC,
    rawBestMatchTemperatureC: record.metrics.temperatureC,
    reasonCode: null,
    recentErrorStateSha256: "8".repeat(64),
    sourceForecast: {
      adapterVersion: "open-meteo-ecmwf-single-run/v1",
      dataset: "single_run",
      firstReceivedAt,
      modelCycle: "50r1",
      modelLeadHours: lead,
      operationalHorizonHours: lead - 6,
      providerKey: "open-meteo",
      providerResponseSha256: "7".repeat(64),
      rawRelativeHumidityPercent: 70,
      rawTemperatureC: record.metrics.temperatureC ?? 10,
      rawWindSpeedMps: 2,
      runInitializedAt,
      upstreamModel: "ecmwf_ifs",
      validAt: record.validAt,
    },
    state: "active",
  };
}

// create one active rain runtime summary
function rainRuntime(generatedAt, hourCount) {
  return {
    activeBundle: "4".repeat(64),
    loadedAt: addMs(generatedAt, -60_000),
    reasonCode: null,
    source: {
      decisionAt: addMs(generatedAt, -15 * 60_000),
      firstReceivedAt: addMs(generatedAt, -75 * 60_000),
      hourCount: Math.min(23, hourCount),
      runInitializedAt: addMs(generatedAt, -8 * HOUR_MS - 15 * 60_000),
    },
    state: "active",
  };
}

// create one causal independent rain correction
function rainDecision(record, generatedAt) {
  const futureHours = Math.max(0, Math.ceil((Date.parse(record.validAt) - Date.parse(generatedAt)) / HOUR_MS));
  const lead = Math.max(9, Math.min(31, futureHours + 8));
  const runInitializedAt = addMs(record.validAt, -lead * HOUR_MS);
  const decisionAt = addMs(runInitializedAt, 8 * HOUR_MS);
  return {
    bundleSha256: "4".repeat(64),
    contractVersion: "forecast-rain-adjustment-decision/v1",
    correctedPrecipitationMm: record.metrics.precipitationMm ?? 0.5,
    rawBestMatchPrecipitationMm: record.metrics.precipitationMm,
    reasonCode: null,
    sourceForecast: {
      decisionAt,
      firstReceivedAt: addMs(decisionAt, -HOUR_MS),
      modelLeadHours: lead,
      providerKey: "open-meteo",
      rawPrecipitationMm: record.metrics.precipitationMm ?? 0.5,
      runInitializedAt,
      upstreamModel: "ecmwf_ifs",
      validAt: record.validAt,
    },
    state: "active",
  };
}

// recalculate one field at a native render boundary
function effectiveField(field, nowEpoch, hardExpired) {
  // hard expiry removes all numeric data
  if (hardExpired) {
    return { mode: "unavailable", source: null, value: null };
  }

  // retain a not-yet-expired correction and its own source
  if (
    field.mode === "adjusted" &&
    field.selectedUntil !== null &&
    nowEpoch < Date.parse(field.selectedUntil)
  ) {
    return { mode: "adjusted", source: field.selectedSource, value: field.selected };
  }

  // demote an expired correction to the captured raw pair
  if (field.raw !== null && field.rawSource !== null) {
    return { mode: "raw", source: field.rawSource, value: field.raw };
  }

  return { mode: "unavailable", source: null, value: null };
}

// calculate the complete applicable source age set
function sourceAges(source, nowEpoch) {
  const ages = [nowEpoch - Date.parse(source.receivedAt)];

  // include a product or model run when known
  if (source.runAt !== null) {
    ages.push(nowEpoch - Date.parse(source.runAt));
  }

  return ages;
}

// convert and round one complete group range
function temperatureRange(fields, unit) {
  // make any partial group explicitly unavailable
  if (fields.some((field) => field.value === null)) {
    return null;
  }

  const rounded = fields.map((field) => roundTemperature(convertTemperature(field.value, unit)));
  const minimum = Math.min(...rounded);
  const maximum = Math.max(...rounded);
  return {
    label: minimum === maximum ? String(minimum) : `${String(minimum)}–${String(maximum)}`,
    maximum,
    minimum,
  };
}

// classify the wettest hourly value before any display rounding
function rainCondition(fields) {
  // never turn a missing member into dry
  if (fields.some((field) => field.value === null)) {
    return "unavailable";
  }

  const maximum = Math.max(...fields.map((field) => field.value));

  // preserve the exact dry boundary
  if (maximum === 0) {
    return "dry";
  }

  return maximum <= 2.5 ? "sprinkle" : "rain";
}

// convert celsius only when requested
function convertTemperature(value, unit) {
  return unit === "fahrenheit" ? value * 9 / 5 + 32 : value;
}

// round midpoint ties away from zero and remove negative zero
function roundTemperature(value) {
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  return Object.is(rounded, -0) ? 0 : rounded;
}

// summarize modes without hiding partial unavailability
function summarizeModes(modes) {
  const unique = new Set(modes);

  // preserve one exact homogeneous mode
  if (unique.size === 1) {
    return [...unique][0];
  }

  return "mixed";
}

// generate every real utc interval start for one farm date
function dayStarts(date) {
  const start = Date.parse(siteMidnight(date));
  const end = Date.parse(siteMidnight(addCalendarDays(date, 1)));
  return Array.from(
    { length: (end - start) / HOUR_MS },
    // preserve both repeated local-clock hours
    (_, index) => new Date(start + index * HOUR_MS).toISOString(),
  );
}

// convert one unambiguous farm midnight to utc
function siteMidnight(date) {
  const guess = Date.parse(`${date}T08:00:00.000Z`);

  // search the bounded timezone-offset range without another dependency
  for (let offset = -4; offset <= 4; offset += 1) {
    const candidate = new Date(guess + offset * HOUR_MS);

    // retain the instant that round-trips to farm midnight
    if (siteClock(candidate.toISOString()) === `${date}T00:00`) {
      return candidate.toISOString();
    }
  }

  throw new RangeError("fixture farm midnight is invalid");
}

// format one instant as a farm minute wall clock
function siteClock(value) {
  const values = new Map();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: site.timezone,
    year: "numeric",
  });

  // retain named calendar parts only
  for (const part of formatter.formatToParts(new Date(value))) {
    // omit locale punctuation
    if (part.type !== "literal") {
      values.set(part.type, part.value);
    }
  }

  return `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:${values.get("minute")}`;
}

// read the farm date for one instant
function siteDate(value) {
  return siteClock(value).slice(0, 10);
}

// add whole calendar days without a device timezone
function addCalendarDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// add milliseconds and retain canonical json timestamps
function addMs(value, milliseconds) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

// normalize one expected fixture instant
function canonicalInstant(value) {
  const instant = new Date(value);

  // reject fixture typos before golden generation
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("widget fixture instant is invalid");
  }

  return instant.toISOString();
}

// serialize canonical reviewed fixture bytes
function fixtureJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// compare or intentionally write every fixture artifact
async function updateFixtures(mode) {
  const fixtures = buildWidgetFixtures();

  // process fixtures in their reviewed declaration order
  for (const fixture of fixtures) {
    const directory = join(fixturesRoot, fixture.name);
    const files = new Map([
      ["input.json", fixture.input],
      ["snapshot.json", fixture.snapshot],
      ["expected.json", fixture.expected],
    ]);

    // create directories only during explicit regeneration
    if (mode === "write") {
      await mkdir(directory, { recursive: true });
    }

    // verify each committed byte sequence independently
    for (const [name, value] of files) {
      const path = join(directory, name);
      const expected = fixtureJson(value);

      // rewrite only under the explicit write mode
      if (mode === "write") {
        await writeFile(path, expected);
        continue;
      }

      const actual = await readFile(path, "utf8");

      // reject any silent golden drift
      if (actual !== expected) {
        throw new Error(`widget fixture is stale: ${fixture.name}/${name}`);
      }
    }
  }
}

// execute only as the fixture command
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2];

  // require an explicit safe mode
  if (argument !== "--check" && argument !== "--write") {
    throw new Error("usage: node scripts/widget-fixtures.mjs --check|--write");
  }

  await updateFixtures(argument.slice(2));
}
