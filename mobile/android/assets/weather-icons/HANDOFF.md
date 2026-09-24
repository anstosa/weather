# Weather icons · handoff

Sixteen original weather icons with transparent backgrounds. Each SVG has a
128 × 128 viewBox, inline gradients, an accessible title, and no external assets.
The PNG exports are 512 × 512, 32 × 32, and 15 × 15 pixels. At mdpi, the last
two correspond to 32dp and 15dp. Use the SVGs or export at other display
densities as needed.

| State | Asset |
| --- | --- |
| Sunny | `01-sunny` |
| Sunny + wind | `02-sunny-wind` |
| Partly cloudy | `03-partly-cloudy` |
| Partly cloudy + wind | `04-partly-cloudy-wind` |
| Cloudy | `05-cloudy` |
| Cloudy + wind | `06-cloudy-wind` |
| Light rain | `07-light-rain` |
| Light rain + wind | `08-light-rain-wind` |
| Heavy rain | `09-heavy-rain` |
| Heavy rain + wind | `10-heavy-rain-wind` |
| Bedtime | `11-bedtime` |
| Unavailable | `12-unavailable` |
| Clear night | `13-clear-night` |
| Clear night + wind | `14-clear-night-wind` |
| Partly cloudy night | `15-partly-cloudy-night` |
| Partly cloudy night + wind | `16-partly-cloudy-night-wind` |

Every foreground cloud uses exactly the same cool light-gray gradient. Its
midtones and lower edge have been deepened for contrast on white, blush, and
light blue widget surfaces, with no thick outline. Wind and rain colors have
also been deepened to read cleanly at compact sizes. The only
secondary clouds are behind `05-cloudy` and `06-cloudy-wind`. Daytime partly cloudy has
a faceless sun behind its cloud; its night variants have a faceless crescent.
Clear night has a happy crescent, while clear night with wind has a surprised
crescent. All expressions sit inside the relevant
silhouette. Wind compositions use a separately drawn smaller cloud or sun;
their two wind curls remain open, with a straight line between them. Rain has exactly two or four separate strokes
and falls down-left, or more steeply down-right in windy states. The visible
tear on `09-heavy-rain` is part of its face and is separate from its four rain
strokes.

`preview.png` displays the full set on white, blush, darker blush, and light blue.
`night-preview.png` focuses on the four added night states. Both sheets include
actual 32px and 15px exports in each cell. The smallest size preserves
weather silhouettes and counts; expressions read most clearly at 32dp and up.

Files are organized as `svg/<asset>.svg`, `png/<asset>.png` (512px),
`png/32/<asset>.png`, and `png/15/<asset>.png`.
