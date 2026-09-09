import { FORECAST_OBSERVATION_STATIONS } from "@weather/domain";
import {
  deduplicateForecastAtomicCandidates,
  parseSanitizedTrainingExportRow,
  scalarNetworkActual,
  type SanitizedForecastRow,
  type SanitizedStationHourRow,
} from "./algorithm-v1.js";

// reconstruct only verified live temperature events without fitting or archive substitution
export function createTemperatureLiveReplayEvents(values: readonly unknown[]) {
  const rows = values.map(
    // enforce the existing exact sanitized export boundary
    (value) => parseSanitizedTrainingExportRow(value),
  );
  const stationHours = new Map<string, SanitizedStationHourRow[]>();
  const stationKeys = new Set<string>();
  // retain one physical station value per valid hour
  for (const row of rows) {
    // exclude forecast rows from the station target
    if (row.recordKind !== "station_hour") {
      continue;
    }
    const key = `${row.physicalStationKey}|${row.validAt}`;
    // reject duplicate station rows instead of overweighting one sensor
    if (stationKeys.has(key)) {
      throw new RangeError("duplicate physical station hour");
    }
    stationKeys.add(key);
    const current = stationHours.get(row.validAt) ?? [];
    current.push(row);
    stationHours.set(row.validAt, current);
  }
  const materials = new Map<string, SanitizedForecastRow>();
  const candidates = rows.flatMap(
    // reproduce the original temperature-only atomic candidate identity
    (row, rowIndex) => {
      // reject missing values and never synthesize live references from fixed anchors
      if (row.recordKind !== "legacy_v4_retrieval_snapshot" || row.metrics.temperatureC === null) {
        return [];
      }
      const stableId = `${row.contentHashes[0]}:${rowIndex}:temperatureC`;
      materials.set(stableId, row);
      return [{ cohort: "legacy_v4_retrieval_snapshot" as const,
        metric: "temperatureC" as const, referenceKind: row.referenceKind,
        continuousLeadHours: (Date.parse(row.validAt) - Date.parse(row.referenceAt!)) / 3_600_000,
        referenceAt: row.referenceAt, targetLeadHours: row.targetLeadHours,
        validAt: row.validAt, stableId }];
    },
  );
  const selected = deduplicateForecastAtomicCandidates(candidates);
  const events = selected.flatMap(
    // use the same network target and exact selected-row weather fields
    (selection) => {
      const row = materials.get(selection.stableId)!;
      const contributions = (stationHours.get(selection.validAt) ?? []).flatMap(
        // include only catalog-eligible physical temperatures
        (stationRow) => {
          const station = FORECAST_OBSERVATION_STATIONS.find(
            // resolve the pinned physical station catalog
            (candidate) => candidate.key === stationRow.physicalStationKey,
          );
          const value = stationRow.metrics.temperatureC;
          // omit missing or ineligible station values without altering the denominator rule
          if (station === undefined || !station.eligibleMetrics.includes("temperatureC") || value === null) {
            return [];
          }
          return [{ nearestRank: station.nearestRank, physicalStationKey: station.key,
            unnormalizedSpatialWeight: station.unnormalizedSpatialWeight, value }];
        },
      );
      const actual = scalarNetworkActual(contributions);
      // omit only network-ineligible target hours
      if (actual === null) {
        return [];
      }
      return [Object.freeze({ actual: actual.value, rawForecast: row.metrics.temperatureC!,
        rawRelativeHumidityPercent: row.metrics.relativeHumidityPercent,
        rawWindSpeedMps: row.metrics.windSpeedMps, referenceAt: selection.referenceAt!,
        targetLeadHours: selection.targetLeadHours, validAt: selection.validAt })];
    },
  );
  return Object.freeze(events);
}
