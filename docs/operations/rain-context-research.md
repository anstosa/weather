# Rain adjustment: pressure and prior-cycle forecast inputs

## Frozen development question

Do previously unused forecast predictors improve the fixed rain learners, rather
than simply changing how their existing outputs are blended? This bounded
experiment tests pressure trajectory and earlier forecast-run disagreement. It
uses the same consumed September 2025–August 2026 development population, not a
new holdout. No result can qualify a production rain model.

The original ECMWF normalized source is pinned to SHA-256
`f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1`.
It contains 3,301 complete 48-hour forecast profiles. No new API acquisition,
provider, cohort, observation target or feature-row filtering is introduced.
The original 77 features and all 32,896 evaluation forecast rows remain intact.
New source bytes, policy and reference-control identities are frozen before
fitting or reading any new candidate outcomes.

## New predictors and availability

Six pressure features use the current run's surface-pressure forecasts. For
forecast horizon `h` in 1–23 hours, source lead `L = 8 + h`:

1. pressure at L
2. pressure change from L−3 to L
3. pressure change from L−6 to L
4. pressure change from L to L+6
5. pressure range across L−3 through L+3
6. pressure change from source lead 7 to L

All these values are forecasts from the already initialized current run, not
future pressure observations. A missing value stays NaN; the seven-hour range
requires the entire window.

Twelve prior-cycle features use **only** the runs initialized six and twelve
hours before the current initialization. Older source lead `L + age` aligns
exactly with the current forecast's valid hour. Features are the two older
amounts, current-minus-older revisions, each older centered three-hour mean,
and available-vintage rain mean, population standard deviation, range,
fractions ≥0.1 and ≥1 mm/h, and available-vintage count. Three-hour means require
all three hours; other aggregate statistics use finite current/older amounts.
Missing prior runs remain NaN, never zero. No following initialization is used.

Forecast availability is simulated as initialization plus eight hours. The
following six-hour run is therefore **not** available at the current decision.
Observation availability retains the original one-hour delay. Actual historical
issue/receipt timestamps are unknown; these are conservative simulated as-of
assumptions, not proof of live availability. Current raw rain, temperature,
initialization, lead and valid-hour identities must match the original paired
rows before any added feature is accepted.

New derived features use source float64 measurements before float32 storage;
the original 77 feature columns are unchanged. The builder cannot access rain
labels. Full feature arrays and missingness masks are retained for independent
reconstruction, including all training and calibration rows.

## Fixed learners, controls and screening

The selectable arms are `weightedContext` and `ordinalContext`, each with all
95 features. The controls are:

- `weightedBase`: the original 77-feature moderate-weight Tweedie model
- `weightedPressure`: the same learner with only six added pressure features
- `weightedCycles`: the same learner with only twelve added prior-cycle features
- `ordinalBase`: the original 77-feature ordinal/wet-gamma model
- raw, zero, persistence, original 45-day volume scaling and 90-day volume scaling

Only inputs change. All trees retain depth three, 160 rounds, fixed seed and
pinned CPU XGBoost 3.4.1 parameters. Tweedie training retains dry/wet/heavy costs
1/2/4 with unchanged normalized date/hour/vintage weights and a 25% raw anchor.
Ordinal training retains the three 0.1/1/2.5 mm/h event heads, positive wet gamma
head, calibration cutoffs, composite raw-event safety fallback, 25% raw anchor
and disjoint final amount bands. Native base models, their monthly calibration
states and their predictions must reproduce the prior search **exactly before
any new aggregate scores are calculated**.

Training ends 104 days before each evaluation month. Calibration uses days −97
through −7, with seven-day gaps on either side. Both learners retain the same
bounded [0.1, 3] final-output scalar on the earlier 90-day calibration population.
Infeasible scalar means remain explicitly reported saturated endpoints. No
seasonal multiplier, timing correction, hybrid route or parameter search is added.

Each selectable arm must pass all 44 original gates plus:

1. MAE no worse than the 90-day volume baseline
2. MAE strictly better than its unchanged same-family control by more than 1e-12
3. complete six-feature pressure information and at least one older target-hour
   forecast on at least 95% of evaluation rows and 300 distinct valid dates

All **47 gates** must pass. If both pass, select lower MAE with name tie-break;
otherwise select none. Single-group ablations are diagnostic controls and cannot
be promoted after seeing outcomes. All seasons, lead bands, months, archive eras,
mean-target sensitivity, events and complete accumulation windows are reported.
Feature-availability coverage uses the same reporting partitions without
filtering the scored population.

## Validation and risks

Synthetic tests lock source/valid-hour joins, horizon boundaries, missingness,
future-cycle exclusion, no label reads, unchanged native controls, chronology,
projection/calibration and strict selection. A separately written verifier must
reconstruct every added feature, refit every native booster, and reproduce all
predictions, support, metrics and gates. That verifies implementation consistency,
not out-of-sample generalization.

Pressure and successive runs may supply mostly redundant information. Heavy
rain remains sparse, the source model changed during this period, and consumed
development outcomes have already influenced research direction. Even a passing
result would require a separately frozen prospective evaluation on new data
with recorded live source availability. Nothing is deployed by this experiment.

## Completed development result

**No candidate selected.** The added inputs improved both frozen learner
families, but `weightedContext` failed **8 of 47 gates** and `ordinalContext`
failed **10 of 47**. All 32,896 forecast rows were retained, with 8,641 distinct
valid hours, 366 dates, 131 wet dates and 203 distinct hours ≥1 mm/h. All twelve
model-months were supported for every learner. Full new-information coverage
was 32,873 rows (99.93%) spanning every valid date.

| Forecast | MAE (mm/h) | Wet-hour MAE | Heavy-hour MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Raw | 0.126445 | 0.819612 | 1.472778 | 1.541668 |
| 90-day volume scaling | 0.103198 | 0.785404 | 1.602447 | 1.025845 |
| Original moderate weighting | 0.102884 | 0.751300 | 1.591279 | 1.032927 |
| Moderate + pressure only | 0.100518 | 0.743308 | 1.576573 | 1.001388 |
| Moderate + prior cycles only | 0.101875 | 0.744361 | 1.554482 | 1.053371 |
| **Moderate + both input groups** | **0.100016** | **0.735775** | **1.538543** | **1.032437** |
| Original ordinal | 0.107134 | 0.806544 | 1.553507 | 1.115314 |
| **Ordinal + both input groups** | **0.104229** | **0.778934** | **1.464274** | **1.135528** |

Pressure alone reduced the weighted learner's MAE by 2.30%; prior cycles alone
by 0.98%; together by 2.79%. The combined version beat 90-day scaling by 3.08%
and raw by 20.90%. Its heavy-hour MAE was 4.47% above raw, now inside the existing
5% allowance. However, ≥1 mm/h detection remained only 15.88% versus raw 34.71%,
and it detected none of the observed ≥2.5 mm/h events. Better overall MAE does
not compensate for those failures.

The new ordinal inputs reduced MAE by 2.71% relative to the identical original
ordinal learner. Heavy-hour MAE became **0.58% lower than raw**, and ≥1 mm/h
detection rose from the old ordinal 38.37% to **47.71%**, versus raw 34.71%.
Wet detection was 85.18% versus raw 81.08%. Overall event safety passed at all
three thresholds. There is still a tradeoff: ≥2.5 mm/h detection fell from the
old ordinal 20.19% to 16.02%, although it remained above raw 10.20%. Its overall
MAE was still 1.00% worse than simple 90-day scaling.

Seasonality remains unresolved. Combined-input moderate weighting produced
winter/spring volume ratios **1.284/0.756**, improved from **1.372/0.660** but
outside [0.8, 1.2]. The ordinal ratios were **1.363/0.754**, and its autumn
volume ratio was 1.273. Both full-context learners improved winter and autumn
MAE versus their own base controls but worsened spring and summer MAE. Three
ordinal calibrations saturated at the lower bound; all moderate calibrations
matched within the frozen tolerance.

These are more encouraging input-level development signals than the preceding
failed hybrid, not independently established predictive gains. No arm is
promoted, no single-group control is relabeled as a winner, and no thresholds
or model parameters are retuned after these outcomes. Further research should
retain these inputs as hypotheses while addressing seasonal and heavy-event
failures under a separately frozen protocol.

Independent verification reconstructed the complete **73,744 × 95** feature
matrix and all missingness masks exactly from the 3,301 original profiles. It
refitted **144 native boosters to identical model SHA-256 values**, reproduced
all twelve monthly states, predictions, reporting partitions and all 47 gates
per candidate, and confirmed the prior-search base controls exactly. The full
rain suite passed **247 tests**, including 29 new producer/feature/verifier
tests; targeted Ruff, AST checks and full `npm run check` also passed. All five
previous experiments' frozen sources and retained review files remain unchanged.

The evidence is retained locally in an encrypted archive with a verified
streaming decryption round trip. No remote archive copy, new data acquisition
or production deployment was made. An initial independent-verifier launcher
failed before Python started because it used a relative path; its log is
retained alongside the successful absolute-path replay, with no source or
policy changes.

Evidence identities:

- Freeze SHA-256: `3a3e88033b8ab5a4771f2c85e3a694392bb8755e207097b23d519a5be2bd7427`
- Report SHA-256: `cfab32d382b3de0d34ee27aa21fddec7de29fc04d6cec48ed4f3b33bb6a55aae`
- Prediction SHA-256: `8c04ceaf14b75f4c9b8ec35b636989aa632c9a8fe60ff9600b9016630804d426`
- Full feature archive SHA-256: `eeb073a89b846295d9f46c8592b065033f564eb8b73ff50d32b92a0decaa127a`

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-context-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_context.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_context.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/verify_rain_context.py "$ROOT" /path/to/new-verification.json
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Native numerical threads are pinned to one. Development runs are bounded with
CPU and memory limits; private inputs, models and predictions remain outside
Git. Existing experiment files are not changed. No production database,
configuration, API or bundle is altered. Public forecast:
<https://weather.ballydidean.farm/forecast>.
