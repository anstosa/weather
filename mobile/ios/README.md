# Weather iOS M0

This directory contains the credential-free iOS 17 scaffold for the Weather companion and the M0 WidgetKit feasibility spike. The app is a SwiftUI container around a persistent `WKWebView` for `https://weather.ballydidean.farm`. The extension is one configurable `systemMedium` widget using `AppIntentConfiguration`.

M0 deliberately renders deterministic fixtures. Production widget networking, cache persistence, timeline boundary entries, and the shared v1 snapshot decoder remain M4 work after the M0 native-host gate passes. No App Group, background `URLSession`, production signing credential, JavaScript bridge, transport exception, or publisher secret is present.

## Toolchain

The reviewed execution matrix is:

- GitHub-hosted `macos-26` ARM64 runner
- Xcode 26.6 build 17F113 at `/Applications/Xcode_26.6.app`
- iOS 26.5 SDK and iOS 26.5 Simulator
- iOS deployment minimum 17.0

A run on iOS 26.5 proves the project compiles and runs on that runtime. It does not prove runtime behavior on iOS 17.

Official references:

- [Xcode system requirements](https://developer.apple.com/xcode/system-requirements)
- [GitHub macOS 26 ARM64 image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)
- [Creating a widget extension](https://developer.apple.com/documentation/widgetkit/creating-a-widget-extension)
- [Making a configurable widget](https://developer.apple.com/documentation/widgetkit/making-a-configurable-widget)
- [Debugging widgets](https://developer.apple.com/documentation/widgetkit/debugging-widgets)
- [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview)

## Targets and schemes

`Weather.xcodeproj` has these targets:

- `Weather` — hosted SwiftUI/WKWebView companion
- `WeatherWidgetExtension` — fixture-only M0 WidgetKit extension
- `WeatherTests` — navigation, fixture, density, temperature, and intent tests
- `WeatherUITests` — containing-app deep-link smoke

Shared schemes:

- `Weather` — app build, tests, and unsigned Release analysis
- `WeatherWidget-Maximum` — 21 intervals in seven three-hour groups, including repeated fall-back labels
- `WeatherWidget-NearCutoff` — one 7 p.m. group plus `go to bed`
- `WeatherWidget-Bedtime` — all post-cutoff space reads `go to bed`
- `WeatherWidgetHostTests` — bounded public-XCUI inspection/tap after real scheme placement

Every widget scheme pins `_XCWidgetFamily=medium`. Its third fixed environment value selects a compiled debug fixture. `#if DEBUG` removes that selector from Release; the Release widget retains only the deterministic maximum fixture until M4 replaces fixtures with the public snapshot contract.

## Automated build and test

Run the structural check on Linux or macOS:

```bash
python3 mobile/ios/scripts/verify-project.py
```

Run the complete credential-free macOS pass:

```bash
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
RESULTS="$RUNNER_TEMP/weather-ios" bash mobile/ios/scripts/build-m0.sh
```

The script performs:

1. exact Xcode/SDK/runtime/device preflight;
2. generic Simulator Debug app and embedded widget build with signing disabled;
3. unit and UI tests on an iOS 26.5 iPhone 17 Simulator using normal Simulator-local signing;
4. generic Simulator Release build and analyze with signing disabled;
5. produced Release app/extension scans for local origins, ATS/trust bypasses, arbitrary origin controls, JavaScript bridges, fixture selectors, secrets, App Groups, and provisioning material;
6. SHA-256 receipts for produced app and extension files.

Expected output paths beneath `$RESULTS`:

- `toolchain.txt`
- `project-list.json`
- `debug-build.log`
- `Weather.xcresult`
- `test.log`
- `release-build-analyze.log`
- `DerivedData/Build/Products/Release-iphonesimulator/Weather.app`
- `release-receipts/release-strings.txt`
- `release-receipts/release-plists.txt`
- `release-receipts/release-sha256.txt`

These are unsigned build artifacts, not store-submittable binaries.

## Genuine Home Screen gate

Apple documents one supported placement path: select a widget-extension scheme in Xcode and choose **Product > Run**. On iPhone Simulator, Xcode displays the widget on the Home Screen. Apple does not document a stable `simctl add-widget` command or a stable SpringBoard/widget-gallery XCTest contract. A SwiftUI preview, a custom host app, coordinate-only gallery automation, or private SpringBoard defaults do not satisfy M0.

A no-cost runner probe uses Xcode 26.6's installed, documented scheme-mode `xcdebug` contract:

```bash
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
RESULTS="$RUNNER_TEMP/weather-ios/widget-host-probe" \
  bash mobile/ios/scripts/probe-widget-host.sh
```

The probe records `xcdebug --help`, opens the checked-in project, runs `WeatherWidget-Maximum` with `-s`, the pinned Simulator `-d`, full Run `-B`, and fixed `-e` values, waits for the actual provider log, captures SpringBoard, and runs `WeatherWidgetHostTests` to inspect/tap the placed widget through public XCUIAutomation. Stable outputs include `xcdebug-run.log`, `provider-and-route.log`, `springboard-before-tap.png`, `WeatherWidgetHost.xcresult`, `widget-host-test.log`, `after-widget-tap.png`, and `capture-manifest.txt`.

The probe exits 78 if launch, placement, provider, XCUI inspection, or tap evidence fails. Even after a successful maximum-density capture it exits 78 until the screenshot is reviewed for clipping and the full appearance/scenario matrix has immutable receipts. A preview never satisfies that gate.

On an agent-accessible interactive Mac, capture each required case as follows:

1. Boot the pinned iOS 26.5 iPhone 17 Simulator.
2. Start a log capture for subsystems `farm.ballydidean.weather.widget` and `farm.ballydidean.weather`.
3. Open `Weather.xcodeproj`, select the named widget scheme and Simulator, then use Product > Run.
4. Confirm the widget is on SpringBoard rather than in a preview canvas.
5. Capture its measured medium bounds and a full Simulator screenshot.
6. Inspect every visible label. Do not accept truncation, overlap, missing intervals, inaccessible semantics, or text below the normal 12-point floor.
7. Tap the widget and capture the containing app plus `route=forecast source=deep-link` log line.
8. Hash the screenshot/log files and complete one receipt from `Documentation/widget-host-receipt-template.json`.

Required receipt matrix:

| Fixture | Content size | Appearance | Widget rendering |
| --- | --- | --- | --- |
| maximum density | normal | light | full color |
| maximum density | normal | dark | full color |
| maximum density | accessibility | light | full color |
| maximum density | normal | light | accented/tinted |
| near cutoff | normal | light | full color |
| bedtime | normal | light | full color |

The widget uses an uncapped `@ScaledMetric` starting at 12 points. Accessibility text is not forced back to 13 points to make a screenshot pass. If the maximum-density case does not fit at the required larger text size, M0 fails and the plan stops before shared/edge implementation.

Place receipts under `<evidence>/receipts/` and referenced files under the same evidence root. Validate the complete matrix with:

```bash
python3 mobile/ios/scripts/verify-widget-host-evidence.py <evidence-directory>
```

The verifier requires `xcode-product-run`, provider execution identity, measured bounds, all intervals exactly once, complete visible text and accessibility assertions, visible licensed attribution whenever weather appears, exact bedtime copy, artifact hashes, and a widget tap opening the fixed forecast route.

## Security boundaries

The containing app:

- keeps canonical HTTPS Weather navigation in its WKWebView;
- sends credential-free default-port external HTTPS links to the system browser;
- rejects lookalike hosts, credentials, nondefault ports, HTTP, file, data, and JavaScript URLs;
- uses WebKit's default persistent website data store and normal TLS handling;
- does not copy cookies or expose a JavaScript/native message bridge.

The widget's primary tap is the fixed `ballydidean-weather://forecast` route. Provider and license links are compile-time constants for Open-Meteo and CC BY 4.0; payload data never controls navigation.

## Deferred publisher work

Production bundle ownership, signing teams, certificates, profiles, App Store Connect records, privacy declarations, store metadata, beta distribution, and submission are intentionally deferred. Do not add credentials to this repository.
