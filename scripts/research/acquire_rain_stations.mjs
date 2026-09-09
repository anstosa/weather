import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath, rename, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { fetchTempestObservations } from "../../packages/providers/dist/tempest.js";

export const CONTRACT = "rain-sub24-station-acquisition/v1";
export const STATIONS = [66270, 34768, 88159, 126197, 27140];
export const FIRST = "2024-03-13";
export const LAST = "2026-09-02";

// enumerate fixed daily windows independently of rain outcomes
export function identities() {
  const result = [];
  // interleave the same date across distinct physical stations
  for (let time = Date.parse(`${FIRST}T00:00:00Z`); time <= Date.parse(`${LAST}T00:00:00Z`); time += 86400000) {
    // retain every station day including empty provider responses
    for (const stationId of STATIONS) {
      result.push({ stationId, date: new Date(time).toISOString().slice(0, 10), start: new Date(time).toISOString(), end: new Date(time + 86400000).toISOString() });
    }
  }
  return result;
}

// hash exact bytes without exposing credential material
export function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// reject linked or non-private owned acquisition paths
async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: false }).catch((error) => {
    // existing directories must still pass the ownership checks
    if (error.code !== "EEXIST") throw error;
  });
  const status = await lstat(path);
  // fail closed before following filesystem aliases
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== process.getuid() || (status.mode & 0o077) !== 0 || await realpath(path) !== path) {
    throw new Error("station data path is not private owned material");
  }
}

// atomically replace one private aggregate or receipt
async function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.partial`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

// bind local source bytes before the first provider request
async function sources() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const files = [fileURLToPath(import.meta.url)];
  // bind provider and domain implementations used by normalization
  for (const directory of ["packages/providers/dist", "packages/domain/dist"]) {
    // retain executable modules only
    for (const name of await readdir(join(repo, directory))) {
      if (name.endsWith(".js")) files.push(join(repo, directory, name));
    }
  }
  const result = {};
  // hash each loaded module deterministically
  for (const path of files.sort()) result[path.slice(repo.length + 1)] = hash(await readFile(path));
  return result;
}

// capture bounded raw response bytes for independent normalization checks
export async function captureResponse(response) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  // reject missing response bodies rather than inventing empty successes
  if (!reader) throw new Error("missing provider body");
  // enforce the existing adapter's ten-megabyte body bound
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 10000000) {
      await reader.cancel();
      throw new Error("provider body exceeds bound");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks);
}

// validate retained successful rows without silently widening their window
export function validateBatch(batch, identity, station) {
  const seen = new Set();
  // reject mismatched stations, timestamps and duplicate interval endpoints
  for (const row of batch.records) {
    if (row.sourceId !== `research-tempest-${identity.stationId}` || row.metadata.provider.device_id !== station.deviceId || row.metadata.provider.location_id !== identity.stationId || row.validAt < identity.start || row.validAt >= identity.end || seen.has(row.validAt)) {
      throw new Error("station batch identity changed");
    }
    seen.add(row.validAt);
  }
  return batch;
}

// map daily research scope to the existing adapter's half-open contract
export function observationInput(identity, station, apiKey) {
  return { ...station, apiKey, sourceId: `research-tempest-${identity.stationId}`, start: identity.start, endExclusive: identity.end };
}

// run a separate bounded acquisition without production configuration changes
export async function acquire(root, evidence) {
  process.umask(0o077);
  const base = join(homedir(), ".weather", "research-work");
  // accept only the single approved independent research root
  if (root !== join(base, "weather-moisture-research-rain-sub24-20260909")) throw new Error("unexpected station research root");
  // verify the full private lineage before writing descendants
  for (const directory of [dirname(base), base, root]) await privateDirectory(directory);
  const acquisition = join(root, "station-acquisition");
  await privateDirectory(acquisition);
  await privateDirectory(join(acquisition, "days"));
  const catalogBytes = await readFile(join(root, "station-discovery", "resolved.json"));
  const catalog = JSON.parse(catalogBytes).filter((station) => STATIONS.includes(station.locationId));
  // require all selected physical stations and unique devices
  if (catalog.length !== STATIONS.length || new Set(catalog.map((station) => station.deviceId)).size !== STATIONS.length) throw new Error("incomplete station catalog");
  const sourceHashes = await sources();
  const population = identities();
  const contract = { contractVersion: CONTRACT, stationIds: STATIONS, first: FIRST, last: LAST, requestedDays: population.length, maximumAttempts: population.length, concurrency: 3, minimumGlobalStartSpacingMs: 1000, attemptsPerDay: 1, stopOnStatus: [401, 403, 429], stationSelection: "within_5km_and_nonempty_interval_history_at_both_prespecified_probe_dates_no_rain_outcome_selection", sourceHashes, catalogSha256: hash(catalogBytes), historicalReceiptTimeKnown: false, productionWrites: false, modelFit: false };
  const contractPath = join(acquisition, "contract.json");
  const priorContract = await readFile(contractPath, "utf8").catch((error) => {
    // first execution creates a new immutable scope
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // changed sources or scope cannot resume a prior acquisition
  if (priorContract !== null && priorContract !== JSON.stringify(contract) + "\n") throw new Error("station contract changed");
  if (priorContract === null) await writeJson(contractPath, contract);
  await writeJson(join(evidence, "station-acquisition-plan.json"), contract);
  const apiKey = (await readFile(join(dirname(dirname(fileURLToPath(import.meta.url))), "..", "deploy/secrets/weather_tempest_api_key"), "utf8")).trim();
  const receipts = [];
  let nextIndex = 0;
  let attempts = 0;
  let stopped = false;
  let nextStart = 0;
  let gate = Promise.resolve();
  // serialize request starts across all workers and persist before network traffic
  async function reserve(dayRoot, identity) {
    const reservation = gate.then(async () => {
      if (stopped || attempts >= contract.maximumAttempts) return false;
      await sleep(Math.max(0, nextStart - Date.now()));
      if (stopped) return false;
      nextStart = Date.now() + 1000;
      attempts += 1;
      await writeJson(join(dayRoot, "request.json"), { ...identity, startedAtUtc: new Date().toISOString(), credentialRetained: false });
      return true;
    });
    gate = reservation.then(() => undefined);
    return await reservation;
  }
  // retain one result for every requested station day
  async function worker() {
    while (!stopped && nextIndex < population.length) {
      const identity = population[nextIndex++];
      const station = catalog.find((row) => row.locationId === identity.stationId);
      const dayRoot = join(acquisition, "days", `${identity.stationId}-${identity.date}`);
      await privateDirectory(dayRoot);
      const receiptPath = join(dayRoot, "receipt.json");
      const prior = await readFile(receiptPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      // resume terminal results only after checking their retained bytes
      if (prior !== null) {
        const receipt = JSON.parse(prior);
        if (receipt.stationId !== identity.stationId || receipt.date !== identity.date) throw new Error("station receipt mismatch");
        if (receipt.status === "success") {
          const data = await readFile(join(dayRoot, "normalized.json.gz"));
          if (hash(data) !== receipt.normalizedSha256) throw new Error("station retained bytes changed");
          validateBatch(JSON.parse(gunzipSync(data)), identity, station);
        }
        attempts += receipt.attempts;
        receipts.push(receipt);
        continue;
      }
      // preserve an interrupted start instead of issuing an uncounted retry
      if (await lstat(join(dayRoot, "request.json")).then(() => true, (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      })) throw new Error("interrupted station request requires explicit reconciliation");
      const probe = join(root, "station-discovery", "probes", `${identity.stationId}-${identity.date}.json`);
      const probeBytes = await readFile(probe).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      let raw = null;
      let receipt;
      try {
        let batch;
        // reuse exact discovery responses rather than sending duplicate requests
        if (probeBytes !== null) batch = JSON.parse(probeBytes);
        else {
          if (!await reserve(dayRoot, identity)) break;
          batch = await fetchTempestObservations(observationInput(identity, station, apiKey), { maxAttempts: 1, timeoutMs: 30000, fetch: async (input, options) => {
            const response = await fetch(input, options);
            raw = await captureResponse(response);
            return new Response(raw, { status: response.status, headers: response.headers });
          } });
        }
        validateBatch(batch, identity, station);
        const normalized = gzipSync(JSON.stringify(batch) + "\n");
        await writeFile(join(dayRoot, "normalized.json.gz"), normalized, { flag: "wx", mode: 0o600 });
        receipt = { ...identity, status: "success", rows: batch.records.length, attempts: probeBytes === null ? 1 : 0, reusedProbe: probeBytes !== null, providerChecksum: batch.checksum, normalizedSha256: hash(normalized), historicalReceiptTimeKnown: false };
      } catch (error) {
        // retain bounded diagnostics only and stop on provider access boundaries
        receipt = { ...identity, status: "gap", attempts: probeBytes === null ? 1 : 0, errorCode: error.ingestionError?.code ?? error.name, httpStatus: error.status ?? null };
        if ([401, 403, 429].includes(receipt.httpStatus) || !error.ingestionError) stopped = true;
      }
      // preserve original response bytes without its credential-bearing URL
      if (raw !== null) {
        const compressed = gzipSync(raw);
        await writeFile(join(dayRoot, "response.bin.gz"), compressed, { flag: "wx", mode: 0o600 });
        receipt.responseSha256 = hash(raw);
        receipt.compressedResponseSha256 = hash(compressed);
      }
      await writeJson(receiptPath, receipt);
      receipts.push(receipt);
      // bound aggregate checkpoints to one every fifty terminal identities
      if (receipts.length % 50 === 0) await writeJson(join(evidence, "station-acquisition-progress.json"), { contractVersion: CONTRACT, requested: population.length, terminal: receipts.length, successes: receipts.filter((row) => row.status === "success").length, attempts, stopped, productionWrites: false });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  // detect concurrent source drift before publishing a final manifest
  if (JSON.stringify(await sources()) !== JSON.stringify(sourceHashes)) throw new Error("station sources changed in flight");
  const manifest = { ...contract, receipts: receipts.sort((a, b) => a.date.localeCompare(b.date) || a.stationId - b.stationId), attempts, stopped, complete: receipts.length === population.length && !stopped };
  await writeJson(join(acquisition, "manifest.json"), manifest);
  await writeJson(join(evidence, "station-acquisition-receipt.json"), { contractVersion: CONTRACT, requested: population.length, terminal: receipts.length, successes: receipts.filter((row) => row.status === "success").length, attempts, stopped, complete: manifest.complete, manifestSha256: hash(await readFile(join(acquisition, "manifest.json"))), productionWrites: false });
  return manifest.complete;
}

// imports remain network-free for synthetic contract tests
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  acquire(resolve(process.argv[2]), resolve(process.argv[3])).then((complete) => {
    process.exitCode = complete ? 0 : 1;
  }).catch((error) => {
    // never emit provider urls or credential-bearing exception text
    console.error(JSON.stringify({ status: "failed", errorType: error.name }));
    process.exitCode = 1;
  });
}
