# Rain event-guard development experiment

## Prespecified scope

This is one new rain-only postprocessing experiment, not a production model or
an independent accuracy test. It reuses the exact monthly Tweedie boosters from
the [first-day experiment](rain-sub24-research.md). No model is refitted and no
prior model, source snapshot, prediction, or report is replaced.

The September 2025–August 2026 decision months are now explicitly **consumed
development data**. They provide all four seasons but cannot become a fresh
holdout for this revised candidate. Forecast decisions retain the simulated
initialization-plus-eight-hour boundary; horizons are 1–23 hours after that
decision. Targets and station features retain the original complete-hour,
network-median and lagged-observation contracts. These are not direct farm-site
measurements or historically verified receipt-time forecasts.

## One fixed candidate

For each original monthly model, obtain its native Tweedie prediction capped
to 0–30 mm/h, blend equally with raw, and apply the original earlier-only
45-day calibration scalar for `tweedie-raw0.5`. Cap that calibrated blend to
0–30 mm/h, then apply these rules exactly once:

1. Raw rain at least 1 mm/h: retain the exact raw amount.
2. Raw rain at least 0.1 but below 1 mm/h: use the blend, floored at 0.1 mm/h.
3. Raw rain below 0.1 mm/h: use the blend, allowing previously missed rain.

There is no second scaling after the guard. Keeping a raw-heavy forecast above
1 mm/h is not sufficient: its entire original amount is preserved. This
protects raw event calls but does not guarantee better observed-heavy intensity,
rain volume, or false-alarm performance. New wet calls can be false alarms.

Raw, zero, persistence and earlier-only raw volume scaling are controls. The
identically calibrated blend without the guard is an attribution diagnostic,
not an alternative eligible for selection. Only `eventGuard` is screened.

## Frozen screening and stopping

Every arm is scored on identical rows with equal date/hour/vintage weights.
The screen requires at least 5% lower hourly MAE than raw, no worse RMSE, MAE
no worse than volume scaling and persistence, no worse observed-wet MAE,
observed-heavy MAE within 5% of raw, and annual balanced volume ratio 0.8–1.2.
The ratio is not an unweighted hydrologic rainfall total.

At 0.1, 1 and 2.5 mm/h, detection probability cannot decrease; CSI can decrease
by at most 0.01 and false-alarm ratio can rise by at most 0.05. Missing event
metrics fail closed. All four seasons must independently pass volume, wet/heavy
intensity and wet-event safety checks. Seasonal MAE cannot rise over 10%; each
first-day lead band's MAE cannot rise over 5%. Explicit date/wet/heavy support
floors and complete 6/12/23-hour accumulation checks also apply. Accumulations
use the corrected date/hour endpoint weighting, not the original report's
unweighted window metrics.

Probability inputs to scoring are deterministic point-event indicators, not
calibrated probabilistic forecasts. Brier scores are diagnostic only. The
arithmetic-mean target and pre/post-May-2026 archive eras are reported as
sensitivities, never alternate selection populations.

The policy, sources, input hashes and candidate formula are frozen before new
candidate outcomes are read. A failed screen closes this experiment without
retuning, picking a favorable slice, or promoting a control. A pass would only
justify a separately frozen prospective protocol, not deployment.

## Prospective boundary

No independent evaluation is performed or scheduled here. October 1, 2026 is
the earliest reserved decision boundary, **conditional** on a separate frozen
protocol, current-era same-source forecasts, real forecast/station receipt
timestamps, and causal feature/label availability validation. The date alone
does not make retrospective data operationally valid. If prerequisites are not
met, evaluation remains unopened; it does not silently move or backfill a test.

There is no rain activation, humidity/pressure change, new dependency, service
change or deployment. The existing [forecast](https://weather.ballydidean.farm/forecast)
continues to serve raw rain.

## Reproduction

Use the existing isolated numerical runtime and a new private output root:

```sh
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/rain_event_guard.py prepare ORIGINAL_PRIVATE_SUB24_ROOT NEW_PRIVATE_ROOT \
  --retention-receipt ORIGINAL_RETENTION_RECEIPT_JSON
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/rain_event_guard.py run NEW_PRIVATE_ROOT
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/verify_rain_event_guard.py NEW_PRIVATE_ROOT NEW_VERIFICATION_JSON
```

The original full input acquisition is covered by its retained independent
receipts and encrypted archive. The new snapshot binds those receipts, source
manifests, paired/hourly data, original code freeze, native boosters and states.
New predictions and model material stay private. Aggregate results and
independent replay evidence are reported separately after completion.

## Result — September 13, 2026 UTC

**Rejected in development.** The policy was frozen at `2026-09-13T00:49:53Z`.
The single replay reused twelve native monthly states and scored 32,896
forecasts on 8,641 unique hours, 366 target dates, 131 wet dates and 203 heavy
hours. No new evaluation data was opened and no candidate was retuned.

| Metric | Raw | Earlier-only volume scaling | Event guard |
| --- | ---: | ---: | ---: |
| Hourly MAE, mm/h | 0.126445 | 0.103392 | 0.123654 |
| Hourly RMSE, mm/h | 0.519372 | 0.437963 | 0.518649 |
| Observed-wet MAE, mm/h | 0.819612 | 0.784215 | 0.828289 |
| Observed-heavy MAE, mm/h | 1.472778 | 1.576329 | 1.541995 |
| Balanced volume ratio | 1.541668 | 1.051359 | 1.431355 |
| Wet-event detection | 81.08% | 70.48% | 82.35% |
| False-alarm ratio | 67.18% | 60.37% | 67.48% |

The guard does preserve every raw-heavy amount and raw-wet call. Its 144 added
wet forecast rows include 31 observed-wet rows; these are overlapping forecast
vintages, not counts of distinct storms. Detection at all three thresholds
passes the fixed safety screen.

However, overall MAE improves only **2.21%**, short of the required 5%, and loses
to simple volume scaling. Observed-wet error increases **1.06%**. Heavy-hour
error increases **4.70%**, narrowly within the overall 5% allowance, but the
seasonal intensity checks still fail. The balanced volume ratio is **1.43**
overall and **1.94 in winter**; retaining raw-heavy values also retains much of
the raw winter excess. The lower-error unguarded diagnostic is not selected:
its detection drops and it is not the prespecified candidate.

Nine of the 44 gates fail: overall MAE improvement, comparison with volume
scaling, wet intensity, annual volume, winter volume and intensity, summer
intensity, spring intensity, and autumn volume. The complete 6/12/23-hour
accumulation checks pass against raw but still lose to volume scaling. The
current archive era retains only 19 wet dates, so this remains insufficient
for a current-era all-season claim regardless of the development result.

The separate verifier independently reconstructed native predictions, both
earlier calibration scales, every reported metric and gate, target/support
lineage, and the original encrypted-archive member chain. Verification passed;
model qualification did not. The bounded replay took 0.92 seconds and about
121 MiB peak resident memory, with no swap. This is a postprocessor replay,
not a newly trained model.

Aggregate evidence is under `.omx/evidence/rain-event-guard-20260913/`. The
private output root is
`~/.weather/research-work/weather-moisture-research-rain-event-guard-20260913-v1/`.
The exact report SHA-256 is
`bd238d3f21aa75667057dcd27528ba8ac7f089c53cf34a7a28178f73730baa9e`.
The original experiments and production Weather services remain unchanged.

All 129 rain-related Python tests, Ruff error checks, AST parsing and the full
workspace `npm run check` passed. Final independent-verifier code and runtime
hashes are recorded separately from the pre-outcome producer freeze. The
new private retention uses the existing backup recipient and a member-by-member
decrypted checksum check; its scope is local private disk, not a production
upload or deployment.
