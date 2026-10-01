# Approved weather icon artwork

Source: Ansel's supplied `weather-icons-handoff (3).zip`. These fixed-cloud-geometry
assets supersede the prior handoff. Preserve the supplied appearance rather than
reinterpreting its gradients, faces, spacing or wind geometry.

- `svg/`: unchanged SVG masters for future approved edits
- `HANDOFF.md`: original package notes and state mapping
- `preview.png`: original multi-background preview
- `night-preview.png`: original preview focused on the four night states
- `manifest.json`: archive and per-asset SHA-256 hashes plus Android resource mapping
- `../../app/src/main/res/drawable-nodpi/`: unchanged 512px PNG exports used by the widget
- `../../app/src/androidTest/assets/widget-icons-reference/`: original PNG test references

The PNGs remain native Android image resources. Density-neutral packaging and
the `fitCenter` ImageViews retain the exact artwork while filling the largest
square available between the time and temperature, without fixed size caps.
All ten cloud-bearing icons share the supplied foreground cloud path, size and
position; wind and celestial details are arranged around that fixed cloud.
Tighter text insets and slightly smaller temperatures prioritize the icons
without adding an SVG library, effects or changing the single-row layout. The
bedtime artwork remains as a reference asset even though weather rendering no
longer selects it. The SVG masters and reference previews are outside the
production app payload.

`WidgetIconInstrumentationTest` compares decoded packaged pixels with the
original exports and renders all sixteen resources at the widget's normal and
compact sizes. The Android host tests cover the actual RemoteViews layout.
Updating the artwork intentionally requires updating the source manifest and
test references together after reviewing the new handoff.
