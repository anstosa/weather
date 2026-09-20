# Android Weather M0

This project is the credential-free Android scaffold and layout feasibility spike. It contains a Kotlin `WebView` shell, a platform `AppWidgetProvider`/`RemoteViews` widget, deterministic widget fixtures, and a debug-only real `AppWidgetHost`. It does **not** fetch the future widget projection yet and is not signed for Google Play.

## Pinned toolchain

- Android Gradle Plugin 9.4.0 with its built-in Kotlin 2.2.10 support
- Gradle 9.6.0 through the checked wrapper
- JDK 17
- compile SDK 37.0, target SDK 36, minimum SDK 26
- Android Build Tools 36.0.0
- full Android 36 AOSP system image for the `widgetPhone` managed device

AGP 9.4 requires Gradle 9.6.0, JDK 17, Build Tools 36.0.0, and built-in Kotlin 2.2.10. The project deliberately does not apply `org.jetbrains.kotlin.android` separately. Android 37 is a minor-version SDK, so the build uses the current `compileSdk { version = release(37) { minorApiLevel = 0 } }` DSL.

Primary references:

- <https://developer.android.com/build/releases/agp-9-4-0-release-notes>
- <https://developer.android.com/build/migrate-to-built-in-kotlin>
- <https://developer.android.com/reference/tools/gradle-api/9.4/com/android/build/api/dsl/CompileSdkSpec>
- <https://developer.android.com/develop/ui/views/appwidgets/layouts>
- <https://developer.android.com/develop/ui/views/appwidgets/host>

## Build and static verification

Set `JAVA_HOME` and `ANDROID_HOME`, or source the local defaults:

```bash
source mobile/android/scripts/android-env.sh
mobile/android/scripts/verify-wrapper.sh
mobile/android/scripts/toolchain-receipt.sh
mobile/android/gradlew -p mobile/android --no-daemon \
  :app:testDebugUnitTest :app:lintRelease :app:assembleDebug :app:assembleRelease
mobile/android/scripts/verify-release-artifact.sh
```

The release APK is intentionally unsigned:

```text
mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

The release scan rejects debug host/control classes, local fixture origins, common bridge/TLS-bypass strings, credential-shaped values, and cleartext-enabled manifests. It also requires the canonical `https://weather.ballydidean.farm` origin. An unsigned APK proves compilation and Release isolation only; it is not store-submittable.

## Widget density proof

The provider supports the official typical Android 4x1 minimum examples at both the default 1.0 and large 1.3 font scales:

- portrait: 276x102 dp using a static two-row presentation
- landscape: 554x51 dp using one row at 1.0 and a responsive two-row presentation at 1.3

The maximum fixture contains 21 real fall-back-day intervals grouped exactly once into seven groups of at most three hours. It includes repeated-hour labels, adjusted temperature ranges, dry/sprinkle/rain icons, sunset, status, and visible `Open-Meteo · CC BY 4.0` credit. Near-cutoff and all-bedtime fixtures preserve the exact `go to bed` copy without scrolling.

Run the managed device instrumentation target:

```bash
source mobile/android/scripts/android-env.sh
mobile/android/gradlew -p mobile/android --no-daemon widgetPhoneDebugAndroidTest
```

For an already-running full Android emulator/device, the evidence script exercises the real provider in a real `AppWidgetHost`, checks normal and 1.3 font scales, switches light/dark resources, saves screenshots, and separately requests placement through the ordinary launcher:

```bash
mobile/android/scripts/capture-host-evidence.sh
```

Generated screenshots live under the ignored `mobile/android/host-evidence/` directory. A custom host does not substitute for the normal-launcher screenshot. Android `RemoteViews` has day/night resources but no WidgetKit-style tinted rendering mode; launcher-specific dynamic color substitution must not be reported as a portable Android guarantee.

The fixture tests fail rather than reducing the 12sp normal-size floor, omitting intervals, grouping more than three hours, scrolling, or silently increasing the requested widget family. The glyph-boundary regression proves that the large-text oracle still rejects a genuinely clipped descender after replacing conservative line-box measurements. The debug host and pin activity are excluded from Release.

### M0 feasibility verdict

The maximum-density layout is feasible at both tested scales. The real `AppWidgetHost` suite passes all fixture variants at the exact 276x102dp portrait and 554x51dp landscape measurements. At 1.3, portrait moves the protected sunset/status/unit and credit into spare second-row width, while landscape uses four complete groups on its first row and three groups plus wide inline metadata on its second row. The all-bedtime landscape keeps a full-width `go to bed` area beside the sunset/cutoff status.

This responsive repair preserves all 21 real intervals, seven groups of no more than three hours, full temperature ranges, all three icons, sunset, status, unit, and exact visible credit. It does not cap font scale, reduce text below 12sp, scroll, omit fields, remove host padding, or substitute a larger widget family. A separate placement at 1.3 proves that the platform provider renders through the ordinary launcher as a real 4x1 home-screen widget rather than only in a preview or custom view.

M0 remains a deterministic feasibility scaffold only. Network projection, persistence, refresh policy, signing, and store submission belong to later milestones.
