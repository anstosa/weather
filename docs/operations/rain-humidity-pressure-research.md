# Rain, humidity, and pressure research

## Scope

This is an inactive, retrospective research pipeline. It does not modify the
production database, activate adjustments, or replace the deployed temperature
and wind bundles. Research scripts live under `scripts/research/`; row-level
inputs and predictions belong in private encrypted retention, never Git.

The frozen observation calendar is January 1, 2024 through September 6, 2026:
980 local dates and 23,519 UTC hours. Every complete evaluation month from
January 2025 through August 2026 is included; September 1–6 is reported
separately. Missing source runs, targets, and unsupported model cells remain
explicit. Years of observations cannot supply historical forecasts that a
provider did not archive.

## Source contracts

- **Previous Runs anchors:** production `open-meteo-previous-runs-v1`, with
  literal 24/48/72/96/120/144/168-hour leads. Initialization remains unknown.
- **ECMWF Single Runs:** four requested cycles per date from March 14, 2024,
  through September 6, 2026, with leads 1–48. Archive gaps are retained.
- **Best Match Single Runs:** four requested cycles per date from April 2,
  2026, through September 6, 2026. This is a separate transfer population,
  not extra ECMWF training rows.
- **Saved live forecasts:** production `open-meteo-forecast-v4`. Its stored
  reference is retrieval time, not reconstructed model initialization.

Single Runs references identify model initialization, not historical publication
or receipt time. Consequently these results are hindcast evidence, not a claim
that every forecast was available to a user at that initialization. The archive
coverage distinction follows [Open-Meteo's Single Runs documentation](https://open-meteo.com/en/docs/single-runs-api).

Rain and pressure were present in production's archived forecasts but absent
from the earlier sanitized research projection. The new exporter uses a
separate, bounded `REPEATABLE READ READ ONLY` research contract. It does not
change the existing export role, sanitized views, grants, or schema. Exact
source fingerprints, monthly query hashes, read-only transaction receipts,
compressed member hashes, and per-source counts bind the extraction.

## Retained data coverage

The new read-only production extraction contains **5,530,108 Tempest records**,
**154,512 fixed-anchor forecasts**, and **32,040 saved live forecast rows**.
The humidity reconstruction supplies 23,477 network target hours from the
verified eleven-station export. Rain has 19,170 complete network reporting-hour
targets: 17,840 liquid-only, 1,136 cold, and 194 without enough temperature
support. Pressure has 90,758 independent station-hour targets across seven
Tempest stations; station histories are not all equally long.

The public acquisition requested every one of 4,260 frozen run identities.
It retained 3,939 successful runs and 189,072 normalized 1–48-hour forecasts:
158,976 ECMWF rows and 30,096 Best Match rows. All 321 gaps remain explicit:
303 archive-unavailable responses, 15 exhausted bounded transport retries,
and three malformed successful HTTP responses. There were 4,417 attempts,
no quota response, and no unbounded retries.

Native fixed-anchor humidity evaluation covers all 20 complete months and
606 of the 608 calendar dates. August 9 and October 16, 2025 have complete
humidity targets but no fixed-anchor forecasts in the verified source export;
neither date was removed by scoring. Rain's liquid/network gates further
reduce its fixed-anchor evaluation to 598 dates, still spanning all 20 months.

## Measurement targets

### Humidity

Reuse the frozen eleven-station catalog and canonical closest-observation
window `[valid time − 5 minutes, valid time + 5 minutes)`, with earlier ties.
Require at least three stations, including one of the nearest three; combine
valid humidity values using the existing spatial weighted median. Missing
humidity stays missing. Temperature availability cannot determine humidity
availability.

### Rain

Use Tempest-v2 accumulated millimeters and the actual reporting interval, not
polling cadence or an instantaneous precipitation rate. Walk backward from the
latest endpoint at or before the forecast hour, at most five minutes late,
selecting an exact nonoverlapping sixty-minute chain. A five-minute report can
cover redundant one-minute reports inside it; those inner reports are not added
again. Gaps, overhangs, invalid QC, and intervals longer than five minutes reject
the window. Nothing is prorated or filled with zero.

Require three complete gauges including one of the nearest three selected
Tempest stations. The primary target is their spatial weighted median. Retain
endpoint lag, a five-minute-shift sensitivity, and a spatial-mean sensitivity.
Both sensitivities reuse unchanged primary predictions, without model selection.
The primary liquid-rain population requires median gauge temperature above
2°C; cold and temperature-unknown hours are counted separately, not treated as
reliable snowfall-water-equivalent labels.

The [Tempest REST observation format](https://apidocs.tempestwx.com/reference/observation-record-format)
defines accumulated rain and report interval fields. Backward interval-end
interpretation is supported by the [Tempest UDP format](https://apidocs.tempestwx.com/reference/tempest-udp-broadcast),
but is an inference for historical REST records. This target is therefore a
reporting-hour sum close to the UTC hour, not a claim of exact UTC-hour
alignment. Open-Meteo precipitation is a preceding-hour accumulation;
its `rain` field is not interchangeable with total `precipitation`.
[Open-Meteo weather-variable definitions](https://open-meteo.com/en/docs).

### Pressure

Use Tempest-v2 absolute station pressure, with the same nearest-observation
window. Keep stations separate when fitting offsets. Compare against forecast
`surface_pressure`; retain returned forecast elevation. Do not mix sea-level
pressure, providers' relative-pressure outputs, or undocumented reference types.
Station elevation is not invented from forecast elevation.

A station-specific constant correction can absorb sensor or height differences.
It is a reference-alignment baseline, not evidence of better weather prediction.
Report a challenger's incremental improvement over that baseline and pressure
change/sign errors in addition to its improvement over raw.

## Frozen validation and candidates

Models are selected by the local month of their explicit reference, or the
clearly labeled nominal `valid time − lead` boundary for fixed anchors. Training
labels must be strictly earlier than that month's start minus 168 hours. Each
native cohort and literal lead band is isolated. Minimum support is 180 training
dates and 1,000 rows; unsupported cells keep raw predictions on the same scoring
population. Pressure support is checked independently per station.

- **Humidity:** raw, median bias, robust calendar hierarchy, and a bounded
  forecast/calendar Huber-ridge residual challenger. Hierarchy effective support
  collapses repeated vintages to valid hours.
- **Rain:** raw, a zero-rain control, conservative training-volume scaling, and
  a regularized occurrence/positive-amount hurdle challenger blended 50% with
  raw. Wet and heavy-event detection, observed-wet error, volume bias, Brier
  score, and contiguous same-run 3/6/12/24-hour sums accompany overall error.
  The hurdle Brier report identifies deterministic raw-indicator fallback;
  raw has no provider probability-of-precipitation field in this experiment.
- **Pressure:** raw, earlier-only station median offset, and a bounded
  offset-removed seasonal/forecast residual challenger. Tendency comparisons
  require genuine matching run/reference identities and paired observations.

Repeated forecasts are averaged within valid hour, then hours within local date.
Pressure additionally balances stations. Native cohorts and transfers have
separate denominators, with complete months, partial September, lead bands,
seasons, and support counts retained. Explicit ECMWF-to-Best-Match transfer
reuses the source fit without refitting; pressure transfer also requires
compatible returned forecast elevations. Humidity's fixed-anchor-to-saved-live
transfer is separately labeled as cross-lead transfer.

Mostly-dry rain MAE cannot establish a winner: a zero forecast can look good on
that metric while missing every storm. Gauge/grid representativeness also
limits point rainfall comparisons; event scores are retained for that reason.
[ECMWF precipitation-verification guidance](https://confluence.ecmwf.int/spaces/FUG/pages/673550795/Section%2B6.2.3%2BEquitable%2BThreat%2BScore).

## Recovered production-only results

The recovery reproduced every previously reported humidity score, the complete
rain report, and the four completed pressure reports exactly. It also completed
the two interrupted long-lead pressure partitions. These results cover native
fixed anchors, not the still-pending 1–48-hour public-archive experiment.

- **Humidity:** across 606 complete-period dates, ridge reduced MAE from
  **10.6482 to 8.0814 percentage points (24.1%)**. The calendar hierarchy reached
  8.1405, so the ridge's advantage over that simpler challenger is much smaller
  than its advantage over raw. Independent reconstruction passed 769 report
  groups, including the additional cohort/month and cohort/season breakdowns.
- **Rain:** across 598 dates, the hurdle increased MAE from **0.09438 to
  0.10284 mm (9.0% worse)**. Observed-wet MAE improved from 0.87829 to 0.83799 mm,
  but wet-hour detection fell from **43.75% to 33.37%**. This is not a winning
  candidate; the favorable wet-error and volume results do not erase its misses.
- **Pressure:** most of the gain over raw came from a station-specific constant
  offset. The ridge added only **0.3–3.1%** improvement over that baseline,
  depending on lead. These small incremental gains are not evidence sufficient
  to deploy a more complex model.

Pressure MAE below is in hPa, with equal station/date weighting. Each row covers
606 unique calendar dates and 2,818 station/date cells, not 2,818 independent
calendar dates. The grouped bands contain only the listed literal anchors.

| Literal anchor leads | Raw | Station offset | Ridge | Ridge gain over offset |
| --- | ---: | ---: | ---: | ---: |
| 24 h | 2.9661 | 1.0569 | 1.0251 | 3.00% |
| 48 h | 2.9234 | 1.2630 | 1.2237 | 3.12% |
| 72 h | 3.0983 | 1.5295 | 1.5005 | 1.90% |
| 96 / 120 h | 3.5292 | 2.1521 | 2.1338 | 0.85% |
| 144 / 168 h | 4.4989 | 3.3503 | 3.3392 | 0.33% |

All six production pressure partitions passed independent level, tendency,
support, and chronology checks. The first 12 hours contain only short saved-live
history in this partition; unsupported native cells retain raw predictions.
Short-lead conclusions require the separate public archive and transfer checks.
No research result changes the active production models.

## Reproduction and delivery boundary

The experiment's aggregate receipts, freezes, source bindings, and test logs are
under `.omx/evidence/rain-humidity-pressure-20260908/`. The original production
sample has verified encrypted retention. The interrupted moisture experiment
has not yet completed final encrypted retention; surviving aggregate receipts
are not a substitute for its lost row-level inputs and predictions.
The recovered production-only inputs, predictions, and reproducible source
snapshots also have a locally encrypted, member-by-member roundtrip-verified
checkpoint under `~/.weather/model-evidence/rain-humidity-pressure-recovery-20260908/`.
That checkpoint explicitly excludes the missing public archive and is not a
full-experiment completion or remote-upload receipt.
Use the existing research Python runtime; no application dependency is added.

The JavaScript research checks run through `npm run test:research` and are
included in `npm run check`. Run the Python checks separately in the isolated
research runtime, without acquiring data or writing bytecode:

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 \
  "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  -m unittest discover -s scripts/research -p 'test_*.py'
```

The safe sequence is: verify retained production packages; rebuild humidity
pairs; complete the bounded rain/pressure production export and public archive
acquisition; build measurement targets; verify manifests and join forecasts;
run frozen candidates; independently reconstruct scores; retain encrypted
inputs and predictions. Pressure lead-band partitions run sequentially to bound memory. Production
and public-archive source partitions can also run separately: native fits were
already source-isolated, and ECMWF-to-Best-Match transfers remain together in
the archive partition. This does not change any fit population or denominator.
Timestamp spelling is canonicalized at the acquisition-to-target join boundary;
strict model parsing remains unchanged. Immutable private runtime snapshots and
pre/post source hashes prevent in-flight edits from being silently misattributed.

These scripts do not qualify or deploy a model. Production remains accessible at
[Weather forecast](https://weather.ballydidean.farm/forecast).

## Forward-only review hardening

New target builds use a source-bound snapshot of the seven public Tempest
stations from the versioned domain catalog rather than a mutable ignored
catalog file. New target and sub-24 observation receipts identify that policy.
The station coordinates, distances, and weights are numerically unchanged.
Existing receipts are not retroactively assigned this provenance: older
seven-station target summaries did not bind a catalog hash, while the original
sub-24 observation receipt retained its twelve-station semantic catalog.

Acquisition and its independent verifier now reject forecast values outside
the canonical metric domains. Rain modeling rejects non-liquid targets and
nonfinite covariates; evidence retention rejects linked inputs rather than
copying their targets into an archive. These changes require a new legitimate
source freeze for future runs. They do not rewrite private evidence, rerun
historical experiments, or change deployed forecasts.

## Restart recovery

The September 8 host restart erased the experiment's `/dev/shm` workspace before
final retention. Recovery evidence is separate, under
`.omx/evidence/rain-humidity-pressure-recovery-20260908/`; the earlier receipts
are preserved rather than overwritten or relabeled as current verification.

Use an owned, private directory named `weather-moisture-research-*` directly
under `~/.weather/research-work/` for long-running research. The exporter and
retention entry points accept this disk-backed location and the original
`/dev/shm` location, rejecting symlinks, traversal, foreign ownership, and
group/world access. The humidity builder additionally requires a new `humidity`
child. Keep `.weather`, `research-work`, and the experiment root private. Disk
storage survives a host restart; it does not replace encrypted final retention.

Recovery preserves the frozen calendar, candidates, target definitions, and
model source hashes. Read-only extraction runs separately with a 2 GiB memory
limit; fits run with a 6 GiB limit, swap disabled, and pressure bands processed
sequentially. Do not put bulk research data or full-history test fixtures on
memory-backed temporary storage.

The lost public archive needs reacquisition, not an invented reconstruction
from aggregate counts. The one-time local user timer
`weather-moisture-archive-recovery-20260909.timer` schedules the original bounded
request plan for September 9 at 15:50 UTC (08:50 Pacific), more than 24 hours
after the prior acquisition. Successful acquisition starts the separate
`weather-moisture-analysis-20260909.service` through systemd `OnSuccess`.
Neither service activates or deploys a model.
The immutable request script retains the 4,800-attempt limit, globally spaced
starts, and stop-on-429 policy. After acquisition, independently verify the new
responses and account for any changed gaps before running short-lead fits;
previous success counts must not be hardcoded as new outcomes.

### Scheduled research continuation

`scripts/research/run_moisture_continuation.py` executes the following gates in
order from an immutable private runtime snapshot:

1. Independently verify all 4,260 request identities, response hashes, normalized
   values, gaps, retry policy, and request spacing.
2. Pair archive humidity to the recovered network targets and build separate
   archive rain/pressure pairs.
3. Run the four-source humidity fit, archive rain fit, and three archive pressure
   partitions (hours 1–12, 13–24, and 25–48). Independently reconstruct each
   report's scores, populations, chronology, support, and transfer results before
   continuing.
4. Combine aggregate reports with the already verified production rain and six
   pressure partitions without pooling source populations or selecting winners.
5. Require all independent verification receipts, encrypt the retained inputs,
   predictions, sources, and evidence, verify every decrypted member, and verify
   the encrypted Blueberry copy's checksum before publishing completion.

The analysis service uses the existing research Python environment, a 6 GiB
memory limit, no swap, one numerical thread, and sequential model processes.
The acquisition service retains its separate 2 GiB limit. The one-time timer is
persistent across a missed trigger while the host is offline; a running stage
interrupted by a restart is not automatically retried.

`continuation-freeze.json` binds the runtime sources, recovered inputs, original
plans, and production verification evidence. `analysis-status.json` records
each completed stage's command and exact input/output hashes. A restart can skip
only stages whose artifacts still match; changed sources, failed validation,
unexpected outputs, and partial writes stop the workflow. Partial fits or
retention require explicit operator inspection, not deletion or blind retry.
In particular, a partial retention attempt may leave a private evidence copy or
ciphertext that must be reconciled before another attempt.

`final-verification.json` is a research validation gate, not a completion or
deployment claim. Only `completion.json`, written after encrypted roundtrip and
remote checksum verification, marks the full experiment complete. Until the
scheduled download and these gates finish, short-lead results and final retention
remain pending. The timer has one calendar occurrence and does not schedule a
second acquisition after success.
