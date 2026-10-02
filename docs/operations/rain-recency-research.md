# Rain adjustment: recent-weighted calibration of fixed context models

## Frozen development hypothesis

Test whether the context ordinal model's seasonal errors improve when recent
observations receive more calibration weight. The model, its pressure/prior-cycle
inputs and its original training/calibration/evaluation chronology do not change.
This is one calibration rule, not a half-life or model search. September 2025–
August 2026 is already consumed development data; results are not an independent
holdout and cannot authorize deployment.

The previous context experiment's model states, 95-column feature archive,
source profiles and reference predictions are copied from its locally encrypted,
roundtrip-verified retention manifest. All identities are pinned before any new
candidate outcomes. The producer **does not train trees**. It reuses the same
48 ordinal boosters and twelve weighted-amount control boosters, checking hashes,
objectives, feature order and 160 rounds. Uniform-calibration states and all
unchanged control predictions must reproduce the context experiment exactly.
All previous experiment files remain unchanged.

## One calibration-weight change

Training still ends 104 days before each evaluation month. The same earlier
90-day calibration window ends seven days before that month, with a seven-day
gap between training and calibration. Start with the original equal-date,
equal-hour, equal-vintage weights. Multiply each row's weight by:

`2 ** (-ageInUtcDates / 30)`

Age is measured from the last date before the exclusive calibration stop. Then
normalize to sum to one. Evidence thirty days older has half the date mass;
overlapping vintages cannot manufacture additional support. No calibration
window, embargo, half-life or target-dependent weight is selected from results.

The recent weights are used for both event-cutoff calibration and the final
amount scalar. Original 0.1/1/2.5 mm/h definitions, positive-hour/date support,
raw-recall-plus-0.05 targets, FAR/CSI safeguards, composite nested-call fallback,
25% raw anchor and disjoint amount bands remain unchanged. The final scalar
still uses [0.1, 3], 64 bisections and explicit endpoint saturation when the
calibration mean is unattainable. No new seasonal multiplier is introduced.

Original training and calibration support checks remain. Recent calibration
also requires at least 30 Kish-effective dates and three Kish-effective wet
dates, computed from aggregated date mass. Wet mass uses only observed hours
≥0.1 mm/h. If unsupported, every candidate/ablation row keeps the unchanged
ordinal forecast; recent raw scaling keeps the original 90-day scaling. The
month is flagged unsupported, not dropped from evaluation.

**Evaluation scores do not receive recent weighting.** All annual, seasonal,
monthly, lead-band, archive-era, event, mean-target sensitivity and complete
6/12/23-hour accumulation comparisons retain the original scoring populations
and date/hour/vintage weights. Source availability remains simulated forecast
initialization +8 hours and observations available at decision −1 hour, not
verified historical issue/receipt timestamps.

## Primary, controls and attribution

The only selectable candidate is `ordinalRecent`: recent weights for both
cutoffs and amounts. Two nonselectable diagnostic ablations isolate changes:

- `ordinalRecentAmount`: original uniform event rules; recent amount scalar
- `ordinalRecentEvents`: recent event rules; original uniform scalar fitting

The latter refits a uniform scalar on its changed final category projection;
it does not reuse a scalar that was calibrated to different calls.

Controls include raw, zero, persistence, original 45-day scaling, original
90-day scaling, recent-weighted raw scaling, the exact unchanged context
ordinal forecast (`ordinal90`), and the exact context weighted-amount forecast.
Thus a generic improvement from reweighting raw volume alone cannot qualify a
more complex candidate.

All 44 original empirical/support gates remain. Five additional gates require:

1. MAE no worse than the original 90-day volume baseline
2. MAE no worse than the same recent-weighted raw baseline
3. MAE strictly better than the unchanged context ordinal model
4. a strictly smaller worst absolute seasonal volume-ratio deviation from one,
   across all four seasons, than that unchanged ordinal model
5. retention of its gained heavy-rain skill: heavy-hour MAE no worse; at both
   1 and 2.5 mm/h POD no lower, CSI no more than 0.01 lower, and FAR no more
   than 0.05 higher

Comparisons use a 1e-12 numerical tolerance/margin. All **49 gates** must pass.
Controls and ablations cannot be promoted after looking at outcomes. A negative
result remains retained without further tuning inside this experiment.

## Verification and limitations

Synthetic tests lock chronology, decay ratios, duplicate-vintage balance,
effective support, cutoff/saturation behavior, reference identity, unsupported
fallback and every selection boundary. An independent verifier reconstructs
all 95 source features, refits the 60 unchanged native boosters solely to verify
lineage, and separately replays recent-weighted calibration, every prediction,
partition and gate. Verification refits do not replace or tune producer models.

A fixed half-life can overreact to a few storms even with effective-support
checks. More responsive calibration is a hypothesis, not an assumed explanation
of seasonal errors. Rare heavy rain, source-model changes and repeated use of
this development period remain limitations. A passing result would still need
a separately frozen evaluation on new observations with real receipt times.

## Completed development result

**Rejected: 9 of 49 gates failed**, including six of the original 44. No
candidate was selected. All twelve months passed both original and effective
support requirements; all 32,896 evaluation rows were retained. Effective
calibration date support was 67.33 dates per month; effective wet-date support
ranged from 3.49 to 27.70. No monthly effective-support fallback was required.

| Forecast | MAE (mm/h) | Wet-hour MAE | Heavy-hour MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Unchanged context ordinal | 0.104229 | 0.778934 | 1.464274 | 1.135528 |
| Recent amount only | 0.103465 | 0.778994 | 1.463976 | 1.123054 |
| Recent event cutoffs only | 0.104493 | 0.782615 | 1.475075 | 1.140997 |
| **Recent event cutoffs and amounts** | **0.103459** | **0.785757** | **1.479273** | **1.117492** |
| Original 90-day raw scaling | 0.103198 | 0.785404 | 1.602447 | 1.025845 |
| Recent-weighted raw scaling | 0.102662 | 0.783990 | 1.594287 | 1.024530 |
| Unchanged context weighted amount | 0.100016 | 0.735775 | 1.538543 | 1.032437 |
| Raw | 0.126445 | 0.819612 | 1.472778 | 1.541668 |

The primary reduced average error by 0.74% versus the unchanged ordinal model,
but remained worse than both original 90-day and recent-weighted raw scaling.
The amount-only ablation reduced error by 0.73%, nearly the same improvement;
changing event cutoffs alone increased error by 0.25%. This suggests the useful
part of this particular replay is amount calibration rather than the event
cutoff change, not evidence that an ablation should be promoted after the fact.

The primary's ≥1 mm/h detection fell from **47.71% to 45.49%**, while ≥2.5 mm/h
detection rose from **16.02% to 19.09%**. Heavy-hour MAE increased by **1.02%**
relative to the unchanged ordinal model. All three overall event-safety checks
against raw still passed, but the stricter requirement to retain the previous
model's heavy-rain skill failed. The amount-only ablation preserved all event
calls exactly and left overall heavy-hour MAE almost unchanged.

| Season | Original ordinal volume ratio | Full recent-rule volume ratio |
| --- | ---: | ---: |
| Winter | 1.363 | 1.275 |
| Spring | 0.754 | 0.811 |
| Summer | 0.978 | 0.827 |
| Autumn | 1.273 | 1.294 |

Spring volume entered the unchanged [0.8, 1.2] acceptance range. The worst
absolute seasonal volume error improved from 36.26% to 29.44%, so that added
improvement gate passed. However, winter and autumn still exceeded the allowed
range, and summer/autumn volume balance worsened versus the original model.
The original seasonal wet/heavy-error and autumn-detection failures also remain.
Seasonal improvement is partial, not a general correction. Four primary
monthly scalar calibrations saturated at the lower bound, versus three in the
unchanged ordinal control; all such endpoints remain explicitly reported.

The experiment closes without changing its half-life, support minima, event
threshold policy or selection gates. Amount-only recency is a small development
signal that may inform a separately frozen future hypothesis; it was a
nonselectable control here and has not qualified for deployment. No independent
future-data evaluation has been performed.

Independent verification reconstructed all **73,744 × 95** feature values and
availability masks from 3,301 original source profiles. It refitted all **60
unchanged boosters to identical model SHA-256 values** and reproduced every
monthly calibration state, prediction, reporting partition and all 49 gates.
The seven unchanged reference forecasts matched their prior predictions exactly.
The full rain suite passed **276 tests**, including 29 new tests; targeted Ruff,
AST checks and full `npm run check` passed. All six previous experiments' frozen
sources and retained review files remain unchanged.

The authoritative receipt is `independent-verification-v2.json`. An initial
verifier-only argument error stopped before model fitting; its failure log is
retained. After fixing the argument and adding a regression guard/test, the
final verifier source completed a fresh full replay. No producer policy,
model, input or output was changed in response to this verifier error.

Evidence is retained locally in an encrypted archive with a verified streaming
decryption round trip. No remote copy, production deployment or new acquisition
was performed. Implementation replay is not independent predictive validation.

Evidence identities:

- Freeze SHA-256: `262faaa7f2190ba6de6a2a4324681ebfd3228ca07cc7890a010080b78193d6bb`
- Report SHA-256: `115298848c368e5b632a17cf58892f2cd0d061eae1a314f0de41955d1e226a5e`
- Prediction SHA-256: `78d2c60c3115faec558e4bf1b26055ed56078281636b4914879c8c53abb5fabe`
- Unchanged feature archive SHA-256: `eeb073a89b846295d9f46c8592b065033f564eb8b73ff50d32b92a0decaa127a`

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-recency-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_recency.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_recency.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/verify_rain_recency.py "$ROOT" /path/to/new-verification.json
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Runs use the pinned XGBoost 3.4.1 CPU environment and single numerical threads.
Private data, models and predictions stay outside Git. No production database,
configuration, API or bundle changes are part of this research. Public forecast:
<https://weather.ballydidean.farm/forecast>.
