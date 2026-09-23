import {
  eveningSunTimes,
  fromSiteWallClock,
  toSiteWallClock,
} from "./index.js";
import {
  addWidgetForecastCalendarDays,
  canonicalWidgetForecastInstant,
  indexWidgetForecastRecords,
  parseWidgetForecastProjection,
  projectWidgetForecastHour,
  WIDGET_FORECAST_MAX_BYTES,
  WIDGET_FORECAST_SITE,
  widgetForecastHourlyInstants,
  type WidgetForecastSnapshot,
} from "./widget-forecast.js";
import {
  projectWidgetForecastV2Hour,
  summarizeWidgetForecastV2Status,
  type WidgetForecastV2Snapshot,
} from "./widget-forecast-v2.js";

export const WIDGET_FORECAST_V3_SCHEMA_VERSION = "weather-widget/v3" as const;

export interface WidgetForecastV3Snapshot extends Omit<WidgetForecastV2Snapshot, "calendar" | "schemaVersion"> {
  readonly calendar: WidgetForecastSnapshot["calendar"] & {
    readonly overnightEnd: string;
  };
  readonly schemaVersion: typeof WIDGET_FORECAST_V3_SCHEMA_VERSION;
}

// project one validated response into the anchored overnight contract
export function projectWidgetForecastV3(
  value: unknown,
  receivedAtValue: string,
): WidgetForecastV3Snapshot {
  const context = parseWidgetForecastProjection(value, receivedAtValue);
  const wallClock = toSiteWallClock(
    context.generatedAt,
    WIDGET_FORECAST_SITE.timezone,
  );
  const localDate = wallClock.slice(0, 10);
  const localHour = Number(wallClock.slice(11, 13));
  const date = localHour < 7
    ? addWidgetForecastCalendarDays(localDate, -1)
    : localDate;
  const nextDate = addWidgetForecastCalendarDays(date, 1);
  const dayStart = siteInstant(`${date}T00:00`, "calendar.dayStart");
  const dayEnd = siteInstant(`${nextDate}T00:00`, "calendar.dayEnd");
  const cutoff = siteInstant(`${date}T20:00`, "calendar.cutoff");
  const anchorStart = siteInstant(`${date}T07:00`, "calendar anchor");
  const overnightEnd = siteInstant(`${nextDate}T07:00`, "calendar.overnightEnd");

  // require the real forecast clock to select exactly one active overnight window
  if (
    Date.parse(context.generatedAt) < Date.parse(anchorStart) ||
    Date.parse(context.generatedAt) >= Date.parse(overnightEnd)
  ) {
    throw new RangeError("Widget forecast v3 generatedAt is outside its calendar window");
  }

  const expectedStarts = widgetForecastHourlyInstants(
    dayStart,
    overnightEnd,
    30,
    32,
  );
  const records = indexWidgetForecastRecords(context.parsed.data, expectedStarts);
  const hours = expectedStarts.map(
    // project the base and condition fields from the same real source row
    (start) => {
      const record = records.get(start) ?? null;
      return projectWidgetForecastV2Hour(
        projectWidgetForecastHour(record, start, context),
        record,
        context.generatedAt,
        context.parsed.adjustmentRuntime,
      );
    },
  );
  const sunset = eveningSunTimes(
    WIDGET_FORECAST_SITE,
    new Date(dayStart),
  ).sunset;
  const snapshot: WidgetForecastV3Snapshot = {
    attribution: {
      label: "Open-Meteo · CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      providerUrl: "https://open-meteo.com/",
    },
    calendar: {
      cutoff,
      date,
      dayEnd,
      dayStart,
      overnightEnd,
      sunset: sunset?.toISOString() ?? null,
    },
    generatedAt: context.generatedAt,
    hours,
    receivedAt: context.receivedAt,
    schemaVersion: WIDGET_FORECAST_V3_SCHEMA_VERSION,
    site: {
      latitude: WIDGET_FORECAST_SITE.latitude,
      longitude: WIDGET_FORECAST_SITE.longitude,
      name: WIDGET_FORECAST_SITE.name,
      slug: WIDGET_FORECAST_SITE.slug,
      timezone: WIDGET_FORECAST_SITE.timezone,
    },
    status: summarizeWidgetForecastV2Status(hours),
  };

  // retain the shared public response ceiling
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > WIDGET_FORECAST_MAX_BYTES) {
    throw new RangeError("Widget forecast v3 exceeds 128 KiB");
  }

  return snapshot;
}

// convert one fixed site wall clock to a canonical instant
function siteInstant(value: string, field: string): string {
  return canonicalWidgetForecastInstant(
    fromSiteWallClock(value, WIDGET_FORECAST_SITE.timezone),
    field,
  );
}
