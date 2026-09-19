# Rain adjustment: severity-gated seasonal hybrid

## One development-only hypothesis

This experiment combines the moderately weighted model's ordinary-rain amounts
with ordinal heavy-event signals and a new heavy-intensity head. It is not a
grid search or an average of the previous final forecasts. September 2025–August
2026 is already consumed development data; this replay is not an independent
holdout and cannot qualify a model for deployment.

The original paired rows, 77 features, forecast-time temperature gate, gauge
target and date/hour/vintage weights are unchanged. No previous experiment is
edited. The new policy, sources and input identities are frozen before fitting.

## Forecast-only routing and amount heads

- Ordinary head: existing depth-three, 160-round Tweedie model, observed
  dry/wet/heavy fit weights 1/2/4, amount 25% raw plus 75% learned.
- Severity signals: existing ordinal classifiers at 1 and 2.5 mm/h, using only
  forecast-time features. Cutoffs use earlier calibration with the existing
  raw-recall-plus-0.05 target and FAR/CSI safeguards. Nested heavy calls also
  receive a composite safety check; failure resets both heavy calls to raw.
- Heavy amount: a separate 160-round gamma model fitted only on earlier observed
  hours ≥1 mm/h, requiring 50 distinct hours and ten dates. Its amount is 50% raw
  plus 50% learned. Observed severity is used for training labels, **never for
  routing an evaluation forecast**.

The highest called heavy category selects the amount branch. Final amount bands
are ordinary [0, 1), heavy [1, 2.5) and higher intensity [2.5, 30] mm/h. Ordinary
forecasts have no forced 0.1 mm/h floor. Seasonal and global scalar adjustments
are applied before category projection. Unsupported heavy training makes the
primary and its support-matched ablations fall back to raw on the entire month.

The existing wet-only gamma and 0.1 mm/h classifier are refitted only to retain
an unchanged ordinal reference control. All six monthly native boosters use the
pinned XGBoost 3.4.1 runtime and the previous fixed tree parameters.

## Causal seasonality transfer

Training ends 104 days before the evaluation month. Calibration uses days −97
through −7, with seven-day gaps on both sides. Seasonal factors are estimated
from **training-only raw forecast errors**, not in-sample learned-model errors
and not retrospective predictions on dates the learner already fitted.

For each meteorological season, estimate the date-balanced observed/raw volume
ratio and divide by the all-training ratio. Shrink that relative ratio toward
one in log space with weight `seasonDates / (seasonDates + 60)`. Volume ratios
are bounded to [0.1, 3]; relative seasonal multipliers to [0.5, 2]. A season
requires 30 dates, ten wet dates and five heavy hours; unidentified or unsupported
ratios use a unit multiplier, with the reason recorded.

This tests whether historical **raw** seasonal bias transfers usefully to the
hybrid. Transfer is a hypothesis, not an assumption of calibrated learned-model
errors. The season multiplier uses only the forecast's known UTC valid date.
The final global scalar is fitted on the disjoint earlier 90-day calibration
rows, including the final category projection. Infeasible means retain explicit
bounded-endpoint saturation rather than a false exact-match claim.

## Controls, ablations and decision

The single selectable primary is `hybridSeasonal`. Controls include raw, zero,
persistence, original 45-day scaling, 90-day scaling, season-aware raw scaling,
the original moderately weighted forecast and the original ordinal forecast.

Two support-matched ablations test whether complexity earns its place:

- `hybrid90`: identical routing and amounts, without seasonal multipliers.
- `weightedSeasonal`: ordinary weighted model with the same seasonal factors and
  calibration, without the severity route or heavy-amount branch.

All 44 residual-experiment performance gates remain unchanged. Additional gates
require beating 90-day scaling, beating matched season-aware raw scaling, and
demonstrating hybrid added value: effective heavy routing on at least 20 dates
and MAE strictly below **both** ablations by more than 1e-12 mm/h. All **47 gates**
must pass. Ablations are reported but cannot be promoted after seeing outcomes.

The main risks remain sparse heavy rain, false heavy calls, transferring a raw
bias correction onto a learner that already uses calendar features, and reused
development outcomes. Retrospective availability uses simulated eight-hour
forecast and one-hour observation delays, not verified historical receipts.
Any eventual production qualification needs a separately frozen prospective
protocol with genuinely new observations and availability evidence.

## Completed development result

**Rejected: 17 of 47 gates failed**, including 14 of the original 44 gates.
The rejection is not merely an added complexity requirement. All 12 model-months
had sufficient training support; all 32,896 original forecast rows remained.
Effective heavy routing affected 1,433 rows across 661 distinct hours and 104
dates, including 71 wet dates. The mechanism had ample coverage to be tested.

| Forecast | MAE (mm/h) | Wet-hour MAE | Heavy-hour MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Raw | 0.126445 | 0.819612 | 1.472778 | 1.541668 |
| 90-day volume scaling | 0.103198 | 0.785404 | 1.602447 | 1.025845 |
| Seasonal raw scaling | 0.106379 | 0.795765 | 1.622559 | 1.062393 |
| Original moderate weighting | 0.102884 | 0.751300 | 1.591279 | 1.032927 |
| Seasonal moderate weighting | 0.105718 | 0.759954 | 1.597750 | 1.066805 |
| Original ordinal reference | 0.107134 | 0.806544 | 1.553507 | 1.115314 |
| Non-seasonal hybrid | 0.105112 | 0.820839 | 1.565023 | 1.058241 |
| **Seasonal hybrid primary** | **0.106595** | **0.822281** | **1.562395** | **1.083107** |

The primary improved average error by 15.70% versus raw, but was 3.29% worse
than simple 90-day scaling and lost to both ablations. Its heavy-hour error was
6.08% worse than raw, exceeding the unchanged 5% allowance.

The heavy routing retained the ordinal classifier's detection improvements:
38.37% versus raw 34.71% at 1 mm/h, and 20.19% versus 10.20% at 2.5 mm/h.
However, rain detection at 0.1 mm/h fell to **54.36% versus raw 81.08%**.
Thus the model did not successfully combine ordinary-rain and heavy-rain skill.
Four monthly calibrations hit the lower scalar bound, reported explicitly.

This seasonal estimator worsened MAE for raw scaling, moderate weighting and
the hybrid in their matched comparisons. The primary still overpredicted
winter volume by 44.66% and underpredicted spring by 59.95%; annual volume alone
would conceal both failures. This is a negative result for this specific
training-only raw-bias transfer, not proof that every seasonal method fails.

The experiment is closed without retuning or promoting an ablation. Given the
repeated tradeoff between missed ordinary rain and heavy false alarms, the next
research direction should seek additional predictive information rather than
another blend-weight search on these same consumed outcomes.

Independent verification refitted all 72 native boosters to identical model
SHA-256 values and reproduced every monthly state, prediction, support flag,
heavy-route flag, metric and gate. The complete rain suite passed 218 tests,
including 13 new producer tests and ten independent-verifier tests; targeted
Ruff, AST and full `npm run check` passed. Verification establishes implementation consistency,
not independent forecast qualification.
The exact evidence is retained locally in an encrypted archive with a verified
decryption round trip. No remote archive copy or production deployment was made.

Evidence identities:

- Freeze SHA-256: `067dddb0115951f9f33bd2abd063a961d1b1f4d10a8b64f352bbcdd7457c0c73`
- Report SHA-256: `b88337f8ac3eb2245d8322ab8b08e248c80834c5c69d64303f5caef67ea6bfcf`
- Prediction SHA-256: `6b0944a4d975a6bda64d74aa5b6fb77078e86087e759a81a05abd38def6ca8fc`

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-hybrid-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_hybrid.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_hybrid.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/verify_rain_hybrid.py "$ROOT" /path/to/new-verification.json
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Private models and predictions remain outside Git. No production configuration,
API, database or bundle is changed. Public forecast:
<https://weather.ballydidean.farm/forecast>.
