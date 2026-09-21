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
- `WeatherUITests` — containing-app deep-link smoke and bounded actual-host matrix

Shared schemes:

- `Weather` — app build, tests, and unsigned Release analysis
- `WeatherWidget-Maximum` — 21 intervals in seven three-hour groups, including repeated fall-back labels
- `WeatherWidgetHostTests` — bounded public-XCUI placement, inspection, and tap

The widget run scheme pins `_XCWidgetFamily=medium` and runs the product-shaped default maximum fixture. The host probe separately creates three clean Debug artifacts using exactly one of `WEATHER_M0_FIXTURE_MAXIMUM`, `WEATHER_M0_FIXTURE_NEAR_CUTOFF`, or `WEATHER_M0_FIXTURE_BEDTIME`. These provider-internal compilation conditions do not change the widget kind, family, view, semantics, or assertions. Each artifact has a source/toolchain/condition receipt plus app and extension binary hashes. Artifact replacement uninstalls the prior app and extension, verifies their absence, then re-places the actual widget through public SpringBoard UI. A Debug-only provider receipt binds the compilation condition to the resolved scenario and group/interval counts. Debug-only WebKit lifecycle receipts distinguish route updates, inline load requests, navigation completion or failure, and content-process termination when the deterministic deep-link document fails. A Debug-only containing-app launch argument requests a public `WidgetCenter` reload; provider logs, not the request itself, prove each refresh. `#if DEBUG` removes all diagnostic and fixture selectors from Release, which retains only the deterministic maximum fixture until M4 replaces fixtures with the public snapshot contract.

The widget launch actions match Apple's checked-in [Building Widgets Using WidgetKit and SwiftUI](https://developer.apple.com/documentation/widgetkit/building-widgets-using-widgetkit-and-swiftui) sample: the scheme is marked as an app-extension scheme, uses the extension PosixSpawn launcher, runs the extension as a mode-2 SpringBoard `RemoteRunnable`, expands build settings from the containing app, and requests automatic widget launch. This is Xcode scheme metadata for Apple's documented Product > Run behavior, not a production SpringBoard API or a runtime security exception.

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
- `debug-build-passed.txt`
- `project-list.json`
- `debug-build.log`
- `Weather.xcresult`
- `test-attachments/`
- `test-attachments-export-status.txt`
- `test.log`
- `release-build-analyze.log`
- `release-validation-passed.txt`
- `DerivedData/Build/Products/Release-iphonesimulator/Weather.app`
- `release-receipts/release-strings.txt`
- `release-receipts/release-plists.txt`
- `release-receipts/release-sha256.txt`

`release-validation-passed.txt` appears only after unsigned Release build, analysis, and artifact isolation all succeed.

These are unsigned build artifacts, not store-submittable binaries.

## Genuine Home Screen gate

Apple documents one supported placement path: select a widget-extension scheme in Xcode and choose **Product > Run**. On iPhone Simulator, Xcode displays the widget on the Home Screen. The checked-in maximum widget scheme preserves that manual path. Apple does not document a `simctl add-widget` command or stable widget-gallery selectors. A SwiftUI preview, a custom host app, coordinate-only gallery automation, or private SpringBoard defaults do not satisfy M0.

The no-cost runner probe avoids GUI Xcode and AppleEvents. It installs the Debug app through `xcodebuild`, then uses public XCUIAutomation and accessible SpringBoard controls to long-press the Weather icon and select its enabled medium-widget conversion. The widget gallery remains a fallback when that direct control is unavailable:

```bash
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
RESULTS="$RUNNER_TEMP/weather-ios/widget-host-probe" \
  bash mobile/ios/scripts/probe-widget-host.sh
```

The probe performs three clean `build-for-testing` builds and then runs six `test-without-building` cases on the same Simulator. Maximum-density light, dark, and AX5 cases reuse one binary; near-cutoff and bedtime use their own binary; the final maximum-tinted case reinstalls and re-places the original maximum binary after bedtime. Every artifact replacement verifies the previous app is absent before the UI test performs a fresh public placement. The final case uses Home Screen **Customize** → **Tinted** rather than a SwiftUI environment override. `WeatherWidgetHostTests` reads the extension's full spoken summary without requesting a hit point, but performs long presses and the primary tap on SpringBoard's real `Weather` / `Widget` host element. It records the exact outer SpringBoard scroll-view frame and normalizes the extension's AX5-local semantic frame only when its raw origin is the evidenced `(0, 0)`; size is never changed, and host containment remains a hard gate. The script separately requires every test to execute without skipping, an exact compiled-selector/provider line for that case, and the route log.

Stable aggregate outputs include `provider-and-route.log`, `widget-host-test.log`, `widget-host-test-executed.txt`, `widget-host-test-skipped.txt`, `host-path.txt`, `matrix-status.tsv`, `after-widget-tap.png`, and `capture-manifest.txt`. Each `variants/<scenario>/` directory contains the compilation condition, build settings, binary hashes, and artifact identity without publishing its excluded DerivedData. Each `cases/<case-id>/` directory contains its own copied artifact identity, reset receipt, `WeatherWidgetHost.xcresult`, exported `attachments/`, exact Simulator-state receipts, provider/tap logs, status files, and `raw-capture.json`. Raw manifests state facts observed by automation and always mark `visualReviewRequired`; they never assert clipping or text-visibility verdicts. `host-path.txt` records `xcui-home-screen-conversion` or the `xcui-widget-gallery` fallback per case without relabeling the evidence. Non-gating `simctl-ui-help.txt` and `xcresulttool-export-attachments-help.txt` record the pinned runner's installed contracts.

If public control discovery, placement, rendering, or tap fails, the probe preserves the test result bundle, stage-specific screenshots and accessibility hierarchies, a final Simulator screenshot, and bounded SpringBoard/WidgetKit logs. It fails honestly when selectors change; it does not disable TCC, change trust settings, automate privacy prompts, or use a private widget-placement command.

The probe exits 78 if launch, placement, system-state readback, provider, XCUI inspection, or tap evidence fails. After all raw captures succeed, it still exits 78 until an independent reviewer records clipping, visibility, accessibility, attribution, and tint verdicts in immutable receipts. Earlier cases remain available when a later selector or visual state fails, so the AX5 density boundary can be reviewed before fixture and tint automation is repaired. A preview never satisfies the gate.

Review each captured case as follows:

1. Confirm `raw-capture.json` identifies the pinned runtime, exact case, public host method, and requested system state.
2. Confirm the screenshot is actual SpringBoard rather than a preview canvas.
3. Inspect every visible label. Do not accept truncation, overlap, missing intervals, inaccessible semantics, or a base font below 12 points.
4. Confirm the measured outer `systemMedium` bounds contain the normalized semantic-content bounds. Keep the raw semantic bounds and their `screen` or `extension-local` coordinate-space identity in the receipt; this geometry check supplements rather than replaces screenshot review.
5. Confirm the exact provider identity and `route=forecast source=deep-link` tap evidence.
6. For the accented case, confirm the Home Screen customization receipts show a genuine **Tinted** selection.
7. Hash the reviewed screenshot/log files and complete one receipt from `Documentation/widget-host-receipt-template.json`.

Required receipt matrix:

| Fixture | Content size | Appearance | Widget rendering |
| --- | --- | --- | --- |
| maximum density | Large | light | full color |
| maximum density | Large | dark | full color |
| maximum density | AX5 (`accessibility-extra-extra-extra-large`) | light | full color |
| maximum density | Large | light | accented/tinted |
| near cutoff | Large | light | full color |
| bedtime | Large | light | full color |

The widget deliberately fixes its visual typography at the independently reviewed 12-point size. This cap applies only inside the fixed `systemMedium` widget; it does not spoof the Simulator setting or alter Dynamic Type in the containing app. The real AX5 case remains in the matrix, every group and visible label remains present, and the widget exposes the complete 21-interval fixture summary to VoiceOver. Independent AX5 screenshot review remains mandatory because passing outer/inner geometry alone cannot prove that every glyph is visible.

Place receipts under `<evidence>/receipts/` and referenced files under the same evidence root. Validate the complete matrix with:

```bash
python3 mobile/ios/scripts/verify-widget-host-evidence.py <evidence-directory>
```

The verifier requires an allowed real-host method, provider execution identity, measured bounds, all intervals exactly once, complete visible text and accessibility assertions, visible licensed attribution whenever weather appears, exact bedtime copy, artifact hashes, and a widget tap opening the fixed forecast route.

## Security boundaries

The containing app:

- keeps canonical HTTPS Weather navigation in its WKWebView;
- sends credential-free default-port external HTTPS links to the system browser;
- rejects lookalike hosts, credentials, nondefault ports, HTTP, file, data, and JavaScript URLs;
- uses WebKit's default persistent website data store and normal TLS handling;
- does not copy cookies or expose a JavaScript/native message bridge.

The widget's primary tap is the fixed `ballydidean-weather://forecast` route. Provider and license links are compile-time constants for Open-Meteo and CC BY 4.0; payload data never controls navigation.

## M4 AppIntent lifecycle blocker

Compiled fixture artifacts prove only M0 rendering feasibility. They are not evidence that WidgetKit decodes or persists the product `temperatureUnit` AppIntent parameter. Before M4 completes, one real `systemMedium` widget must prove default Fahrenheit, public **Edit Widget** Fahrenheit-to-Celsius selection, persistence across extension or process restart, an actual Celsius provider receipt, matching visible and spoken Celsius output, and a return to Fahrenheit. Constructor-only unit tests do not satisfy that boundary.

## Deferred publisher work

Production bundle ownership, signing teams, certificates, profiles, App Store Connect records, privacy declarations, store metadata, beta distribution, and submission are intentionally deferred. Do not add credentials to this repository.
