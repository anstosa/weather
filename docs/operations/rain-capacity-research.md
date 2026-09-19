# Rain adjustment: nested chronological tree-count selection

## Frozen next hypothesis

The fixed 183-day training-decay experiment improved average error but still
failed eleven of the unchanged 49 gates. This experiment tests a distinct
capacity-selection mechanism while preserving that training weighting and the
entire hurdle calibration algorithm. It does not search the development results
for a half-life, event cutoff, amount factor or model-depth combination.

Keep the existing outer fit/calibration/evaluation chronology and 95 features.
Within each outer fit window:

1. Reserve its final 120 valid-date days for inner validation. End inner training
   seven days before that slice starts. No outer calibration or evaluation label
   reaches model-size selection.
2. Train each supported inner head for all 320 rounds using the same parameters
   and 183-day decayed training weights. Score every round on only its inner
   validation population, with uniform equal-date/hour/vintage weights.
3. Use native XGBoost 3.4.1 `logloss` for the three binary heads and native
   `gamma-deviance` for the wet-only gamma head. Gamma validation weights are
   rebalanced within its observed-wet population.
4. Select the earliest round attaining the exact minimum of that complete
   native metric history. If inner training fails its existing head support, or
   validation has fewer than ten positive hours over five dates for a binary
   head / twenty wet hours over five dates for gamma, retain 160 rounds.
5. Refit each final head on **all original outer-fit rows** at its selected
   round count. Apply the unchanged earlier-only hurdle calibration afterward.

The pinned [Python API](https://xgboost.readthedocs.io/en/stable/python/python_api.html)
records per-round metrics through `evals_result`; no implicit early stopping is
used. The pinned native [gamma metric implementation](https://github.com/dmlc/xgboost/blob/6fe8c547bdd21c73e4555d85b087d9260595d30d/src/metric/elementwise_metric.cu#L256-L277)
uses its documented float32/epsilon form of gamma deviance. Selection follows
these native scores exactly, rather than asserting an identical float64 formula
or using six-decimal-rounded custom metric output. Native weighted-metric smoke
tests precede the experiment freeze.

Every inner booster, complete score history, support count, boundary, selected
round and final booster is retained. A missing outer head retains the established
raw fallback. All previous forecast controls remain unchanged: eleven recency
arms, the earlier hurdle (`hurdleOriginal`) and the 160-round decayed model
(`decayOriginal`). Only `hurdleCapacity` is selectable.

## Unchanged decision boundary

All 49 development checks and all 32,896 evaluation rows remain fixed. New
report metadata distinguishes variable final rounds from the 320-round selection
ceiling; each head's `selectedRound` is authoritative. Inherited data/source
freezes are lineage envelopes, while `capacity-freeze.json` identifies this new
experiment. Report aliases preserve older candidates as separate controls.

September 2025–August 2026 is consumed development data. Inner chronological
selection prevents direct outer-label leakage but does not restore independence
to this repeatedly examined development year. Even a full development pass needs
separate fresh-data qualification and real receipt-time evidence before promotion.
No production changes or new acquisition are part of this experiment.

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-fit-recency-20260913-v1"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-capacity-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-fit-recency-20260913/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_capacity.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_capacity.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/test_rain_capacity.py
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Run bounded CPU jobs with one numerical thread. Private artifacts stay outside
Git. The live forecast remains unchanged: <https://weather.ballydidean.farm/forecast>.

## Verified development result

**Not selected: 36/49 gates pass; 13 fail.** Independent reconstruction reproduced
all 32,896 predictions, all 49 gate decisions, 44 inner selection fits and 48
outer refits. All native booster hashes, retained score histories, earliest
minima and twelve monthly states matched. This validates implementation, not
independent predictive performance.

| Model | Overall MAE (mm/h) | Wet MAE | Heavy MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Nested capacity | 0.104751 | 0.766300 | 1.460780 | 1.192066 |
| Fixed 160-round decay | 0.103020 | 0.770801 | 1.443968 | 1.180256 |
| Original hurdle | 0.103547 | 0.760097 | 1.422416 | 1.189117 |
| Unchanged ordinal | 0.104229 | 0.778934 | 1.464274 | 1.135528 |
| Recent raw-volume control | 0.102662 | 0.783990 | 1.594287 | 1.024530 |

The new model worsens overall MAE and loses retained heavy-event skill. Detection
at 1 mm/h falls to 0.429875 versus the unchanged ordinal's 0.477100. Seasonal
volume remains high in winter (1.394562) and autumn (1.256395); spring and summer
ratios are 0.962680 and 0.915375. The 2.5 mm/h inner head falls back to 160 rounds
in November–February because its inner validation support is insufficient.

Failed checks: `beatsVolumeScale`, `event0.1Safety`, `seasonDJFVolume`,
`seasonDJFDetection`, `seasonJJAWetHeavy`, `seasonJJADetection`,
`seasonMAMDetection`, `seasonSONVolume`, `beatsSameWindowVolumeScale`,
`beatsRecentVolumeScale`, `beatsUnchangedOrdinal`, `seasonalBalanceImproves`,
`heavySkillRetained`.

The fixed evaluator reports **FAIL with no proof errors**. All **332 rain tests**
pass, including sixteen new producer/helper/verifier tests. Targeted Ruff, AST
parsing and diff checks pass; all nine earlier experiment freezes and retained
review files remain unchanged. Application sources are unchanged, so the earlier
same-turn full workspace check remains applicable. No application service,
production model or acquisition configuration was modified.

### Result identities

- Freeze: `a5dcedfccf5b1b34a910d6e3a5d7ec52d319e6ddf51dd9ca9cf1ecb9b99cfec8`
- Report: `acdf7698e7a5682cdb4d749d9a5320ace6e90eb729ea039e7317c258c52fd4d0`
- Predictions: `95487bff75bf829cbd5b7a06b9f974699de23d6ad19842d3d7290f01675b470b`
- Verifier: `e3dd5a93974667fd15a6b9f351fdebda5f26182b76cc3c7ad610ff8c627c61c6`

Detailed receipts are in `.omx/evidence/rain-capacity-20260913/`; the private
artifacts are retained through the existing local encrypted backup recipient.
No independent holdout or remote backup is claimed.
