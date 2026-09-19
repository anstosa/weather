# Rain adjustment: bounded wind-source transport recovery

## Reason for a separate plan

The original zero-retry direction acquisition is **closed and failed** after
114 requests: 113 valid responses and one 30-second read timeout. It did not
produce a complete normalized source. Its independent partial audit and all
385 retained files are encrypted locally. Never restart or rewrite that plan.

This separate recovery changes transport resilience, not the model, input
population or precipitation-parity requirements. Reuse the 113 independently
verified successful responses without fetching them again. Acquire only the
remaining 3,188 original initializations, including the previously timed-out
2024-05-07 00 UTC run. No observation labels or model outcomes inform this set.

Parent identities:

- Retention manifest:
  `0500e8f49649b683844bca057f2275a30888a77d813cea6abce5108b96164ab5`
- Retention receipt:
  `fef8fb51275ecf47cf3c3ba916cebda9f7051b1a1c9238f69d0f356e6940e434`
- Independent partial proof:
  `684f5ede704e569487e48fc567785ae11ba3e327a165d9837afc3ed4c006ebab`
- Failed bulk report:
  `e909b6fae12d0ca233f004f946b68087ddd9a6c0d0c73cb90b1c8ca5995fe8d3`

## Frozen recovery bounds

Preserve the same original point, public Single Runs endpoint, two variables,
49-hour UTC response schema, default land selection, original source hashes and
exact 3,301-run population. Snapshot the parent under `inputs/parent-root/`,
including successful and failed request records, source freezes, original
forecasts, independent proof and retention manifest. Freeze new source code,
independent verifier, exact inherited/missing run sets and plan before requests.

Use a **90-second socket timeout** and up to **three new attempts per missing
run**. Only transport failures or HTTP 502/503/504 may retry, after five seconds
then fifteen seconds. Retain every start, bounded body when available, error and
receipt. Do not retry HTTP 429, other non-retryable status codes, changed grid or
precipitation, malformed schema or source-provenance failure. Stop the batch if
its retry allowance is exhausted or a non-retryable failure occurs.

Across this recovery plan, cap new HTTP requests and location units at **9,564**
(3,188 × 3). Keep one-second minimum start spacing, 2 MB response capture, no
redirects or endpoint rotation, and the **2026-09-14 08 UTC** expiry. Earlier
requests remain counted separately: 114 direction attempts and eighteen
location units from the two spatial probes. The conservative combined known
maximum is 9,696 location units, below the published 10,000/day allowance;
shared-IP usage by other clients remains unknown. Stop on 429 rather than
assuming unused quota. [Provider limits](https://open-meteo.com/en/pricing).

The three-attempt limit applies to this new plan; the previously timed-out run
also retains its earlier failed attempt. Report lifetime attempts separately
from unique successful initializations. A successful source contains exactly
3,301 unique runs, not necessarily 3,301 HTTP attempts.

## Complete-source acceptance

Independently re-audit the 113 inherited successes, the earlier timeout and
every new attempt. Verify exact original rain values and model grid, request
and receipt timestamps, variable units, all source-hour identities, bounded
retry/backoff behavior and byte hashes. Normalization may use only one proven
successful response for each original initialization.

Keep the original normalized field schema and write 158,448 rows in original
chronological 48-lead blocks. Retain a separate `response-lineage.jsonl` mapping
each original run to its inherited or new successful response. Never replace
missing direction with zero, discard evaluation rows, erase failed attempts or
call a partial source complete.

The complete source must independently verify and be encrypted before the
preregistered 107-feature `hurdleWind` experiment can run. The consumed
development year, unknown historical issue times, unchanged 49 gates and
separate fresh-data qualification requirement remain unchanged. This is not a
production deployment; the [live forecast](https://weather.ballydidean.farm/forecast)
is unchanged.
