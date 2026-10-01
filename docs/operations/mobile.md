# Mobile build and release preparation

Weather includes a native Android companion for the hosted
<https://weather.ballydidean.farm> site and one native forecast widget. Android uses the public, cookie-free
`GET|HEAD /api/v3/sites/ballydidean/widget-forecast` snapshot for its single-row
cloud/wind-aware overnight redesign (see `DESIGN.md` and `mobile/android/README.md`).
The v1 and v2 feeds remain available for compatible clients. The app retains
the hosted site's existing authentication and storage behavior; native widget
storage never receives browser cookies.

Normal builds and Check remain credential-free. The separate opt-in
[Android internal release workflow](android-release.md) can sign and publish to
Play internal testing after its five private Actions secrets and Play account
setup are supplied. The repository contains no production signing credentials,
does not create store records, and does not claim store approval.

## Supported build matrix

| Target | Reviewed build matrix | Runtime qualification represented here |
| --- | --- | --- |
| Android | AGP 9.4.0, Gradle 9.6.0 checked wrapper, built-in Kotlin 2.2.10, JDK 17, Build Tools 36.0.0, compile SDK 37, target SDK 36, minimum SDK 26 | Managed Android 36 AOSP device plus separate launcher-host evidence; older API 26 runtime behavior is not established by the Android 36 host run |

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

`verify:mobile-static` verifies the checked Gradle wrapper.
`test:mobile-shared:compiled` runs the browser-side
projector tests, checks the platform-neutral fixture semantics, and verifies
that committed fixtures are current without regenerating them.

The web unit preference and each widget's Fahrenheit/Celsius selection are
independent. No browser/native bridge is used to synchronize them.

## Android

Install the pinned SDK packages outside the repository, including Android 36
and 37 platforms, Build Tools 36.0.0, the emulator, platform tools, and the
Android 36 default x86_64 system image. The SDK manager identifier for the
API 37 platform is exactly `platforms;android-37.0`; `platforms;android-37`
does not resolve on the selected runner. The Linux emulator also requires the
host `libpulse0` package before even its version receipt can execute. A fresh
Ubuntu setup therefore includes:

```bash
sudo apt-get update
sudo apt-get install --yes libpulse0
sdkmanager --install \
  'platform-tools' \
  'emulator' \
  'platforms;android-36' \
  'platforms;android-37.0' \
  'build-tools;36.0.0' \
  'system-images;android-36;default;x86_64'
```

Then run:

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

## Real HTTPS WebView fixture

Native hosted-shell journeys use the dependency-free shared fixture rather
than production accounts or production traffic. The wrapper creates a private
mode-0700 runtime under the host temporary directory, generates per-run trusted
and untrusted root and leaf certificates, and binds only `127.0.0.1` ports
18443 and 18444. Both leaf certificates cover `127.0.0.1` and the Android
emulator alias `10.0.2.2`. Fixed-port conflicts fail closed rather than moving
the test to a different origin.

Run the fixture contract test independently with:

```bash
python3 mobile/scripts/native_https_fixture_test.py
```

The native journey wrappers consume the same bounded environment:

```bash
RESULTS="$RUNNER_TEMP/weather-android" \
  mobile/scripts/with-native-https-fixture.sh \
  --evidence-dir "$RUNNER_TEMP/weather-android/https-fixture" \
  -- mobile/android/scripts/run-hosted-shell-tests.sh \
  "$RUNNER_TEMP/weather-android/android-webview"

```

The wrapper exports the trusted public CA, platform-specific origins, and fake
fixture credentials only to its child. Android packages the CA only into the
generated Debug test resource. Android never trusts the negative CA or disables ordinary TLS
validation. Release scans must reject fixture origins, public test roots,
fixture arguments, credentials, arbitrary trust configuration, and transport
exceptions.

The deterministic DOM exposes `Fixture home`, forecast, map, logs, trends,
settings, sign-in, administration, and policy pages. Stable visible labels
cover the sign-in fields, settings controls, logout, same-origin history,
target-blank navigation, unsafe and lookalike links, and the untrusted TLS
destination. The fixture never follows an external link itself, and native
policy tests intercept or cancel those destinations without ordinary offsite
traffic.

Successful retained fixture evidence contains only the trusted public CA,
public certificate fingerprints, sanitized request-status booleans and counts,
and a cleanup receipt. It never retains a private key, the untrusted CA, a
session token, raw cookie, or fake password. The production Docker context also
excludes native Gradle output and local native host evidence; those files remain bounded CI artifacts rather than web image
inputs.

## CI selection and evidence

The authoritative `Check` workflow performs change selection once, then runs
the existing Linux quality job and selected native jobs in parallel against
the same `github.sha`. Android paths select the native lane. Shared fixtures,
mobile contracts, web code, workflows, deployment, configuration, unknown paths,
unverified baselines, schedules, and manual runs select Android conservatively.

The final `Required Check jobs` aggregate runs even after failures. It rejects
a missing or failed change-selection job, any non-success Linux quality job,
and missing, failed, or cancelled selected native jobs. A native job may be
skipped only when its exact classifier output is `false`.

CI artifacts retain toolchain receipts, Debug and unsigned Release builds,
test and host results, screenshots or attachments, Release isolation scans,
and hashes. They must not contain production credentials, private API bodies,
browser cookies, model bundles, training data, or signing material.

## Refresh and cache behavior

Native inline requests have an eight-second total deadline and a 128 KiB
response ceiling. The server response is `no-store`; Android's bounded,
atomic last-good snapshot is application storage, not an HTTP cache. Attempt
metadata is stored separately so a failure can become visible without
overwriting good weather.

Android WorkManager requests roughly 30-minute refreshes and known stale,
correction-expiry, cutoff, and midnight boundaries. Android v3 retains the
overnight summary through its 7am horizon and recomputes from the current clock
whenever the OS invokes it. These
schedulers are inexact: build and deterministic state tests do not promise a
wall-clock execution time. Expired adjustments demote to captured raw values
or unavailable, and hard-expired snapshots never remain live-looking.

## Assets, attribution, and deferred publisher work

Android uses a system-masked adaptive launcher icon backed by the existing
opaque square `apps/web/public/brand/ballydidean-weather-icon-maskable-512.png`.
It packages that artwork unchanged and generates unmasked 48, 72, 96, 144 and
192 pixel density fallbacks. No custom rounded or circular crop is applied.
The source hash and exact
generation command are recorded in `mobile/android/assets/README.md`; CI runs
`java mobile/android/scripts/GenerateBrandAssets.java --check` rather than
silently rewriting them. Native asset catalogs and resources must continue to
reuse that repository-owned brand artwork rather than introducing a second
brand source. Keep applicable source provenance with any derived assets.

Whenever weather is shown, retain visible and accessible
`Open-Meteo · CC BY 4.0` credit and only the compiled provider and license
destinations. This provider attribution is separate from the repository-owned
application artwork; do not invent a third-party license for that artwork.

Future store delivery still requires user-owned decisions and credentials that
must stay outside Git:

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
credential-free preparation workflow. Android internal publication is a separate
explicitly authorized operation through the Android release workflow, with an
explicit version and a successful exact-commit Check.
