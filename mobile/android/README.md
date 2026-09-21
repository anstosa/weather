# Android Weather companion and widget

This credential-free Android project contains the production hosted `WebView`
shell and one native Ballydidean forecast `AppWidgetProvider`. The widget
strictly decodes `weather-widget/v1`, renders current cached semantics, and
refreshes through a cookie-free fixed public endpoint. It is not signed for or
submitted to Google Play.

## Pinned toolchain

- Android Gradle Plugin 9.4.0 with built-in Kotlin 2.2.10
- Gradle 9.6.0 through the checked wrapper
- JDK 17
- WorkManager `work-runtime` 2.11.2
- compile SDK 37.0, target SDK 36, minimum SDK 26
- Android Build Tools 36.0.0
- Android 36 AOSP x86_64 managed-device image

Load the repository-local defaults before Gradle commands:

```bash
source mobile/android/scripts/android-env.sh
mobile/android/scripts/verify-wrapper.sh
mobile/android/scripts/toolchain-receipt.sh
```

## Hosted shell boundary

The shell always starts at `https://weather.ballydidean.farm`; the only native
route is the enum-like `/forecast` widget action. Exact-origin HTTPS navigation
stays in the `WebView`. Credentialed, lookalike, non-default-port, cleartext,
file, content, JavaScript and malformed URLs are rejected. Other valid HTTPS
links are delegated to the system browser. Popups are rejected, TLS errors are
cancelled, back follows web history, and the retry view can reload only the
canonical origin.

Default persistent first-party `WebView` cookies retain the hosted login and
settings experience. Third-party cookies, file/content access, mixed content
and JavaScript/native bridges are disabled. Widget HTTP/storage code never
reads the `WebView` cookie store. Debug workers do not make ordinary production
requests.

## Widget data and refresh behavior

The decoder is a closed, depth-bounded pure-Kotlin implementation of the shared
schema. It validates strict UTF-8/JSON, the exact site/calendar/hour grid,
causal source clocks, mode/source pairings, finite field bounds, payload size
and aggregate status before cache replacement. Native grouping, correction
demotion, midpoint rounding, DST labels, missing-data behavior, freshness and
hard expiry are checked against all six shared goldens.

`AtomicFile` stores a bounded last-good snapshot and sanitized attempt metadata
in separate files under serialized access. Failed attempts never replace
weather. Missing/corrupt/impossible attempt metadata is conservative stale;
older callbacks cannot replace newer acquisitions. Successful attempt metadata
binds to the exact cached snapshot SHA-256, so interrupted or conflicting writes
render stale instead of inheriting an unrelated success. Each widget
independently persists Fahrenheit (default) or Celsius.

WorkManager coalesces one immediate network refresh and one network-constrained
30-minute periodic request. Both use the same process fetch lock and a short
attempt coalescing window. A separate unconstrained unique one-time worker
repaints at the earliest hour, correction, source-stale, acquisition-stale,
cutoff or midnight/hard-expiry boundary. Provider update, resize, boot, package,
worker, tap and configuration entrypoints recompute with the current clock.
These requests are best effort; Android does not guarantee exact execution.
All work is cancelled after the final widget is removed.

The fixed endpoint is:

```text
https://weather.ballydidean.farm/api/v1/sites/ballydidean/widget-forecast
```

The client follows no redirects, shares no cookies, requires JSON, reads at
most 128 KiB and applies one cancellable eight-second total deadline across
DNS/connect/headers/body. Errors persist only a bounded outcome category.

## Build and verification

```bash
source mobile/android/scripts/android-env.sh
mobile/android/gradlew -p mobile/android --no-daemon \
  testDebugUnitTest lintDebug assembleDebug lintRelease assembleRelease
mobile/android/scripts/verify-release-artifact.sh
java mobile/android/scripts/GenerateBrandAssets.java --check
```

The Release APK is intentionally unsigned:

```text
mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

The artifact scan rejects debug fixtures/hosts, local origins, bridge or TLS
bypass markers, generated fixture certificate subjects/resources, fixture
runner arguments, credential-shaped values, protected fixture permissions and
cleartext-enabled manifests. It requires the canonical origin and fixed widget
endpoint. Passing proves unsigned Release isolation, not store readiness.

Run the 21-test Android 36 managed-device suite through the loopback-only HTTPS
fixture. The wrapper creates ephemeral certificates, exposes only its public
test CA, and removes every private key after the child exits:

```bash
mobile/scripts/with-native-https-fixture.sh \
  --evidence-dir /tmp/weather-android-https-fixture -- \
  mobile/android/scripts/run-hosted-shell-tests.sh \
  /tmp/weather-android-webview
```

This binds the real provider into a real `AppWidgetHost` at 276×102dp and
554×51dp, exercises the fixture matrix and persistent cache, and drives the
production WebView through real HTTPS login, settings, logout, history, popup,
origin-policy and certificate-negative journeys. Managed-device results are
under
`app/build/outputs/androidTest-results/managedDevice/debug/widgetPhone/` and
`app/build/reports/androidTests/managedDevice/`; the wrapper copies the exact
`TEST-widgetPhone.xml` receipt into the selected WebView evidence directory.

An already-running API 36 emulator can additionally prove WebView state across
real application process stops. This three-phase test logs in through the page,
stops the application externally, verifies the persisted HttpOnly session and
settings, logs out, stops it again, and verifies logout remains cleared:

```bash
mobile/scripts/with-native-https-fixture.sh \
  --evidence-dir /tmp/weather-android-process-https -- \
  mobile/android/scripts/run-hosted-shell-process-tests.sh \
  /tmp/weather-android-process emulator-5554
```

The device serial is explicit; the script never starts, stops or broadly kills
an emulator or the external fixture process.

For an already-running full emulator, the separate smoke exercises the ordinary
launcher placement flow and saves ignored evidence under
`mobile/android/host-evidence/`:

```bash
mobile/android/scripts/capture-host-evidence.sh
```

A custom host does not substitute for the launcher smoke, and neither path is
physical-device/store-signing evidence.

## Layout and attribution

The reviewed blush RemoteViews layout preserves up to 21 fall-back-day
intervals in seven groups of no more than three hours. It supports the tested
276×102dp portrait and 554×51dp landscape allocations at 1.0 and 1.3 font
scales without scrolling or shrinking normal text below 12sp. Missing rain uses
an unavailable icon, never dry. Weather states always show visible and
accessible `Open-Meteo · CC BY 4.0`; provider/license taps use compile-time
allowlisted HTTPS destinations.

Launcher mipmaps are reproducible derivatives of the existing repository
master. Source provenance and exact `--write`/`--check` commands are in
`mobile/android/assets/README.md`.
