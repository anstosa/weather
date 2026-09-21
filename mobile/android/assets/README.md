# Android brand asset provenance

The Android launcher icons are exact raster derivatives of the repository-owned
Weather master at `apps/web/public/brand/weather-app-icon-master.png` (1254 ×
1254 RGBA, SHA-256
`4871810f45b233e384852af995dbb510a3c1765acc6410a0035396a847ddb568`).
No Android-specific redraw or alternate brand source is used.

Generate an intentional reviewed update with JDK 17:

```bash
java mobile/android/scripts/GenerateBrandAssets.java --write
```

Verify the checked-in density assets byte-for-byte without changing them:

```bash
java mobile/android/scripts/GenerateBrandAssets.java --check
```

The five outputs are `app/src/main/res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png`.
The source artwork remains governed by the repository's existing project asset
provenance; this derivative step adds no third-party asset or new license.
