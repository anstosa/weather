# Forecast adjustment operations and governance

Weather can evaluate a hyperlocal correction for the existing Open-Meteo v4
forecast from a frozen network of eleven physical weather stations. The initial
registry is intentionally inactive:

```json
{"activeBundle":null,"contractVersion":"forecast-adjustment-registry/v1"}
```

The first production-derived evaluation is expected to return
`insufficient_data`. Do not lower a data, skill, bootstrap, or network gate
to create an active model. A model becomes active only through a reviewed
repository change, a new server image, deployment, and API restart.

The pre-activation full-network policy reset uses v2 candidate, evaluation
report, qualification receipt, and runtime bundle contracts. V1 artifacts are
not accepted. The public decision and registry contracts remain v1 because
their wire shapes and semantics did not change; the inactive registry means no
active artifact requires compatibility migration.

## Training-data contract

Every physical station is eligible for the same five metrics when a value is
present and passes its source-specific checks:

- `temperatureC` (`T`)
- `relativeHumidityPercent` (`RH`)
- `windSpeedMps` (`WS`)
- `windGustMps` (`WG`)
- `windDirectionDegrees` (`WD`)

The source intervals below are half-open UTC intervals; `-infinity` and
`+infinity` are literal unbounded endpoints. The `Metrics` column is literal;
apparent temperature, pressure, precipitation, cloud cover, UV, PM2.5,
soil/property measurements, and radiation cannot enter the v1 model.

| Physical station | Provider family | Accepted source and adapter contract | Accepted UTC interval `[start,end)` | QC | Metrics | Checked fingerprint |
| --- | --- | --- | --- | --- | --- | --- |
| `ambient-maxweather` | `ambient` | `wunderground-maxweather-history-v1`; `wunderground-pws-history/v1` | `[2024-11-29T00:00:00Z,2026-08-24T00:00:00Z)` | status absent or `provider_qc_1`; no flags | T, RH, WS, WG, WD | `52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c` |
| `ambient-maxweather` | `ambient` | `ambient-maxweather-observations-v1`; `ambient-device-data/v1` | `[2026-08-24T00:00:00Z,+infinity)` | status absent; no flags | T, RH, WS, WG, WD | `7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4` |
| `ambient-merlin` | `ambient` | `ambient-merlin-observations-v1`; `ambient-device-data/v1` | `[2021-01-01T00:00:00Z,+infinity)` | status absent; no flags | T, RH, WS, WG, WD | `c3829701bfc25a050022dc3965569d3a87376e8a43b5fdcb7621533f1ae3c65d` |
| `ballydidean-ecowitt` | `ecowitt` | `ecowitt-88f15505d89f-local-live-v1`; `ecowitt-local-live/v1` | `[-infinity,+infinity)` | status absent; no flags | T, RH, WS, WG, WD | `0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d` |
| `netatmo-nearby` | `netatmo` | `netatmo-nearby-observations-v1`; `netatmo-public-measures/v1` | `[2022-06-21T00:00:00Z,+infinity)` | status absent; no flags | T, RH, WS, WG, WD | `5495917dd2465a32d9878e73c68781a229b432901cdc4867875726351efbdbbc` |
| `tempest-126537` | `tempest` | `tempest-126537-observations-v2`; `tempest-observations/v2` | `[2023-12-17T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `34dafbd6584c93d55ed4d3d43dc7e74a0876165d4ddfc921413f7b826dff7ab7` |
| `tempest-168853` | `tempest` | `tempest-168853-observations-v2`; `tempest-observations/v2` | `[2025-01-22T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `1c7a402337a44a5441775246cbc02da7994599dad6ab83dc04b248303facfea5` |
| `tempest-201058` | `tempest` | `tempest-201058-observations-v2`; `tempest-observations/v2` | `[2025-12-22T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `a61cce798cddf682da9608dc245659fc7734a6d5304068939d3115ae7d81a50e` |
| `tempest-203055` | `tempest` | `tempest-203055-observations-v2`; `tempest-observations/v2` | `[2025-12-25T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `9ead4c5359a6a9640f334be91397180aa62b90b0f0ce813b9ff26fe84537acc4` |
| `tempest-225947` | `tempest` | `tempest-225947-observations-v2`; `tempest-observations/v2` | `[2026-07-14T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `b4dd6105d9a56a7c5d0dc4063f830e1cf28d693222a8de15536dd83d3a6178c4` |
| `tempest-38270` | `tempest` | `tempest-38270-observations-v2`; `tempest-observations/v2` | `[2021-01-04T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `ce162067aced4ab3522fb83145a21e608ff24dec189097726188e96fd6cca52f` |
| `tempest-64255` | `tempest` | `tempest-64255-observations-v2`; `tempest-observations/v2` | `[2021-12-10T00:00:00Z,+infinity)` | status absent; only `uv_index_out_of_range` flag allowed | T, RH, WS, WG, WD | `8eb488a358375fc3526347d9ef6c9f23080095a22ea874a42ec400b0317d868a` |

Each `tempest-<location>-observations-v1` lineage has an empty accepted interval
and cannot fill a v2 gap. Weather Underground owns MaxWeather before
`2026-08-24T00:00:00Z`; Ambient owns it at and after that instant. Out-of-range,
superseded, unknown-QC, and missing values remain excluded. A surviving
duplicate for one physical station, valid instant, and metric is a hard
collision rather than an averaging opportunity.

The exact excluded source list is:

```text
tempest-126537-observations-v1
tempest-168853-observations-v1
tempest-201058-observations-v1
tempest-203055-observations-v1
tempest-225947-observations-v1
tempest-38270-observations-v1
tempest-64255-observations-v1
```

Instant metrics use the closest eligible observation in
`[validAt - 5 minutes, validAt + 5 minutes)`, with an equal-distance tie going
to the earlier observation. Gust uses the maximum over
`(validAt - 1 hour, validAt]` only when both boundaries and every internal gap
are covered within ten minutes. Direction requires paired station wind speed of
at least `1 m/s`.

The network target requires at least three unique eligible stations and at
least one of the three nearest eligible stations. Available positive Haversine
weights use Earth radius `6,371,008.8 m` and
`1 / (1 + (distanceMeters / 2,000)^2)`, normalized in station-key order. Scalar
targets use the deterministic weighted median; direction uses the weighted
vector mean and becomes missing below resultant length `0.25`. Each resulting
`(validAt, metric, cohort, lead band)` network event has total model weight one.

The station/source/coordinate/spatial hashes are immutable training provenance.
The runtime loader verifies their internal bundle links but does not compare an
active candidate with the current station catalogs. A later station or source
change starts a new lineage and requires retraining; it does not silently alter
or disable already reviewed bundle bytes.

## Previous Runs and live v4 isolation

`open-meteo-previous-runs-v1` is historical-only. Its UTC backfill writes exact
24, 48, 72, 96, 120, 144, and 168-hour anchors to
`forecast_anchor_records` with cohort `fixed_lead_anchor`. An anchor has no
invented model-run or retrieval instant.

Plan the archive without provider or database writes:

```bash
npm run weather:backfill -- \
  --site ballydidean \
  --source open-meteo-previous-runs-v1 \
  --from 2024-01-01 \
  --to 2026-08-31 \
  --chunk-days 14 \
  --dry-run
```

Add `--resume` only when importing the separately authorized archive. A chunk
failure stops later chunks; rerun with `--resume` after correcting the cause.
Do not start the complete production backfill as part of model evaluation.

The scheduled `open-meteo-forecast-v4` source remains the only live forecast
input. Its `weather_records` projection uses cohort
`legacy_v4_retrieval_snapshot`, truthful retrieval-time provenance, and lead
bands 1–24 through 145–168 hours. The live query requires forecast capability,
so Previous Runs cannot enter `/forecast` or public history. Fixed-anchor and
retrieval-snapshot counts, fits, scores, coefficients, and evidence remain
separate. Only `legacy_v4_retrieval_snapshot` can qualify a correction served
beside v4. There is no v5 source, source cutover, scheduled duplication, or
transfer of anchor coefficients into v4.

## Bounded wind transfer canary

The wind canary is a separately versioned exception path, not a qualified v2
model. It fits fixed-lead Previous Runs against the same frozen all-station
network target, then scores those coefficients against the separate retained
live-v4 retrieval cohort. The committed canary enables exactly:

- `windSpeedMps`
- `windGustMps`

Temperature, relative humidity, and wind direction remain the unmodified
regional forecast. An enabled metric-band requires at least 30 scoreable
live-v4 bridge events and strictly positive point skill. This small transfer
cohort does not satisfy the normal seven-local-date moving-block bootstrap or
the full qualified-v2 evidence graph, so its artifacts must never be placed in
the normal bundle registry or described as qualified.

The isolated selection is:

```text
config/forecast-adjustments/ballydidean-wind-canary.json
config/forecast-adjustments/ballydidean/wind-canary-bundles/sha256-<bundleSha256>.json
```

Each bundle contains a candidate, live-v4 transfer report, and explicit
operator authorization. Authorization begins no earlier than its review time,
expires within 14 days, and is enforced at every application. The API reads the
canary once at startup and prefers it only while active. Any expiry, explicit
kill, missing bundle, invalid hash, lineage drift, runtime fingerprint drift,
or application error fails raw without falling through to another adjustment.
Only a genuinely inactive canary registry permits the normal qualified loader
to run.

Set the following deployment variable to the literal value `1`, then restart
the API, for an immediate fail-raw kill:

```dotenv
WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH=1
```

Only `1` activates the kill switch; `0` permits normal operation. Rollback may also
set the canary registry's `activeBundle` to `null` in a reviewed image. Do not
edit an existing content-addressed bundle. The UI starts new canary sessions in
Regional mode; a user may explicitly select **Wind adjusted (canary)**. High
wind alerts always use the greater of raw and adjusted gust so a negative
correction cannot suppress a regional warning.

## Bounded production snapshot

Run the production export only with explicit authority. The command accepts
exactly two inclusive Ballydidean local dates and a loaded deployment SSH agent:

```bash
FROM_DATE="${FROM_DATE:?set the approved first local date}"
TO_DATE="${TO_DATE:?set the approved last local date}"
deploy/scripts/pull-forecast-training-export.sh "$FROM_DATE" "$TO_DATE"
```

Both operands must use `YYYY-MM-DD`, be ordered, and span at most 450 dates.
The forced SSH path accepts no source, site, SQL, database URL, output path, or
extra option. The database session uses only `weather_training_export`, whose
default is read-only and whose grants are limited to the two sanitized export
views. The fixed query begins a `REPEATABLE READ READ ONLY` transaction with a
15-minute statement timeout, five-second lock timeout, and 30-second idle
transaction timeout.

The exporter aborts before publication at row 4,000,001. Its conservative cap
oracle is:

```text
450 × ((24 retrievals × 264 raw horizon rows) +
       (11 stations × 24 hourly aggregates) +
       168 fixed anchors) = 3,045,600 export rows
4,000,000 - 3,045,600 = 954,400 rows of headroom
```

These are export rows before training matching, not eligible training-event
counts.

The pull verifies the package and atomically publishes it at
`.weather-data/<manifest-sha256>/`. It rejects traversal, special archive
nodes, schema/source/hash drift, tampering, an existing destination, and a
raced destination. Interrupted work remains under `.partial.*` and is removed.

Set the digest printed by the pull, then inspect only the sanitized control
plane:

```bash
SNAPSHOT_SHA256="${SNAPSHOT_SHA256:?set the printed manifest SHA-256}"
SNAPSHOT=".weather-data/${SNAPSHOT_SHA256}"
node --input-type=module - "$SNAPSHOT/manifest.json" <<'NODE'
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
const manifestSha256 = process.argv[2].split("/").at(-2);

// enforce the sanitized export boundary
if (
  manifest.transaction.readOnly !== "on" ||
  manifest.transaction.isolationLevel !== "repeatable read" ||
  manifest.limits.maxDays !== 450 ||
  manifest.limits.maxRows !== 4_000_000 ||
  manifest.totalRowCount > manifest.limits.maxRows
) {
  throw new Error("forecast-training export boundary failed");
}

process.stdout.write(`${JSON.stringify({
  aggregationContractSha256: manifest.aggregationContractSha256,
  coordinateManifestSha256: manifest.coordinateManifestSha256,
  fromLocalDate: manifest.fromLocalDate,
  manifestSha256,
  metricEligibilitySha256: manifest.metricEligibilitySha256,
  migrationHistorySha256: manifest.migrationHistorySha256,
  queryContractSha256: manifest.queryContractSha256,
  rowSchemaSha256: manifest.rowSchemaSha256,
  sourceLineageSha256: manifest.sourceLineageSha256,
  spatialWeightsSha256: manifest.spatialWeightsSha256,
  stationManifestSha256: manifest.stationManifestSha256,
  toLocalDate: manifest.toLocalDate,
  totalRowCount: manifest.totalRowCount,
  transaction: manifest.transaction,
}, null, 2)}\n`);
NODE
```

Export approval requires all of the following zero-write evidence:

1. fresh disposable-database tests prove that `weather_training_export` cannot
   run `INSERT`, `UPDATE`, `DELETE`, DDL, sequence operations, base-table reads,
   or application/reachable non-system `SECURITY DEFINER` functions;
2. the production package reports `readOnly=on`,
   `isolationLevel="repeatable read"`, and the exact local timeouts;
3. the forced query contains only the reviewed `SELECT`/`COPY TO STDOUT` path;
4. the production export event records no affected rows or model/ingestion
   mutation attributable to the export session; and
5. the repository and runtime registry remain unchanged by the export.

The forced interface deliberately exposes no arbitrary post-export SQL. Do not
weaken it to collect evidence. Use the already-authorized database audit or
session-scoped counters for item 4; if that evidence is unavailable, do not
claim zero production writes.

The broad local privilege and lifecycle gate is:

```bash
npm run test:deploy
```

## Deterministic inactive evaluation

The ignored local evaluator accepts only one direct child of `.weather-data/`
as input and one direct child of `.weather-models/` as output. It accepts no
database URL. Record the evidence and bundle inventories before the run:

```bash
find "${HOME}/.weather/model-evidence" -type f -printf '%P %s\n' \
  2>/dev/null | sort > /tmp/weather-model-evidence.before
find .weather-models/bundle-staging -type f -printf '%P %s\n' \
  2>/dev/null | sort > /tmp/weather-bundle-staging.before
```

Run the same verified snapshot twice. Exit code `2` is the expected
`insufficient_data` result:

```bash
evaluation_tag="$(date -u +%Y%m%d-%H%M%S)"
evaluation_a=".weather-models/production-eval-${evaluation_tag}-a"
evaluation_b=".weather-models/production-eval-${evaluation_tag}-b"
set +e
npm run weather:forecast-adjustment:evaluate -- \
  --snapshot ".weather-data/${SNAPSHOT_SHA256}" \
  --output "$evaluation_a"
first_exit=$?
npm run weather:forecast-adjustment:evaluate -- \
  --snapshot ".weather-data/${SNAPSHOT_SHA256}" \
  --output "$evaluation_b"
second_exit=$?
set -e
test "$first_exit" -eq 2
test "$second_exit" -eq 2
cmp \
  "$evaluation_a/insufficient-data.json" \
  "$evaluation_b/insufficient-data.json"
sha256sum \
  "$evaluation_a/insufficient-data.json" \
  "$evaluation_b/insufficient-data.json"
```

The two files must be byte-identical, contain the same `reportSha256`, and name
every failed gate. Stable insufficiency reasons include
`epoch_402_local_dates`, `network_330_local_dates`, network/season/pair support,
and development LOSO qualification. The network-date upper bound counts only
distinct `legacy-v4-retrieval` member dates; fixed-lead anchors cannot satisfy
it. No individual station is a manifest-level hard veto.

Confirm the inactive and no-promotion invariants:

```bash
node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";

const registry = JSON.parse(
  await readFile("config/forecast-adjustments/ballydidean.json", "utf8"),
);

// require the inactive reviewed registry
if (
  registry.contractVersion !== "forecast-adjustment-registry/v1" ||
  registry.activeBundle !== null
) {
  throw new Error("forecast-adjustment registry unexpectedly active");
}
NODE
find "${HOME}/.weather/model-evidence" -type f -printf '%P %s\n' \
  2>/dev/null | sort > /tmp/weather-model-evidence.after
find .weather-models/bundle-staging -type f -printf '%P %s\n' \
  2>/dev/null | sort > /tmp/weather-bundle-staging.after
cmp /tmp/weather-model-evidence.before /tmp/weather-model-evidence.after
cmp /tmp/weather-bundle-staging.before /tmp/weather-bundle-staging.after
git check-ignore -q .weather-data .weather-models
test -z "$(git ls-files .weather-data .weather-models)"
rm -f \
  /tmp/weather-model-evidence.before \
  /tmp/weather-model-evidence.after \
  /tmp/weather-bundle-staging.before \
  /tmp/weather-bundle-staging.after
```

An ignored local snapshot is valid only for an insufficient-data dry run. If
the evaluator finds sufficient metadata, it stops before fitting and requires
durable external retention. Move the snapshot into the approved evidence store
or delete it; never continue candidate or holdout work from `.weather-data/`.
No raw production observation, snapshot member, event loss, or credential may
enter Git.

## Qualification calendar and model gates

The evaluator uses the latest fully covered 402 inclusive
`America/Los_Angeles` local dates. `D401` is the last covered date and `D0` is
401 local-calendar days earlier. Empty station/date cells stay empty; DST does
not shift a boundary.

| Partition | Training | Embargo | Score |
| --- | --- | --- | --- |
| Fold 1 | `D0..D179` | `D180..D186` | `D187..D216` |
| Fold 2 | `D0..D216` | `D217..D223` | `D224..D253` |
| Fold 3 | `D0..D253` | `D254..D260` | `D261..D290` |
| Fold 4 | `D0..D290` | `D291..D297` | `D298..D327` |
| Fold 5 | `D0..D327` | `D328..D334` | `D335..D364` |
| Final candidate/holdout | fit once on `D0..D364` | `D365..D371` | `D372..D401` |

Pre-holdout fitting may open only date-sharded `D0..D364` members. The five
development folds complete before the final candidate is fitted. The enabled
set is the lexicographically sorted metric-band set that passes development;
operators cannot remove a pair after seeing holdout scores.

Development-only leave-one-station-out scoring requires, per fold and
metric-band:

- at least 500 matched training instants and 100 matched score instants for a
  scoreable station;
- at least 100 score-date network events after excluding that station;
- at least five scoreable physical stations across at least three of
  `ambient`, `ecowitt`, `netatmo`, and `tempest`;
- equal averaging within station, then within provider family, then across
  provider families, so seven Tempest stations do not multiply Tempest weight;
- at least 2% provider-balanced improvement with a 95% bootstrap lower bound
  above zero;
- nonnegative point skill for at least 80% of scoreable stations; and
- no material-harm station, provider-family, nearest-three, season, or daypart
  slice with at least 100 events.

The immutable final candidate is scored on the locked holdout without a LOSO
refit. Every enabled metric-band must also pass the locked network, station,
provider, nearest-three, and critical-slice gates. Ecowitt remains one ordinary
station and provider-family slice within that full-network evidence; it does
not have a separate activation veto.

## Frozen bootstrap v1

`moving-block-bootstrap/v1` is literal:

- seed: unsigned `0x5EEDB007`;
- PRNG: xorshift32 in order `x ^= x << 13`, `x ^= x >>> 17`,
  `x ^= x << 5`, applying `>>> 0` after each step;
- replicates: exactly 2,000, resetting the seed for each independently scored
  metric-band or required slice;
- draw order: replicate outer, then Fold 1 through Fold 5 using one continuous
  state within an invocation;
- blocks: seven consecutive non-circular local-date slots with starts
  `0..N-7`; reject `N < 7` before the first draw;
- sampling: append blocks until at least `N` slots exist, then truncate to `N`;
  retain empty date slots and reject a zero-event replicate;
- losses: paired absolute error on identical occurrences, using wrapped
  circular absolute error only for direction; and
- lower 95% bound: sort all 2,000 finite skills and select zero-based index 49
  with no interpolation.

For the eight-date hand oracle, the first two states are `0xF549AA51` and
`0xC07EA050`; both choose start 1. The selected offsets are
`[1,2,3,4,5,6,7,1]`. With offset 3 empty and all other selected occurrences at
paired loss `(2,1)`, the replicate has seven events and skill `0.5`.

For a canonical single 30-date window, serialize the 2,000 arrays as
`JSON.stringify(plan) + "\n"`. The first two arrays are `[22,18,14,9,5]` and
`[12,15,7,18,1]`; the required SHA-256 is
`17c35e92d35c7e0ef1644e9c3f33c1ffb98237eadb2fd19813c203c700d447ac`.
Any seed, plan, hash, draw-order, empty-date, loss, or quantile drift is a hard
qualification stop.

## Holdout burn and durable evidence

Sufficient evidence belongs outside Git at the operator-controlled root
`${HOME}/.weather/model-evidence`, mode `0700`. Protect the storage itself with
approved encryption at rest. The API and web never receive this directory or
its keys.

Before any designated holdout member is opened, decrypted, streamed, or
parsed, the evaluator:

1. verifies the immutable candidate and preregistration without holdout access;
2. locks `${HOME}/.weather/model-evidence/ledger.lock` and verifies the full
   predecessor chain in `${HOME}/.weather/model-evidence/ledger.jsonl`;
3. derives `lineageId` from the site, cohort/reference kind, forecast source
   key/fingerprint, dataset/model/contract epoch, station/source/metric/spatial
   hashes, and aggregation contract;
4. rejects a proposed same-lineage interval unless its start is strictly after
   the maximum prior end;
5. appends one `holdout_accessed/v1` marker, fsyncs the ledger and parent
   directory, rereads and verifies the exact durable tail, and releases the
   lock; and
6. only then opens the designated members.

The marker is irrevocable. Cancellation, crash, zero scored rows, scorer error,
or later rejection still burns the interval. There is no release or delete
operation. After `D372..D401`, `D373..D402` rejects; the first allowable fully
covered 30-date interval is `D402..D431`. A new candidate or epoch in the same
lineage does not permit reuse.

The complete graph retains separate content-addressed snapshot manifest,
development report, preregistration, holdout marker, candidate, evaluation
report, and qualification receipt objects. The evaluation cannot mutate the
candidate. Promotion verifies every object hash and cross-link, requires the
marker in the append-only ledger, and appends an fsynced lifecycle record.
Activation additionally requires a matching attestation for either a
restorable encrypted backup or an independently verified content-addressed
copy. The second copy must be byte-identical and physically separate, not a
symlink or hard link, and must include every retained snapshot member.
Set `WEATHER_MODEL_EVIDENCE_REDUNDANCY_ROOT` to an existing canonical directory
on a different storage device before evaluating sufficient data. The evaluator
checks the device boundary before opening the holdout and promotion rechecks it
for every redundant object and retained snapshot member. A second directory on
the primary filesystem is rejected.

After approved external tooling has staged the complete graph and redundancy
proof under the fixed evidence root, promote and reverify the exact identities:

```bash
CANDIDATE_SHA256="${CANDIDATE_SHA256:?set the candidate SHA-256}"
EVALUATION_SHA256="${EVALUATION_SHA256:?set the evaluation SHA-256}"
QUALIFICATION_SHA256="${QUALIFICATION_SHA256:?set the qualification SHA-256}"
npm run weather:forecast-adjustment:evidence -- promote \
  --candidate-sha256 "$CANDIDATE_SHA256" \
  --evaluation-sha256 "$EVALUATION_SHA256" \
  --qualification-sha256 "$QUALIFICATION_SHA256"
npm run weather:forecast-adjustment:evidence -- verify \
  --qualification-sha256 "$QUALIFICATION_SHA256"
```

Do not use these commands for an `insufficient_data` result. Broken hashes,
links, ledger history, missing objects, fake redundancy, or a nonpassing receipt
stop promotion.

## Bundle staging, activation, and rollback

A qualified triple remains inactive until the operator stages a sanitized
runtime bundle:

```bash
CANDIDATE_SHA256="${CANDIDATE_SHA256:?set the candidate SHA-256}"
EVALUATION_SHA256="${EVALUATION_SHA256:?set the evaluation SHA-256}"
QUALIFICATION_SHA256="${QUALIFICATION_SHA256:?set the qualification SHA-256}"
npm run weather:forecast-adjustment:bundle -- \
  --candidate-sha256 "$CANDIDATE_SHA256" \
  --evaluation-sha256 "$EVALUATION_SHA256" \
  --qualification-sha256 "$QUALIFICATION_SHA256"
```

The command verifies the external graph and redundancy, rejects rather than
redacts forbidden content, preserves the exact canonical candidate/report/
receipt objects, and atomically writes:

```text
.weather-models/bundle-staging/sha256-<bundleSha256>.json
```

Forbidden content includes raw rows or per-event losses, credentials, keys,
encrypted members, device/LAN identifiers, database URLs, and external evidence
or member paths.

Activation is a reviewed two-step repository change:

1. Copy the staged bytes unchanged to
   `config/forecast-adjustments/ballydidean/bundles/sha256-<bundleSha256>.json`.
2. Set `activeBundle` in `config/forecast-adjustments/ballydidean.json` to the
   exact relative path and bundle/candidate/evaluation/qualification hashes.

CI rehashes and scans the reviewed bytes. The server image alone copies the
tree to `/opt/weather/config/forecast-adjustments/`; the production registry is
`/opt/weather/config/forecast-adjustments/ballydidean.json`. The web image has
no bundle tree. API/web Compose services mount no `.weather-data/`,
`.weather-models/`, external evidence directory, encrypted evidence, or
decryption key.

Before opening its listener, the API loads the fixed registry and selected
bundle through `lstat`/`realpath` and regular-file/no-symlink checks, verifies
the filename, hashes, allowlist, cross-links, passing receipt, redundancy, and
runtime ICU/tzdata fingerprint, then deep-freezes and caches the result for the
process lifetime. It has no watcher, hot reload, external fetch, station-catalog
comparison, evidence-store access, or key access. Missing, substituted, or
invalid content disables adjustment while the existing v4 raw forecast remains
available.

Activate or roll back only through a reviewed image deployment. Rollback selects
a prior committed bundle or `activeBundle: null`, rebuilds/redeploys the server
image, and restarts the API. Never edit or delete an existing bundle, mutate raw
data, or expect a running process to reload registry changes.

## Hard stops

Stop the operation and retain only secret-safe diagnostics when any of these
conditions occurs:

- export range exceeds 450 dates, row 4,000,001 appears, the transaction is not
  read-only repeatable-read, or the schema/source/QC/cutover/hash contract drifts;
- any export-role write, DDL, base-table, sequence, function, membership, or old
  credential succeeds;
- a raw production row, credential, key, private path/address, or encrypted
  evidence member appears in Git or a runtime bundle;
- an ignored local snapshot appears sufficient, or durable evidence is missing,
  mutable, incomplete, nonredundant, or not independently retrievable;
- a holdout member is touched before the durable marker, a ledger predecessor
  breaks, a same-lineage interval overlaps or starts before/equal to a prior
  end, or a burned interval is reused;
- bootstrap output differs from the frozen seed, plan, oracle, hash, or index;
- any enabled pair, critical slice, provider-balanced LOSO gate, or immutable
  holdout gate fails; or
- activation would bypass review, package different bytes, mount evidence/keys,
  hot reload, or weaken raw-v4 fallback.

`insufficient_data` is a successful inactive evaluation outcome, not permission
to alter thresholds. Leave `activeBundle` null and continue ordinary raw v4
service until a future, fully retained, untouched qualification epoch passes.
