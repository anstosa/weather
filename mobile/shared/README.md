# Weather widget shared contract

`widget-forecast-v1.schema.json` is the closed public contract consumed by the
Android and iOS widgets. Canonical JSON fixtures live under `fixtures/`. Each
fixture contains the filtered forecast input (`input.json`), the projected
public bytes (`snapshot.json`), and an independently calculated native semantic
oracle (`expected.json`).

The input is the projector boundary after the edge adapter applies its
persisted admin filter. The historical M1 fixture freeze also exercises the
parser's switch and malformed-settings fail-closed behavior; its recorded hash
does not by itself claim native or deployed route acceptance.

Run `node scripts/widget-fixtures.mjs --check` after compiling `@weather/web`.
Use `--write` only for an intentional reviewed fixture update. The check mode
never rewrites files.

## Projection rules

- `generatedAt` is the only calendar anchor. `receivedAt` is the later edge
  acquisition time and never changes the date, local-day bounds, 20:00 cutoff,
  hourly grid, or sunset.
- The site is exactly `ballydidean` at `47.950429954185445,
  -122.42797012608193` in `America/Los_Angeles`. A local day contains 23, 24, or
  25 real one-hour UTC intervals. Missing expected intervals are explicit
  unavailable values; duplicate, off-grid, off-day, or non-forecast rows reject
  the complete snapshot.
- Every field keeps `raw` and `rawSource` separate from the active correction's
  `selected` and `selectedSource`. A source contains only `runAt` and
  `receivedAt`; `runAt` means the selected source's product run for raw/generic
  values and model initialization for independent corrections. Private model,
  bundle, source, record, station, and decision identifiers are never exposed.
- Raw mode has `selectedSource: null`; native code uses `rawSource`. Adjusted
  mode has both sources. At `selectedUntil` equality the correction is expired,
  and native code changes both the value and provenance to the raw pair. A null
  raw value becomes unavailable at that boundary. Native validators also
  require `selected == raw` in raw mode; JSON Schema cannot express numeric
  equality between sibling fields.
- Independent temperature wins over generic temperature, which wins over raw.
  Independent rain wins over raw. Rain reads the hourly rate first and falls
  back to the hourly amount only when the rate is null; numeric zero is retained.
- Adjustment deadlines are the earliest of `generatedAt + 90 minutes` and the
  independent temperature runtime expiry, generic runtime expiry, or rain
  `decisionAt + 12 hours`. An absent, malformed, or already expired required
  deadline fails raw rather than creating an unbounded correction.
- Source clocks are causal: source `runAt <= receivedAt <= generatedAt <=` edge
  `receivedAt`. Rain `decisionAt <= generatedAt`. Future or reversed clocks
  reject instead of creating negative ages.
- A usable field source age is the oldest applicable clock: the maximum of the
  ages of `runAt` and source `receivedAt`; a null `runAt` leaves only the source
  receipt. It becomes stale strictly after 12 hours, so equality is still fresh.
  Acquisition becomes stale strictly after 90 minutes from the snapshot
  `receivedAt`, also fresh at equality. After correction demotion, source age is
  recomputed from `rawSource`, never the former adjusted source. A future
  applicable clock is conservative clock skew and stale. API `freshness`,
  `validAt`, and device timezone do not participate.
- Numeric weather expires at equality with the earlier of local `dayEnd` and
  snapshot `receivedAt + 24 hours`. Current native consumers store
  failed-attempt metadata separately; a known failed attempt marks cached
  output offline/stale immediately but never replaces last-good weather.
- Hard numeric expiry takes presentation precedence over bedtime: render an
  unavailable/refresh-needed state, set bedtime false, and do not present the
  expired anchored day's sunset. The anchored date stays in diagnostic semantic
  output so native parity failures remain explainable.
- Rain conditions use the wettest hourly selected value before rounding:
  `dry == 0`, `sprinkle > 0 && <= 2.5`, and `rain > 2.5`. Any missing member
  makes that grouped condition unavailable rather than dry.
- Native grouping starts with the interval containing the injected current
  instant and excludes the 20:00 interval. Width is
  `max(1, ceil(remaining / 7))`, capped at three, producing at most seven
  contiguous groups. Any missing temperature member makes its range
  unavailable.
- Temperature display converts before rounding and rounds midpoint ties away
  from zero. Negative zero is normalized to zero. Equal endpoints collapse to
  one displayed value; otherwise `minimum–maximum` is used.
- The projected JSON is at most 128 KiB and uses fixed public attribution:
  `Open-Meteo · CC BY 4.0`.

## Milestone boundary

These fixtures freeze the historical M1 projection and semantic behavior only.
Current native consumers implement cache, persistence, scheduling, and host
rendering, but this contract check does not claim their runtime evidence. The
native probes, exact-commit CI, and independent appearance review establish
those acceptance boundaries separately.
