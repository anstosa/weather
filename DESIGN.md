# Design

## Source of truth

Active · 2026-09-23 · Android home-screen widget redesign requested by Ansel.
Evidence: current `WeatherWidgetProvider`, `WidgetSemantics`, native host tests,
and the user-supplied `weather-icons-handoff (1).zip`. Its approved SVG masters,
preview and import manifest are retained in `mobile/android/assets/weather-icons/`.
The supplied artwork supersedes the earlier agent-drawn icon iterations.
This supersedes the old
Android two-row/range/footer design. The iOS preparation milestone remains paused.

## Brand

Quiet, warm, compact weather information. Blush panels, ink-colored text, clear
weather illustrations. Icons use polished, smooth gradient silhouettes rather
than hand-drawn outlines. Avoid nested cards, translucent boxes, dense metadata,
dashboard styling, crayon-like strokes, and cartoon perimeter outlines.

## Product goals

One glance communicates conditions from now until 8pm without scrolling or
wrapping. Every remaining forecast hour is represented. No additional widget
types, notifications, or app redesign.

## Personas and jobs

Ansel checks the farm's upcoming temperature, sky, precipitation, and wind from
the Android launcher. The widget opens the existing forecast when tapped.

## Information architecture

One horizontal row: current hour, consecutive forecast blocks, optional overnight.
Time top-left; weather graphic centered between label and temperature; one bold
temperature bottom-left. No footer. Forecast areas after sunset are darker blush,
starting at the sunset's exact proportional position inside a forecast block.

## Design principles

- full-height, edge-to-edge segments; only vertical rules separate segments
- now and forecast segments each occupy at most one fifth of the width
- show as many hourly segments as fit; increase future block duration by one
  hour until all remaining hours fit, keeping the current hour separate
- append overnight at 4pm when fewer than four future forecast segments remain
- overnight consumes all remaining width; from 8pm until 7am it consumes the entire widget
- never turn missing cloud, rain, or wind data into invented fair weather

## Visual language

White now `#FFFFFF`, light blush `#F8DEE5`, post-sunset blush `#EAB8C8`, overnight
blue `#DAEAF5`, ink `#432E3B`, divider `#CCA6B3`. Now always stays white and
overnight always stays blue. No sunset line.
Only the outer silhouette is rounded, with an 8dp radius. No panel margins or
horizontal dividers. Use bundled Google Sans Regular and Bold (approved instead
of Product Sans), approximately 13dp time and bold 24dp temperature, with
10dp labels and 16dp temperatures at the existing 51dp compact minimum height. Centered illustrations
from the approved handoff cover sunny, partly cloudy, cloudy, light/heavy rain,
high-wind variants, overnight and unavailable states. Use the supplied transparent
512px PNG exports unchanged in native ImageViews, with SVG masters retained for
future edits. Preserve their smooth silhouettes, rounded rain strokes, gradients
and integrated expressions rather than redrawing or recoloring them.
Wind variants use smaller or shorter
weather silhouettes, never non-uniform scaling. Light rain has two rain
strokes; heavy rain has four. Normal rain slopes down-left; wind-driven rain
slopes down-right at a steeper angle away from vertical, clear of the wind lines.
Rain-and-wind curls have visibly open tips, with a gap from the straight stream
even at compact sizes. Wind compositions include two open curls with a straight
line between them. Every foreground cloud uses the supplied light-gray gradient;
only fully cloudy icons add a darker second cloud behind it. Exact geometry,
colors, highlights and gradient stops belong to the handoff assets, not a
separate implementation palette.

Faces are integrated eyes, brows and mouths, not emoji glyphs or overlays.
In the four-column icon gallery's row-major order, use these expressions:
sunny—happy smiling eyes; sunny with wind—surprised; partly cloudy—gentle smile;
partly cloudy with wind—closed eyes and a slight frown; cloudy—neutral;
cloudy with wind—closed eyes and a slight frown; light rain—neutral;
light rain with wind—closed eyes and a slight frown; heavy rain—sad and crying;
heavy rain with wind—angry. The closed-eye frowns have no eyebrows or squiggles.
Partly cloudy icons show only a cloud face, with a faceless sun tucked behind
the cloud. The darker rear cloud in fully cloudy icons has no face. Moon and
unavailable artwork share the new smooth gradient style. Preserve recognizable weather at 32dp
and the existing compact 15dp size. No motion.

## Components

One native RemoteViews row with weather panels and a remaining-width overnight panel.
The flat background includes proportional evening shading behind the content.
Target minimum weather-panel width is
64dp; fit six slots at 384dp and retain at least five slots at the existing
276dp widget minimum.
Weather panels have equal widths, capped at 20%; overnight takes the remainder.
Icons fill the largest square inside the available text gap and panel width,
without fixed normal or compact size caps. Preserve aspect ratio, full artwork,
vertical centering, text sizes and the five-panel width rule.
Use 2dp vertical text-edge insets normally and zero in compact rows to give
height-constrained illustrations more room without reducing typography.
Time labels are `Now`, `1pm`, or `Overnight` for the night summary. The single temperature uses
the block high when mean temperature is above 65°F, the low below 50°F, and the
mean otherwise, rounded only after selection and unit conversion.

Temperature text follows the existing forecast's non-green bands: below 55°F
uses blue `#2D63A3`, 55–70°F inclusive retains ink `#432E3B`, above 70–80°F
inclusive uses orange `#AC500E`, and above 80°F uses red `#B52F26`. These are
darker shades of the web forecast hues to remain readable on both blush surfaces.
Choose the color from the same unrounded selected temperature before unit
conversion; switching Fahrenheit/Celsius must not change its band. Unavailable
temperatures remain normal ink. Labels, icons and backgrounds are unchanged.

## Accessibility

Preserve complete hour ranges, units, provenance, freshness, sunset, and provider
attribution in TalkBack descriptions. Limit visual text expansion to preserve
all hours without clipping. The forecast page retains visible data attribution.
Colors are supplemented by labels and icons. The entire widget remains a tap
target for the forecast.

## Responsive behavior

All sizes remain a single row. Capacity is `max(5, floor(width / 64dp))`.
Now is one hour; future blocks begin at the next hour and end no later than 8pm.
Shorten trailing blocks as needed to use every available forecast panel; do not
insert overnight just because uniform grouping leaves a spare panel. Forecast
panels entirely after sunset are fully darker blush; panels straddling sunset
are split proportionally. Missing sunset leaves forecasts light blush.

## Interaction states

Render cached data immediately; refresh through the existing bounded worker.
Missing or expired data shows an honest unavailable state, not synthetic icons
or temperatures. Freshness remains accessible without a visual footer.

## Content voice

Short and direct: `Now`, lowercase `am`/`pm`, `Overnight`. No slogans or labels
competing with the weather.

## Implementation constraints

Kotlin, XML RemoteViews and native image resources; no new dependencies. A versioned
v3 public endpoint adds the overnight horizon without changing v1/v2 APIs or the paused iOS
client. Before 7am, the calendar anchors the preceding evening; its complete hourly
grid ends at next-day 7am, respecting DST. The overnight tile shows the minimum
selected temperature and summarizes weather across exactly 8pm–7am. Clear and
partly cloudy nighttime conditions use the four supplied moon variants. Prefer adjusted values while preserving correction deadlines and raw
fallback. Cloud uses mean coverage (<25% sunny, <75% partly cloudy, else cloudy).
Rain uses maximum selected rate (0 dry, >0 and <2.5mm/h light, otherwise heavy).
High wind uses maximum selected speed >=20mph. These are presentation defaults,
not new model-training rules.
The sixteen approved PNGs live in `drawable-nodpi` under the existing resource
names; ImageView `fitCenter` scales them without density-driven asset substitution.
Keep them untinted. Native tests compare packaged pixels with the original
handoff exports and inspect 32dp/15dp renders. Preserve SVG masters outside the
app payload and record source hashes in the handoff manifest.

Bundle the official Google Sans v14.000 Android static TTFs with their OFL and
trademark notices. The root uses `@android:id/background` and outline clipping
to preserve its 8dp radius on AOSP/Pixel Launcher. Third-party launchers may
still enforce their own corner radius.

## Open questions

None blocking. Validate at minimum, typical, wide, and large-font native host
sizes, then inspect the actual Windows emulator. Backend changes must pass CI,
deploy through the documented Blueberry release process, and pass live smoke.
