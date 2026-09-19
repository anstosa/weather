# Rain adjustment: causal trajectory alignment experiment

## Development-only boundary

This experiment follows the frozen ordinal/weighted search without changing
its sources, models or outcomes. It tests a different mechanism: forecast timing
alignment rather than another learned amount head. All September 2025 through
August 2026 outcomes remain consumed **development data**, not a fresh holdout.

The original retained ECMWF profiles have 48 forecast hours per initialization.
At the simulated initialization-plus-eight-hour decision, the one-hour gauge
delay permits observations through initialization plus seven hours. Only the
four median gauge hours at initialization plus four through seven enter the
shift decision. Complete source/observation support is required; a recent-dry
window deliberately keeps the original forecast.

## Frozen candidates

For shifts −3 through +3 hours, compare those four observed medians with the
corresponding shifted forecast hours. Minimize mean absolute difference, breaking
ties by smallest absolute shift and then signed shift. Change timing only when
the earlier-window error improves by at least 20% **and** 0.02 mm/h. Otherwise
use zero shift. Apply the selected shift to the available future forecast, never
to future observations. Missing or cold shifted forecast temperatures (≤2°C)
fall back to the original paired rain forecast on that row before the optional
volume-calibration step.
Zero-shift decisions retain exact paired raw values; shifted source amounts use
the same float32 measurement precision, promoted to float64 for calculation.

Two prespecified candidates are retained:

- **Timing only:** the shifted forecast amount, with the stated fallbacks.
- **Timing plus volume:** the same forecast with an earlier-only 90-day volume
  scalar, bounds [0.1, 3], final physical clipping and explicit saturation
  reporting, matching the preceding search's solver and chronology.

This is a timing **and forecast-window volume** intervention. Shifting a finite
window can import or export rain; it is not described as volume-preserving.
The untouched raw, zero, persistence, original 45-day scaling and stronger
90-day scaling controls remain visible. A support-matched 90-day scaling
control also uses the identical complete-history mask and exact-raw fallback,
so improvements from missing-history handling cannot be attributed to timing.

## Support, provenance and selection

Complete four-hour observation and required forecast support counts as a
supported decision even when a dry or no-improvement guard intentionally keeps
raw. Missing history does not count as support. No target observations after
the decision cutoff are used to choose shifts or scalars. All evaluation rows
remain in the score regardless of fallback.

The normalized source profile is copied to a new private root and checked
against the original acquisition manifest SHA-256:
`f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1`.
Unshifted source values must match the existing paired forecast identity. The
policy, input identities and exact implementation bytes are frozen before new
candidate outcomes are computed. Per-run shifts, reasons, support and phase
fallbacks are retained alongside monthly calibration states and predictions.

Each candidate must pass all 44 residual-experiment gates unchanged and beat
the same-window volume baseline. A 46th, mechanism-specific gate requires
effective, phase-surviving trajectory changes on at least 20 distinct target
dates and MAE strictly below both 90-day volume controls by more than 1e-12 mm/h.
This prevents scalar-only or no-op forecasts being selected as evidence for
timing adjustment. Only complete passers can
be selected; MAE then name breaks ties. A null selection retains all failures
instead of promoting the least-bad candidate.

The retrospective source has simulated conservative availability delays, not
verified historical issuance/receipt timestamps. Even a successful development
result cannot establish production qualification. A separate prospective
protocol and genuinely new observations are required.

## Runtime and isolation

The experiment uses existing NumPy/XGBoost research-runtime dependencies; no
new dependency, service, production setting, database write or model deployment
is needed. Private source profiles and row-level predictions stay outside Git.
The independent verifier reconstructs source joins, causal shifts, phase
fallbacks, scalars, scores and selection without calling producer calculations.

## Completed development result

Both candidates were rejected. The same 32,896 forecast rows and 366 target
dates were retained; 31,741 rows had complete alignment support. The method
selected a nonzero shift on 110 evaluation runs, with actual amount changes on
102 runs: 1,125 rows, 904 distinct hours and 105 dates. Three shifted-source
phase fallbacks occurred. Thus the rejection was not a lack of timing coverage.

| Candidate/control | MAE (mm/h) | Heavy-hour MAE (mm/h) | Volume ratio | Failed gates |
| --- | ---: | ---: | ---: | ---: |
| Raw | 0.126445 | 1.472778 | 1.541668 | — |
| 90-day volume scaling | 0.103198 | 1.602447 | 1.025845 | — |
| Support-matched volume scaling | 0.103926 | 1.614019 | 1.024785 | — |
| Timing only | 0.128965 | 1.474969 | 1.561485 | 21/46 |
| Timing plus volume | 0.105558 | 1.619753 | 1.033479 | 16/46 |

Timing alone worsened overall MAE by 1.99% and failed all three accumulation
checks. Adding volume calibration improved on raw but remained 1.57% worse
than the support-matched, unshifted volume control. Both failed event safety
and the timing-contribution gate; **neither candidate was selected**.

Independent replay verified all 3,301 source profiles, 3,287 paired run audits,
12 monthly states, every forecast/support/effective-change flag, all scores and
46 gates per candidate. The complete rain test suite passed 195 tests, including
eight producer and nine verifier timing tests; targeted Ruff and AST checks
and full `npm run check` also passed. This verifies implementation, not
independent predictive skill.

Private evidence identity:

- Freeze SHA-256: `6f6a55ea3bd75842e1e2f8bbd0676e3c30250908be3b9593a185f8d247511dc8`
- Report SHA-256: `fe0f6ed5ce62aa4a6cd18584739b2f48ec1f83b9ea11a03fa930251654d01c54`
- Prediction SHA-256: `4deb408228d0d9ad0fc8015f0ba670d2406b46645cc56e5f7d37dc0b97b47146`
- Shift audit SHA-256: `f3621019857bd809f1321ea56bdf3bf414535c9b1ead785437d4197f3e5c371e`

Together with the [ordinal and weighted search](rain-search-research.md), these
are five additional tested candidates, all rejected without weakening existing
performance requirements or changing the live rain forecast.
The full timing evidence is retained locally with encrypted round-trip
verification. No remote archive copy, model promotion or deployment is performed.

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-timing-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_timing.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_timing.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/verify_rain_timing.py "$ROOT" /path/to/new-verification.json
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

The preparation/run commands reject an existing experiment rather than
overwriting its evidence. Existing roots can be independently verified again
using a new receipt path.

The public forecast remains <https://weather.ballydidean.farm/forecast>.
