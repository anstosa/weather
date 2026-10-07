# Adjustment performance and review

## Decision boundary

The admin scorecard measures the authorized temperature, wind/gust and rain
adjustments. It does not activate a candidate, disable a band, alter an enabled
switch or change a serving bundle. A worse result is a review recommendation,
not permission to change serving. Each replacement or disablement requires
Ansel's specific approval and the existing reviewed release process.

Historical research gains are not current as-issued performance. The scorecard
keeps evidence, support, comparison, qualification and serving states separate.
Missing support produces null metrics and `pending_support`, not zero error or
a qualification claim. Best Match comparisons are separately matched diagnostics
for temperature and rain; primary comparisons use the recorded source model.

## Evidence and scoring

Successful normal forecast GET responses create bounded content-addressed
objects and exclusive first edge-commit receipts. HEAD, widget requests, failed
responses and abandoned responses do not count. A receipt proves edge commitment,
not receipt by a browser. Retries changing only mutable last-received timestamps
do not produce new vintages. Capture fails open for the forecast but records a
gap. Objects and receipts are never silently pruned or repaired.

Actual issued values use `as_issued`; source-run reconstructions with a verified
before-valid edge receipt use `prospective_receipt`; historical forecasts without
that receipt are `retrospective_counterfactual`. Candidate experiments on opened
intervals are `development`. These populations must not be pooled. Incomplete
Best Match upstream provenance can support descriptive scoring but cannot qualify
a replacement.

Raw and adjusted values use the identical target rows. Primary weights are equal
local dates, then valid hours within a date, then genuine vintages within an hour.
The uncertainty calculation uses 2,000 paired moving-block replicates with
seven-local-date noncircular blocks. Local calendar boundaries use
`America/Los_Angeles`, including DST transitions.

Temperature and wind use the existing deduplicated physical-station regional
network. Rain keeps the fixed twelve-gauge, exactly tiled hourly target. Target
site observations are not pooled into a regional comparison. Revisions change
package/report identities; earlier immutable reports remain unchanged.

## Pull verified packages

Use the installed forced SSH operation; never query unrestricted production
base tables for this workflow. Compile once before research commands:

```bash
npm run build

deploy/scripts/pull-forecast-training-export.sh 2026-10-01 2026-10-07
deploy/scripts/pull-adjustment-evaluation-export.sh 2026-10-01 2026-10-07
```

Both packages must have identical local-date bounds. The adjustment export allows
at most fourteen dates, 8,192 rows, 32 MiB of compressed bodies, a 48 MiB counted
canonical stream and a 48 MiB archive. Its complete host temporary envelope is
64 MiB. Split a refused range into one-date blocks rather than relaxing limits.
Repeat package flags to compose disjoint, chronologically ordered blocks; both
package families must describe the same contiguous blocks. Composition identities
bind every original manifest hash. Both cutoff snapshots and the frozen complete
edge receipt watermark remain part of the report identity.

The forced exporter and pulled-package streaming verifier use fixed V8 bounds
(`--max-old-space-size=48 --max-semi-space-size=1`). Release requires measured
maximum-shape incremental RSS at or below 64 MiB above startup; a heap flag alone
is not proof. Row parsing is pull-based, so compression backpressure cannot queue
the full input. These byte caps are safety ceilings, not a completion-time promise:
statement timeouts still refuse work and callers split the date range.

The separately named `loadVerifiedAdjustmentEvaluationPackage` is a workstation
research loader. It materializes decoded rows and members only after strict
streaming verification, rechecks byte identities while loading and verifies again
before returning. It makes no 64 MiB RSS claim and is not the production exporter
or the bounded `verify` command. Do not run that decoded research path on Blueberry.

Private inputs and candidate outputs belong only under ignored `.weather-data`
or `~/.weather/research-work`, with owned 0700 ancestry and 0600 files. Do not
publish source rows, provider bodies, credentials or private paths in the admin
summary. Each temperature run refuses writes above a 64 MiB allocated result
directory; retained training inputs are separate from that result allocation.

## Temperature refresh

The only arms are the frozen incumbent, month-start expanding fit and month-start
trailing-365-local-date fit. Existing direct/adaptive feature schemas, delayed
runtime, minimum 60 training dates/1,000 rows, seven-day embargo, correction caps
and physical limits remain unchanged. The incumbent's learned strength is held
fixed; candidate coefficient fitting is not a new strength search.

Use the established numerical research interpreter containing NumPy; no serving
or application dependency is added. Standard Python suffices for policy tests,
but coefficient fitting needs that interpreter. All predictions run through the
unchanged compiled TypeScript runtime, not a second Python inference engine.

```bash
umask 077
mkdir -m 700 .weather-data/review
python3 scripts/research/temperature_refresh.py \
  --register 2026-10-01 2026-10-07 \
  --purpose retrospective_development \
  --preregistration .weather-data/review/temperature-policy.json

"$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python3" \
  scripts/research/temperature_refresh.py \
  --preregistration .weather-data/review/temperature-policy.json \
  --forecast-package FORECAST_PACKAGE \
  --adjustment-package ADJUSTMENT_PACKAGE \
  --output .weather-data/review/temperature
```

For a separately verified training interval, `--training-package PRIVATE_PAIR`
loads `PRIVATE_PAIR/forecast` and `PRIVATE_PAIR/adjustment` through the same two
package verifiers. Its last local date must precede the evaluation's first local
date. Both training hashes/cutoffs are recorded separately from the published
same-date evaluation identities. Fresh confirmation requires this disjoint pair;
it never defaults to fitting the score package. Retrospective development may use
earlier-only walk-forward records from its loaded interval.

Optional `--training-rows PRIVATE_PREPARED_JSONL` supplies retained earlier
development records instead of a training pair. Every label needs its actual/conservative captured
`targetMaxReceiptAt` before the fit cutoff. Unknown archival receipt dates are
excluded, not invented. Future confirmation must be registered before its target
interval and target availability, and is burned exclusively before target package
access. Burned intervals cannot be reopened as untouched confirmation. Opened
historical data stays development/counterfactual.

The primary temperature card uses only one ECMWF baseline and evidence class.
Exact captured applied incumbent values can be `as_issued`. Native source-run
replays remain separate prospective/counterfactual private populations in
`incumbent-source-reconstructions.json`. Actually served non-applied decisions
retain their Best Match values, captured state and reason in
`actual-serving-best-match-fallbacks.json`; they are not relabelled ECMWF errors.
The primary card counts these omitted fallback gaps and stays `pending_support`
with `retain`, rather than qualifying a selection-conditioned applied-only cohort.

## Wind and rain

```bash
node apps/worker/dist/forecast-adjustment-performance-cli.js wind-requalify \
  --forecast-package FORECAST_PACKAGE --adjustment-package ADJUSTMENT_PACKAGE \
  --source-revision "$(git rev-parse HEAD)" \
  --output .weather-data/review/wind.json

node apps/worker/dist/forecast-adjustment-performance-cli.js rain-evaluate \
  --forecast-package FORECAST_PACKAGE --adjustment-package ADJUSTMENT_PACKAGE \
  --source-revision "$(git rev-parse HEAD)" \
  --output .weather-data/review/rain.json
```

Wind evaluates every currently enabled speed and gust band; the disabled gust
49–72-hour band stays disabled. All thirteen private `pairReviews` independently
require thirty events and seven dates, including explicit zero-support bands.
The public family state is conservative across them; pooling cannot qualify a
weak pair. Recommendations never modify the enabled mask.
Rain reruns the exact 107-feature amount runtime and its three unthresholded
binary probabilities. Brier/reliability scores use those probabilities, not an
amount indicator or the gamma head. Diagnostics include wet/heavy errors, volume
ratios, event hits/misses/false alarms and complete same-run 6/12/23-hour sums.
Insufficient wet/seasonal support remains explicit.

## Aggregate and publish

All three reports must bind the same two package identities, edge watermark,
date bounds, target cutoff and current source revision. Stale predeployment
reports cannot be reused after the input snapshots change.

```bash
node apps/worker/dist/forecast-adjustment-performance-cli.js scorecard \
  --forecast-manifest FORECAST_PACKAGE/manifest.json \
  --adjustment-manifest ADJUSTMENT_PACKAGE/manifest.json \
  --temperature-report .weather-data/review/temperature/report.json \
  --wind-report .weather-data/review/wind.json \
  --rain-report .weather-data/review/rain.json \
  --output .weather-data/review/scorecard.json

node apps/worker/dist/forecast-adjustment-performance-cli.js verify-scorecard \
  --input .weather-data/review/scorecard.json

deploy/scripts/publish-adjustment-scorecard.sh .weather-data/review/scorecard.json
```

Publication installs only the validated aggregate under
`/var/lib/weather/xweather/adjustment-evidence/scorecards/sha256-HASH.json` and
atomically updates the exact hash pointer `current.json`. It cannot replace
source objects, receipts, model artifacts or settings. Missing, corrupt or stale
summaries fail closed on the authenticated scorecard route without breaking the
forecast or existing admin controls. The public forecast never fetches it.

Review the deployed result at <https://weather.ballydidean.farm/admin>.

## Capacity and release safety

The evidence ledger has a 64 MiB allocated-byte cap. Before writes, exports and
image staging, reserve the agreed envelopes above a fixed 1.75 GiB filesystem
floor plus a 16 MiB operational margin. Capture also reserves the 64 MiB export
envelope. Image staging reserves the remaining ledger allowance and prospective
unique image bytes. A refusal is a blocker, not authority for unrelated cleanup,
pruning evidence or lowering the floor.

The versioned control-plane installer accepts only the exact reviewed live v11
manifest/digest and retains a private backup for rollback/crash recovery. Perform
that handoff during a quiet lifecycle window before an image-only deployment.
Use the prior immutable release environment as the new release's source so
existing canary switches remain unchanged. Preserve all prior release metadata.
Require exact-SHA Check, production image-boundary inspection, release identity,
health and affected authenticated live-page verification before completion.
