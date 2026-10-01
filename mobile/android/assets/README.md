# Android brand asset provenance

The Android launcher reuses the existing square, fully opaque web artwork at
`apps/web/public/brand/ballydidean-weather-icon-maskable-512.png` (512 × 512 RGBA,
SHA-256 `7e58a1c467e32de2637a350fc3d50a4925b4f4102bc394d94d913c9f81b24ba7`).
This is the repository's existing maskable derivative of
`apps/web/public/brand/weather-app-icon-master.png`, not an Android-specific
redraw or a new brand source. The original master has rounded transparent
corners; Android deliberately packages the opaque square derivative instead.

`mipmap-anydpi-v26/ic_launcher.xml` supplies an adaptive icon on every supported
Android version. A full-bleed blue background matches the artwork's edge color
(`#1079FD`). The square foreground occupies the central 72dp of Android's 108dp
layer; the cloud, island lightning and drops remain inside the 66dp safe zone.
Neither layer has a custom clip, corner radius, or circular mask. Android and
the launcher alone apply the final shape. See the official
[adaptive icon guidance](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).

Generate an intentional reviewed update with JDK 17:

```bash
java mobile/android/scripts/GenerateBrandAssets.java --write
```

Verify the checked-in density assets byte-for-byte without changing them:

```bash
java mobile/android/scripts/GenerateBrandAssets.java --check
```

The generator writes filter-zero RGBA scanlines with stored DEFLATE blocks.
That fixed encoding keeps the reviewed pixels byte-identical across pinned JDK
17 vendors instead of inheriting platform `ImageIO` compression decisions.

The outputs are:

- `app/src/main/res/drawable-nodpi/ic_launcher_artwork.png`, a byte-identical
  copy of the reviewed square source.
- `app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`,
  unmasked 48, 72, 96, 144 and 192 pixel density fallbacks.

Generation rejects a source with any transparent pixels. The device test
`LauncherIconInstrumentationTest` verifies that the package and launcher resolve
an `AdaptiveIconDrawable`, the artwork stays opaque across its entire square,
and the background fills all four corners without a pre-applied shape.

The source artwork remains governed by the repository's existing project asset
provenance; this derivative step adds no third-party asset or new license.
