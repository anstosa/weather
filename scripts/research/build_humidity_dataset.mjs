import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { FORECAST_OBSERVATION_STATIONS } from "../../packages/domain/dist/forecast-adjustment.js";
import { parseSanitizedTrainingExportRow, deduplicateForecastAtomicCandidates, scalarNetworkActual } from "../../packages/forecast-adjustment/dist/algorithm-v1.js";

const stations = new Map(FORECAST_OBSERVATION_STATIONS.map(
  // reuse the frozen spatial catalog
  (station) => [station.key, station],
));

// retain humidity-specific availability and the existing network gate
export function humidityTarget(rows) {
  return scalarNetworkActual(rows.flatMap(
    // missing temperatures cannot erase valid humidity observations
    (row) => {
      const station = stations.get(row.physicalStationKey);
      assert.ok(station);
      // preserve missing humidity rather than imputing it
      if (row.metrics.relativeHumidityPercent === null) return [];
      return [{ nearestRank: station.nearestRank, physicalStationKey: station.key, unnormalizedSpatialWeight: station.unnormalizedSpatialWeight, value: row.metrics.relativeHumidityPercent }];
    },
  ));
}

// hash exact retained bytes
function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// accept only the humidity child of an owned private research root
export async function validatePrivateResearchOutputRoot(outputRoot, home = homedir()) {
  assert.equal(typeof outputRoot, "string");
  assert.ok(isAbsolute(outputRoot));
  assert.ok(!outputRoot.split(sep).includes(".."));
  const output = normalize(outputRoot);
  assert.equal(basename(output), "humidity");
  const root = dirname(output);
  assert.ok(basename(root).startsWith("weather-moisture-research-"));
  const tmpfsBase = "/dev/shm";
  const weatherBase = join(resolve(home), ".weather");
  const diskBase = join(weatherBase, "research-work");
  const base = dirname(root);
  assert.ok(base === tmpfsBase || base === diskBase);
  const rootStatus = await lstat(root);
  assert.ok(rootStatus.isDirectory() && !rootStatus.isSymbolicLink());
  assert.equal(rootStatus.uid, process.getuid());
  assert.equal(rootStatus.mode & 0o077, 0);
  // require private owned disk ancestors
  if (base === diskBase) {
    const weatherStatus = await lstat(weatherBase);
    const baseStatus = await lstat(diskBase);
    assert.ok(weatherStatus.isDirectory() && !weatherStatus.isSymbolicLink());
    assert.ok(baseStatus.isDirectory() && !baseStatus.isSymbolicLink());
    assert.equal(weatherStatus.uid, process.getuid());
    assert.equal(baseStatus.uid, process.getuid());
    assert.equal(weatherStatus.mode & 0o077, 0);
    assert.equal(baseStatus.mode & 0o077, 0);
  }
  const [resolvedBase, resolvedRoot] = await Promise.all([realpath(base), realpath(root)]);
  assert.equal(dirname(resolvedRoot), resolvedBase);
  // require a new child without symlink replacement
  try {
    await lstat(output);
    assert.fail("humidity output already exists");
  } catch (error) {
    // accept only expected absence
    if (error.code !== "ENOENT") throw error;
  }
  return output;
}

// rebuild humidity pairs from verified original production members
async function main() {
  const [productionRoot, outputRoot, evidenceRoot] = process.argv.slice(2);
  assert.ok(productionRoot && outputRoot && evidenceRoot);
  const privateOutputRoot = await validatePrivateResearchOutputRoot(outputRoot);
  await mkdir(privateOutputRoot, { mode: 0o700 });
  const cohorts = ["fixed_lead_anchor", "legacy_v4_retrieval_snapshot"];
  const handles = {};
  const counts = { stationRows: 0, humidityValues: 0, networkHours: 0, sourceRows: 0, missingTargets: 0, paired: {}, byStation: {}, byDate: {} };
  // write plaintext only into the private research directory
  for (const name of [...cohorts, "network"]) handles[name] = await open(`${privateOutputRoot}/${name}.jsonl`, "wx", 0o600);
  let ordinal = 0;
  const seenDates = new Set();
  // retain all three contiguous production packages
  for (let index = 1; index <= 3; index += 1) {
    const root = `${productionRoot}/package-${index}`;
    const manifestBytes = await readFile(`${root}/manifest.json`);
    const originalReceipt = JSON.parse(await readFile(`${productionRoot}/evidence/export-${index}-receipt.json`, "utf8"));
    assert.equal(sha(manifestBytes), originalReceipt.manifestSha256);
    const manifest = JSON.parse(manifestBytes);
    const membersByDate = new Map();
    // group only by predeclared dates
    for (const member of manifest.members) {
      const list = membersByDate.get(member.localDate) ?? [];
      list.push(member);
      membersByDate.set(member.localDate, list);
    }
    let packageCount = 0;
    // do not select dates by forecast error
    for (const [date, members] of [...membersByDate].sort()) {
      assert.ok(!seenDates.has(date));
      seenDates.add(date);
      const parsed = [];
      // verify every member before parsing
      for (const member of members) {
        const bytes = await readFile(`${root}/${member.path}`);
        assert.equal(bytes.length, member.sizeBytes);
        assert.equal(sha(bytes), member.sha256);
        const plaintext = gunzipSync(bytes);
        assert.equal(plaintext.length, member.plaintextBytes);
        const lines = plaintext.length ? plaintext.toString("utf8").trimEnd().split("\n") : [];
        assert.equal(lines.length, member.rowCount);
        // invoke the existing strict lineage and row parser
        for (const line of lines) parsed.push({ row: parseSanitizedTrainingExportRow(JSON.parse(line)), ordinal: ordinal++ });
        packageCount += lines.length;
      }
      const hours = new Map();
      const identities = new Set();
      // preserve physical station uniqueness
      for (const { row } of parsed) {
        if (row.recordKind !== "station_hour") continue;
        const key = `${row.validAt}|${row.physicalStationKey}`;
        assert.ok(!identities.has(key));
        identities.add(key);
        const list = hours.get(row.validAt) ?? [];
        list.push(row);
        hours.set(row.validAt, list);
        counts.stationRows += 1;
        // count real humidity independently from temperature
        if (row.metrics.relativeHumidityPercent !== null) {
          counts.humidityValues += 1;
          counts.byStation[row.physicalStationKey] = (counts.byStation[row.physicalStationKey] ?? 0) + 1;
        }
      }
      const targets = new Map();
      // construct one metric-correct target per valid hour
      for (const [validAt, rows] of hours) {
        assert.equal(rows.length, 11);
        const target = humidityTarget(rows);
        if (target === null) continue;
        targets.set(validAt, target);
        counts.networkHours += 1;
        counts.byDate[date] = (counts.byDate[date] ?? 0) + 1;
        await handles.network.writeFile(JSON.stringify({ validAt, actualRelativeHumidityPercent: target.value, stationCount: target.stationCount, stationWeights: target.normalizedWeights }) + "\n");
      }
      const materials = new Map();
      const candidates = [];
      // select humidity forecasts atomically within their truthful cohorts
      for (const { row, ordinal: rowOrdinal } of parsed) {
        if (row.recordKind === "station_hour" || row.metrics.relativeHumidityPercent === null) continue;
        const stableId = `${row.contentHashes[0]}:${rowOrdinal}:relativeHumidityPercent`;
        materials.set(stableId, row);
        candidates.push({ cohort: row.recordKind, continuousLeadHours: row.referenceAt === null ? row.targetLeadHours : (Date.parse(row.validAt) - Date.parse(row.referenceAt)) / 3_600_000, metric: "relativeHumidityPercent", referenceAt: row.referenceAt, referenceKind: row.referenceKind, stableId, targetLeadHours: row.targetLeadHours, validAt: row.validAt });
      }
      // retain identical target support for every future candidate
      for (const selected of deduplicateForecastAtomicCandidates(candidates)) {
        const row = materials.get(selected.stableId);
        const target = targets.get(row.validAt);
        if (target === undefined) {
          counts.missingTargets += 1;
          continue;
        }
        const event = { key: `${row.recordKind}|${row.validAt}|${row.targetLeadHours}`, cohort: row.recordKind, validAt: row.validAt, referenceAt: row.referenceAt, referenceKind: row.referenceKind, targetLeadHours: row.targetLeadHours, rawRelativeHumidityPercent: row.metrics.relativeHumidityPercent, actualRelativeHumidityPercent: target.value, rawTemperatureC: row.metrics.temperatureC, rawWindSpeedMps: row.metrics.windSpeedMps, stationCount: target.stationCount, sourceManifestSha256: originalReceipt.manifestSha256 };
        await handles[row.recordKind].writeFile(JSON.stringify(event) + "\n");
        counts.paired[row.recordKind] = (counts.paired[row.recordKind] ?? 0) + 1;
      }
    }
    assert.equal(packageCount, manifest.totalRowCount);
    counts.sourceRows += packageCount;
  }
  // close private outputs before the aggregate receipt
  for (const handle of Object.values(handles)) await handle.close();
  assert.equal(seenDates.size, 980);
  assert.equal(counts.networkHours, 23477);
  assert.deepEqual(counts.paired, { fixed_lead_anchor: 154218, legacy_v4_retrieval_snapshot: 25598 });
  const receipt = { contractVersion: "humidity-production-pairs/v1", verdict: "PASS", ...counts, dateCount: seenDates.size, source: "restored_verified_production_exports", temperatureDatasetUsedAsTarget: false };
  await writeFile(`${evidenceRoot}/humidity-data-summary.json`, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ verdict: receipt.verdict, dateCount: receipt.dateCount, networkHours: receipt.networkHours, paired: receipt.paired }));
}

// keep imports free from filesystem or production activity
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
