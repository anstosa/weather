# Mobile build and release preparation

Weather includes native Android and iOS companions for the hosted
<https://weather.ballydidean.farm> site and one native forecast widget per
platform. The widget reads the public, cookie-free
`GET|HEAD /api/v1/sites/ballydidean/widget-forecast` snapshot. The apps retain
the hosted site's existing authentication and storage behavior; native widget
storage never receives browser cookies.

This repository prepares credential-free builds and test artifacts. It does
not contain production signing credentials, submit binaries, create store
records, or claim store approval.

## Supported build matrix

| Target | Reviewed build matrix | Runtime qualification represented here |
| --- | --- | --- |
| Android | AGP 9.4.0, Gradle 9.6.0 checked wrapper, built-in Kotlin 2.2.10, JDK 17, Build Tools 36.0.0, compile SDK 37, target SDK 36, minimum SDK 26 | Managed Android 36 AOSP device plus separate launcher-host evidence; older API 26 runtime behavior is not established by the Android 36 host run |
| iOS | GitHub `macos-26`, Xcode 26.6 at `/Applications/Xcode_26.6.app`, iOS 26.5 Simulator and iPhone 17, deployment minimum iOS 17 | Simulator build and host behavior on iOS 26.5; compilation with minimum 17 does not prove every older supported runtime |

Do not silently replace these versions with whatever a runner currently calls
latest. Update the checked project pins, CI setup, tests, and this matrix in the
same reviewed change.

## Shared contract checks

Install and compile the existing Node workspaces once before running compiled
widget checks:

```bash
npm ci
npm run build
npm run verify:mobile-static
npm run test:mobile-shared:compiled
```

`verify:mobile-static` verifies the checked Gradle wrapper and the authored
Xcode project structure. `test:mobile-shared:compiled` runs the browser-side
projector tests, checks the platform-neutral fixture semantics, and verifies
that committed fixtures are current without regenerating them.

The web unit preference and each widget's Fahrenheit/Celsius selection are
independent. No browser/native bridge or App Group is used to synchronize
them.

## Android

Install the pinned SDK packages outside the repository, including Android 36
and 37 platforms, Build Tools 36.0.0, the emulator, platform tools, and the
Android 36 default x86_64 system image. Then run:

```bash
source mobile/android/scripts/android-env.sh
mobile/android/scripts/verify-wrapper.sh
mobile/android/scripts/toolchain-receipt.sh
java mobile/android/scripts/GenerateBrandAssets.java --check
mobile/android/gradlew -p mobile/android --no-daemon \
  :app:testDebugUnitTest \
  :app:lintDebug \
  :app:assembleDebug \
  :app:lintRelease \
  :app:assembleRelease \
  widgetPhoneDebugAndroidTest
mobile/android/scripts/verify-release-artifact.sh
```

The required Release output is
`mobile/android/app/build/outputs/apk/release/app-release-unsigned.apk`.
`verify-release-artifact.sh` rejects debug fixture controls, local origins,
bridge or TLS-bypass strings, credential-shaped values, cleartext-enabled
manifests, and an unexpected hosted origin. Preserve its SHA-256 receipt.

The managed-device task exercises a real provider through a real
`AppWidgetHost`. It does not replace the separately reviewed normal-launcher
4x1 placement and screenshots. With exactly one ready emulator or device, run
that separate system binding and launcher smoke with:

```bash
mobile/android/scripts/capture-host-evidence.sh
```

Generated Gradle output, managed-device state, debug keystores, and host
screenshots under `mobile/android/host-evidence/` remain ignored build evidence
rather than source inputs.

## iOS

Run the credential-free build, Simulator tests, unsigned Release analysis, and
artifact scan on the pinned macOS runner:

```bash
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
RESULTS="$RUNNER_TEMP/weather-ios-build" \
  mobile/ios/scripts/build-m0.sh
RESULTS="$RUNNER_TEMP/weather-ios-widget-unit" \
  mobile/ios/scripts/probe-widget-unit.sh
RESULTS="$RUNNER_TEMP/weather-ios-semantic-host" \
  mobile/ios/scripts/probe-widget-semantic-host.sh
```

The build gate requires `debug-build-passed.txt`, a zero `test-status.txt`, and
`release-validation-passed.txt` containing
`release_artifact_isolation=passed`. Retain `Weather.xcresult`, test
attachments, Release build/analyze logs, generated property-list inspection,
and `release-receipts/release-sha256.txt`. CI also archives only the produced
`Debug-iphonesimulator/Weather.app` and unsigned
`Release-iphonesimulator/Weather.app` bundles, including their embedded widget
extensions and compiled asset catalogs, under `retained-apps/`. Preserve
`retained-apps/app-bundles.sha256` so a verifier can rehash the exact bounded
archives without retaining the rest of DerivedData.

The product AppIntent probe places a real `systemMedium` widget through public
Simulator UI, changes Fahrenheit to Celsius, restarts the Simulator extension
process, verifies persisted Celsius output, and returns to Fahrenheit. Its
provider log, result bundles, typed and visible/spoken attachments, restart
receipt, and evidence hashes are mandatory.

The semantic host probe compiles each of the six shared production-decoder
fixtures independently and requires real WidgetKit host placement, decoded
provider identity, accessibility and geometry receipts, and the fixed forecast
tap route. Its `semantic-host-passed.txt`, six-line `cases.tsv`, per-case result
bundles and attachments, `evidence.sha256`, and
`visual-review-required.txt` are mandatory CI evidence. The latter marker is a
deliberate reminder that machine assertions do not replace rendered review.

The complete six-case Home Screen capture remains a separate rendered
acceptance gate:

```bash
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
RESULTS="$RUNNER_TEMP/weather-ios-widget-host" \
  mobile/ios/scripts/probe-widget-host.sh
python3 mobile/ios/scripts/verify-widget-host-evidence.py \
  /path/to/independently-reviewed-evidence
```

The raw host probe intentionally exits 78 after a successful capture until an
independent reviewer supplies complete hashed receipts. Do not convert that
exit into success, substitute a SwiftUI preview, or call the AppIntent unit
probe a visual review. The exact-commit host matrix must be captured and
reviewed again when production presentation changes.

## CI selection and evidence

The authoritative `Check` workflow performs change selection once, then runs
the existing Linux quality job and selected native jobs in parallel against
the same `github.sha`. Android-only and iOS-only paths select their respective
lane. Shared fixtures, mobile contracts, web code, workflows, deployment,
configuration, unknown paths, unverified baselines, schedules, and manual runs
select both native lanes conservatively.

The final `Required Check jobs` aggregate runs even after failures. It rejects
a missing or failed change-selection job, any non-success Linux quality job,
and missing, failed, or cancelled selected native jobs. A native job may be
skipped only when its exact classifier output is `false`.

CI artifacts retain toolchain receipts, Debug and unsigned Release builds,
test and host results, screenshots or attachments, Release isolation scans,
and hashes. They must not contain production credentials, private API bodies,
browser cookies, model bundles, training data, or signing material.

`.github/workflows/mobile-preflight.yml` remains a manual diagnostic for the
full iOS visual host matrix. Its deliberate exit-78 boundary is not part of the
automatic build/unit gate and is not a waived release requirement.

## Refresh and cache behavior

Native inline requests have an eight-second total deadline and a 128 KiB
response ceiling. The server response is `no-store`; each platform's bounded,
atomic last-good snapshot is application storage, not an HTTP cache. Attempt
metadata is stored separately so a failure can become visible without
overwriting good weather.

Android WorkManager and iOS WidgetKit request roughly 30-minute refreshes and
known stale, correction-expiry, cutoff, and midnight boundaries. Both
platforms recompute from the current clock whenever the OS invokes them. These
schedulers are inexact: build and deterministic state tests do not promise a
wall-clock execution time. Expired adjustments demote to captured raw values
or unavailable, and hard-expired snapshots never remain live-looking.

## Assets, attribution, and deferred publisher work

Android launcher resources are reproducible 48, 72, 96, 144, and 192 pixel
derivatives of
`apps/web/public/brand/weather-app-icon-master.png`. The source hash and exact
generation command are recorded in `mobile/android/assets/README.md`; CI runs
`java mobile/android/scripts/GenerateBrandAssets.java --check` rather than
silently rewriting them. Native asset catalogs and resources must continue to
reuse that repository-owned brand master rather than introducing a second
brand source. Keep applicable source provenance with any derived assets.

Whenever weather is shown, retain visible and accessible
`Open-Meteo · CC BY 4.0` credit and only the compiled provider and license
destinations. This provider attribution is separate from the repository-owned
application artwork; do not invent a third-party license for that artwork.

The iOS app icon is a deterministic 1024 by 1024 opaque RGB derivative of the
same master on the approved blush background. Its asset catalog and source
provenance live under
`mobile/ios/WeatherApp/Resources/Assets.xcassets/AppIcon.appiconset/`. Run
`mobile/ios/scripts/generate-assets.py --check` to verify exact generated bytes;
`verify-project.py`, native builds, and the Release `Assets.car` scan also
enforce the catalog contract.

Future store delivery still requires user-owned decisions and credentials that
must stay outside Git:

- Apple Developer Program membership, team selection, bundle ownership,
  distribution certificates, provisioning profiles, App Store Connect record,
  privacy declarations, support URL, store metadata, screenshots, review
  notes, beta testing, and submission;
- Google Play developer account, package ownership, upload key or managed app
  signing decision, Play Console record, data-safety declaration, support URL,
  store metadata, screenshots, testing tracks, and submission.

Do not invent account holders, legal names, privacy answers, contact details,
or signing identities. Debug and unsigned Release success is not a
store-submittable binary or store acceptance evidence.

## Web and native release boundary

Native widget code changes require a future signed store binary. Hosted app UI
and the widget forecast endpoint use the Weather web deployment lifecycle.
Before publishing an immutable Weather release, push the branch, require a
successful exact-commit `Check` including every selected native lane, create
the immutable release tag, inspect the produced web image boundary, deploy to
Blueberry, and verify release identity, health,
<https://weather.ballydidean.farm/forecast>, and the public widget endpoint.

Do not sign, upload, submit, or start beta distribution as part of the
credential-free preparation workflow.
