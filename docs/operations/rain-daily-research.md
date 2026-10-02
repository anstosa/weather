# Rain adjustment: daily rolling calibration

## Frozen next hypothesis

The 101-feature trajectory model improved heavy-rain skill but failed ten of the
unchanged 49 development checks, with excessive winter/autumn volume and weak
spring/summer detection. Monthly calibration can be seven to approximately
37 days behind a forecast decision. This experiment tests **cadence only**:
refresh the same calibration algorithm each UTC decision date.

For UTC decision date `D`, where decision time is forecast initialization plus
eight hours:

1. Reuse the exact four previously verified 101-feature native boosters for that
   decision month. No trees are fitted, parameters selected or predictors added.
2. Use only calibration rows with valid hours in `[D−97 days, D−7 days)`. This
   retains the original 90-day window and seven-day embargo.
3. Apply the unchanged uniform ordinal event calibration, nested safety check,
   and hurdle wet-cutoff/category-amount calibration. All weights, support
   thresholds, scalar bounds and fallback rules inside those algorithms remain
   unchanged.
4. Predict only rows whose simulated decision falls on `D`. If daily calibration
   or effective support is insufficient, copy that day's frozen monthly
   trajectory forecasts exactly. Never delete a row.

Each monthly model's original training cutoff precedes every daily calibration
window that uses it. Calibration can incorporate **earlier same-month labels
only after the seven-day embargo**. This is prequential development evaluation,
not an untouched monthly holdout. Later observations cannot enter a prediction's
calibration, features or model fitting. Native inference uses only the needed
calibration and forecast source rows; model inference receives no target labels.

Only `hurdleDaily` is selectable. `trajectoryOriginal`, `hurdleOriginal` and all
eleven recency arms are exact, nonselectable controls. All 32,896 evaluation rows
and all 49 gates remain fixed, including retained ordinal heavy-event skill.
Changing calibration may change heavy calls, so a pass must be demonstrated,
not assumed from unchanged native models.

## Evidence and qualification boundaries

All prior failures remain retained. The new root snapshots the verified trajectory
source/input envelope, feature matrix, native models, monthly states, predictions
and retention receipt. Each decision date gets a separate retained calibration
state with exact half-open bounds, support, rules and model-month identity.

The repeatedly examined September 2025–August 2026 year remains consumed
development data. A pass would still need a separately frozen fresh-data
confirmation before production qualification. Historical forecast issue receipts
remain unavailable; initialization plus eight hours is a simulation, not proof of
real-time availability. No acquisition, service or production model is changed.

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-trajectory-20260913-v1"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-daily-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-trajectory-20260913/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_daily.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_daily.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/test_rain_daily.py
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Run bounded single-threaded CPU jobs. Private data and model artifacts remain
outside Git. The live forecast is unchanged:
<https://weather.ballydidean.farm/forecast>.

## Development result

**Not selected: 40/49 checks pass; nine fail.** All 365 decision dates have
sufficient calibration support. Daily refresh reduces overall MAE by 0.98%
versus the same monthly model, but does not solve winter/autumn overprediction or
spring/summer wet detection. It also loses the original ordinal's 1 mm/h recall.

| Model | MAE (mm/h) | Wet MAE | Heavy MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Daily recalibration | 0.102988 | 0.748343 | 1.416053 | 1.202929 |
| Monthly trajectory | 0.104011 | 0.751610 | 1.407757 | 1.213675 |
| Original hurdle | 0.103547 | 0.760097 | 1.422416 | 1.189117 |
| Recent raw-volume control | 0.102662 | 0.783990 | 1.594287 | 1.024530 |

Daily seasonal volume ratios are winter 1.398591, spring 1.038819, summer
0.854342 and autumn 1.237898. Its 1 mm/h POD is 0.447714, below the unchanged
ordinal's 0.477100. Its overall event checks still pass against raw, but the
stricter retained ordinal heavy-skill requirement fails. No tolerance was relaxed
to accept the annual volume ratio of 1.202929.

Failed gates: `annualVolumeBalanced`, `seasonDJFVolume`, `seasonJJAWetHeavy`,
`seasonJJADetection`, `seasonMAMDetection`, `seasonSONVolume`,
`beatsRecentVolumeScale`, `seasonalBalanceImproves`, `heavySkillRetained`.

The cadence mechanism produces a real development improvement over its matched
monthly control, not a complete qualification. No production change was made.

### Verification and retained identities

Independent verification reconstructed all 101 features, refitted and hashed the
48 reused monthly boosters, replayed all 365 daily states and reproduced all
32,896 predictions and 49 gates. The fixed evaluator reports **FAIL with no
proof errors**. All **362 rain tests** pass; targeted Ruff, AST and whitespace
checks pass; all eleven prior experiment freezes and retained review files remain
unchanged. Fresh `npm run check` passed lint, typecheck, workspace tests and build.
Its first attempt encountered generated Ruff cache binaries in the research
source directory; moving that cache into retained evidence resolved the lint
failure without modifying any source. Both check attempts remain recorded.

- Freeze: `031d60682f08f4d15cd3db99558cbef9e43e9eb61ef42052bf91e852c44da96b`
- Report: `a986fd26089994546dde93a499e3d47bc57bf3fabe2d2cee7cf9c7e3c8a98872`
- Predictions: `801a3c9f3eedee8377560f361b1ad12d9f4c3492789c56dece73665e210dafea`
- Verifier: `b1fb4ee407413963ef29a97ad3486c0f43f0d14626d56cb6a28c51d802278a0b`

Receipts are in `.omx/evidence/rain-daily-20260913/`. Private data, models,
calibration states and failures are retained with the existing local encrypted
backup recipient. No remote backup or independent predictive evaluation is claimed.

## Recommended next boundary

Repeated same-source calibration changes are poorly supported by the remaining
failures. Category-2 calibration reaches the minimum scale on every winter and
spring decision date; category-3 does so on 73 of 90 winter dates. This does not
prove the gates impossible, but indicates that another scalar/cadence adjustment
is unlikely to address the underlying ranking and spatial mismatch.

The next step is a separately frozen feasibility and acquisition protocol for
forecast precipitation aligned to the gauge network, including exact location,
run/valid-hour and availability identities. Check provider coverage, quota and
receipt-time limitations before making requests. The current single-point source
and consumed year must not be relabeled as fresh or spatially matched evidence.
