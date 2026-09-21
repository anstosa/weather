#!/usr/bin/env python3
"""validate the checked-in iOS project without requiring Xcode"""

from __future__ import annotations

import plistlib
import re
import shlex
import sys
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "Weather.xcodeproj" / "project.pbxproj"
SCHEMES = ROOT / "Weather.xcodeproj" / "xcshareddata" / "xcschemes"

EXPECTED_FILES = (
    "Configurations/Shared.xcconfig",
    "Configurations/Debug.xcconfig",
    "Configurations/Release.xcconfig",
    "WeatherApp/App/WeatherApp.swift",
    "WeatherApp/Web/SecureWeatherWebView.swift",
    "WeatherApp/Web/WeatherNavigationPolicy.swift",
    "WeatherApp/Resources/Info.plist",
    "WeatherWidget/WeatherWidget.swift",
    "WeatherWidget/WeatherWidgetIntent.swift",
    "WeatherWidget/WeatherWidgetModel.swift",
    "WeatherWidget/WeatherWidgetFixtures.swift",
    "WeatherWidget/WeatherWidgetView.swift",
    "WeatherWidget/Info.plist",
    "WeatherTests/WeatherTests.swift",
    "WeatherUITests/WeatherDeepLinkUITests.swift",
    "scripts/build-m0.sh",
    "scripts/probe-widget-host.sh",
)
EXPECTED_SCHEMES = (
    "Weather.xcscheme",
    "WeatherWidget-Maximum.xcscheme",
    "WeatherWidgetHostTests.xcscheme",
)
BANNED_SOURCE_PATTERNS = (
    r"localhost",
    r"127\.0\.0\.1",
    r"0\.0\.0\.0",
    r"WKScriptMessageHandler",
    r"addScriptMessageHandler",
    r"serverTrust",
    r"SecTrust",
    r"NSAllowsArbitraryLoads",
    r"NSExceptionDomains",
)


def fail(message: str) -> None:
    """exit with one actionable error"""
    raise SystemExit(f"ios project verification failed: {message}")


def verify_files() -> None:
    """require every authored input"""
    for relative in EXPECTED_FILES:
        # reject incomplete project trees
        if not (ROOT / relative).is_file():
            fail(f"missing {relative}")


def verify_plists() -> None:
    """parse production property lists"""
    for relative in ("WeatherApp/Resources/Info.plist", "WeatherWidget/Info.plist"):
        # parse every checked plist
        with (ROOT / relative).open("rb") as handle:
            payload = plistlib.load(handle)
        # reject transport weakening
        if "NSAppTransportSecurity" in payload:
            fail(f"unexpected ATS exceptions in {relative}")
        # reject unsupported shared storage
        if "com.apple.security.application-groups" in str(payload):
            fail(f"unexpected App Group in {relative}")


def verify_schemes() -> None:
    """parse all shared schemes and the real extension host"""
    for filename in EXPECTED_SCHEMES:
        path = SCHEMES / filename
        # reject missing shared schemes
        if not path.is_file():
            fail(f"missing shared scheme {filename}")
        ElementTree.parse(path)

    for obsolete in ("WeatherWidget-NearCutoff.xcscheme", "WeatherWidget-Bedtime.xcscheme"):
        # reject obsolete runtime fixture schemes
        if (SCHEMES / obsolete).exists():
            fail(f"obsolete runtime fixture scheme remains: {obsolete}")

    for filename in ("WeatherWidget-Maximum.xcscheme",):
        path = SCHEMES / filename
        text = path.read_text()
        root = ElementTree.parse(path).getroot()
        launch = root.find("LaunchAction")
        remote = launch.find("RemoteRunnable") if launch is not None else None
        macro = launch.find("MacroExpansion/BuildableReference") if launch is not None else None

        # preserve only the product-shaped default medium run
        if 'value="medium"' not in text or "WEATHER_WIDGET_FIXTURE" in text:
            fail(f"scheme {filename} lacks the default medium-only contract")
        # require app-extension metadata
        if root.get("wasCreatedForAppExtension") != "YES" or root.get("version") != "2.0":
            fail(f"scheme {filename} is not marked as an app-extension scheme")
        # require the extension launcher
        if launch is None or launch.get("selectedLauncherIdentifier") != "Xcode.IDEFoundation.Launcher.PosixSpawn":
            fail(f"scheme {filename} lacks the extension launcher")
        # require automatic placement
        if launch.get("launchAutomaticallySubstyle") != "2":
            fail(f"scheme {filename} lacks automatic widget launch")
        # require the SpringBoard host
        if (
            remote is None
            or remote.get("runnableDebuggingMode") != "2"
            or remote.get("BundleIdentifier") != "com.apple.springboard"
        ):
            fail(f"scheme {filename} lacks the SpringBoard remote runnable")
        # require containing-app expansion
        if macro is None or macro.get("BuildableName") != "Weather.app":
            fail(f"scheme {filename} lacks containing-app macro expansion")
        # reject direct extension launches
        if launch.find("BuildableProductRunnable") is not None:
            fail(f"scheme {filename} tries to run the extension directly")

    host_root = ElementTree.parse(SCHEMES / "WeatherWidgetHostTests.xcscheme").getroot()
    host_test = host_root.find("TestAction")
    host_launch = host_root.find("LaunchAction")
    host_environment = (
        host_launch.find("EnvironmentVariables/EnvironmentVariable")
        if host_launch is not None
        else None
    )
    # require supported launch-environment inheritance
    if host_test is None or host_test.get("shouldUseLaunchSchemeArgsEnv") != "YES":
        fail("host test scheme does not inherit its launch environment")
    # require the explicit host-test gate
    if (
        host_environment is None
        or host_environment.get("key") != "WEATHER_RUN_WIDGET_HOST_TEST"
        or host_environment.get("value") != "1"
        or host_environment.get("isEnabled") != "YES"
    ):
        fail("host test scheme lacks the enabled launch gate")


def verify_project_graph() -> None:
    """check referenced object identifiers and target settings"""
    text = PROJECT.read_text()
    definitions = set(
        re.findall(r"^\s*([A-F0-9]{24})(?:\s+/\*.*?\*/)?\s*=\s*\{", text, re.MULTILINE)
    )
    references = set(re.findall(r"\b[A-F0-9]{24}\b", text))
    missing = sorted(references - definitions)
    # reject dangling project references
    if missing:
        fail(f"dangling PBX identifiers: {', '.join(missing)}")

    required_fragments = (
        "IPHONEOS_DEPLOYMENT_TARGET = 17.0",
        "farm.ballydidean.weather.widget",
        "com.apple.product-type.app-extension",
        "Embed App Extensions",
        "WeatherWidgetExtension.appex",
    )
    combined = text + (ROOT / "Configurations/Shared.xcconfig").read_text()
    for fragment in required_fragments:
        # require the approved project contract
        if fragment not in combined:
            fail(f"project lacks {fragment}")


def verify_release_reachable_sources() -> None:
    """reject source-level release boundary violations"""
    source_paths = list((ROOT / "WeatherApp").rglob("*.swift"))
    source_paths.extend((ROOT / "WeatherWidget").rglob("*.swift"))
    for path in source_paths:
        text = path.read_text()
        for pattern in BANNED_SOURCE_PATTERNS:
            # reject forbidden release mechanisms
            if re.search(pattern, text, re.IGNORECASE):
                fail(f"{path.relative_to(ROOT)} contains banned pattern {pattern}")

    fixture_source = (ROOT / "WeatherWidget/WeatherWidgetFixtures.swift").read_text()
    intent_source = (ROOT / "WeatherWidget/WeatherWidgetIntent.swift").read_text()
    widget_source = (ROOT / "WeatherWidget/WeatherWidget.swift").read_text()
    app_source = (ROOT / "WeatherApp/App/WeatherApp.swift").read_text()
    web_view_source = (ROOT / "WeatherApp/Web/SecureWeatherWebView.swift").read_text()
    model_source = (ROOT / "WeatherWidget/WeatherWidgetModel.swift").read_text()
    view_source = (ROOT / "WeatherWidget/WeatherWidgetView.swift").read_text()
    test_source = (ROOT / "WeatherTests/WeatherTests.swift").read_text()
    release_scan = (ROOT / "scripts/verify-release-artifacts.sh").read_text()
    obsolete_fixture_controls = (
        "WEATHER_WIDGET_FIXTURE",
        "WeatherWidgetFixtureSelection",
        "fixtureScenario",
        'Parameter(title: "M0 fixture"',
        "m0-fixture-resolution",
    )
    obsolete_surface = fixture_source + intent_source + widget_source
    # remove the disproven runtime and AppIntent fixture controls
    for fragment in obsolete_fixture_controls:
        # reject hidden fallback selectors
        if fragment in obsolete_surface:
            fail(f"obsolete fixture control remains: {fragment}")
    if "import AppIntents" in model_source:
        fail("fixture model still imports AppIntents")
    # preserve wrapper-owned decoding defaults
    if "init() {}" not in intent_source:
        fail("widget configuration intent does not use the empty system initializer")
    # preserve only the product temperature parameter
    if intent_source.count("@Parameter(") != 1 or 'title: "Temperature unit"' not in intent_source:
        fail("widget intent does not retain the product-only temperature parameter")
    diagnostic_marker = "m0-compiled-fixture"
    diagnostic_index = widget_source.find(diagnostic_marker)
    diagnostic_guard_index = widget_source.rfind("#if DEBUG", 0, diagnostic_index)
    diagnostic_end_index = widget_source.find("#else", diagnostic_index)
    diagnostic_fragments = (
        "WEATHER_M0_FIXTURE_MAXIMUM",
        "WEATHER_M0_FIXTURE_NEAR_CUTOFF",
        "WEATHER_M0_FIXTURE_BEDTIME",
        "WEATHER_M0_FIXTURE_DEBUG_DEFAULT",
        "selection.selector",
        "resolved=\\(fixture.scenario.rawValue",
        "groups=\\(fixture.groups.count",
        "intervals=\\(fixture.intervalCount",
    )
    # keep compiled fixture diagnostics out of Release artifacts
    if (
        diagnostic_index < 0
        or diagnostic_guard_index < 0
        or diagnostic_end_index < diagnostic_index
        or diagnostic_marker not in release_scan
    ):
        fail("compiled fixture receipt is not Release-isolated")
    # preserve selector, scenario, and density boundaries
    for fragment in diagnostic_fragments:
        # reject incomplete compiled fixture evidence
        if fragment not in widget_source:
            fail(f"compiled fixture receipt lacks {fragment}")
    for fragment in (
        diagnostic_marker,
        "WEATHER_M0_FIXTURE_MAXIMUM",
        "WEATHER_M0_FIXTURE_NEAR_CUTOFF",
        "WEATHER_M0_FIXTURE_BEDTIME",
        "WEATHER_M0_FIXTURE_DEBUG_DEFAULT",
    ):
        # require produced Release scans to reject fixture-selector bytes
        if fragment not in release_scan:
            fail(f"Release scan lacks compiled fixture ban {fragment}")
    # preserve exhaustive fixture identity tests
    if (
        "testEveryFixtureScenarioResolvesItsIdentity" not in test_source
        or "for scenario in WeatherWidgetScenario.allCases" not in test_source
    ):
        fail("fixture identity tests are incomplete")
    web_diagnostic_marker = "m0-webview-lifecycle"
    web_diagnostic_fragments = (
        "inline-load-request",
        "did-finish",
        "did-fail",
        "provisional-fail",
        "content-process-terminated",
    )
    # keep WebKit lifecycle diagnostics out of Release artifacts
    if (
        web_diagnostic_marker not in app_source
        or web_diagnostic_marker not in web_view_source
        or web_diagnostic_marker not in release_scan
    ):
        fail("debug WebKit lifecycle receipt is not Release-isolated")
    # preserve each documented WebKit lifecycle boundary
    for fragment in web_diagnostic_fragments:
        # reject incomplete blank-document evidence
        if fragment not in web_view_source:
            fail(f"debug WebKit lifecycle receipt lacks {fragment}")
    # keep the matrix reload request out of Release compilation
    if (
        "#if DEBUG" not in app_source
        or 'contains("-weather-m0-reload-widget")' not in app_source
        or "WidgetCenter.shared.reloadTimelines" not in app_source
    ):
        fail("debug widget reload request is not compilation-gated")
    # enforce the selected widget-only visual type policy
    if "static let widgetVisualFontSize: Double = 12" not in model_source:
        fail("widget visual type is not fixed at the reviewed 12-point size")
    # reject renewed visual Dynamic Type expansion
    if "@ScaledMetric" in view_source:
        fail("widget visual type unexpectedly uses uncapped scaling")
    # preserve the fixed type policy at every widget label
    if "WeatherWidgetFixture.widgetVisualFontSize" not in view_source:
        fail("widget view does not use the fixed visual type policy")
    # preserve complete spoken detail outside the visual cap
    if "entry.fixture.accessibilitySummary" not in view_source:
        fail("widget view lacks the complete VoiceOver summary")
    # preserve focused policy regressions
    for test_name in (
        "testWidgetVisualTypeUsesReviewedTwelvePoints",
        "testVoiceOverSummaryRetainsEveryForecastGroup",
    ):
        # reject removal of either policy test
        if test_name not in test_source:
            fail(f"widget policy tests lack {test_name}")


def verify_host_probe() -> None:
    """keep the automated host path public and fail-closed"""
    probe = (ROOT / "scripts/probe-widget-host.sh").read_text()
    ui_test = (ROOT / "WeatherUITests/WeatherDeepLinkUITests.swift").read_text()

    required_fragments = (
        "WeatherWidgetHostTests",
        "build-for-testing",
        "test-without-building",
        'DERIVED_DATA_ROOT="$RESULTS/DerivedData"',
        "build_variant",
        'build_variant "maximumDensity"',
        'build_variant "nearCutoff"',
        'build_variant "bedtime"',
        "artifact-identity.json",
        "binaries.sha256",
        '"compiledFixtureSelector"',
        '"variantAppBinarySHA256"',
        '"variantWidgetBinarySHA256"',
        '"freshArtifactPlacement"',
        "simctl uninstall",
        "simctl get_app_container",
        "artifact-reset-status.txt",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $selector",
        "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG $compiled_selector",
        "xcresulttool export attachments",
        "provider-ready.txt",
        "widget-host-test-executed.txt",
        "widget-host-test-skipped.txt",
        "visualReviewRequired",
        '"visualTextPolicy": "fixed-12pt-widget-only"',
        '"visualTextPoints": 12',
        '"voiceOverDetailPolicy": "full-fixture-summary"',
        '"semanticContentContainmentRequired": True',
        "xcui-home-screen-conversion",
        "xcui-widget-gallery",
        "accessibility-extra-extra-extra-large",
        'XCUIApplication(bundleIdentifier: "com.apple.springboard")',
        'value ==[c] %@',
        '"Widget"',
        "springboard.scrollViews",
        "firstExisting",
        "hostWidget.tap()",
        "com.apple.springboardhome.application-shortcut-item.rearrange-icons",
        "Medium-sized widget",
        'labeled: ["Edit"]',
        '" Add Widget"',
        "springboard.cells.matching",
        'typeText("Weather")',
        "failure-stale-widget-before-placement",
        "widget existed before fresh artifact placement",
        "addWidget(on: host.springboard, scenario: .nearCutoff)",
        "addWidget(on: host.springboard, scenario: .bedtime)",
        'labeled: ["Customize"]',
        'labeled: ["Tinted"]',
        "selectedTint.isSelected",
        "system-medium-outer-frame-points",
        "semantic-content-raw-frame-points",
        "semantic-content-coordinate-space",
        "semantic-content-normalized-frame-points",
        "semantic content escaped the actual systemMedium host bounds",
        "test01MaximumLightLarge",
        "test02MaximumDarkLarge",
        "test03MaximumLightAX5",
        "test04NearCutoffLightLarge",
        "test05BedtimeLightLarge",
        "test06MaximumTintedLarge",
    )
    combined = probe + ui_test
    for fragment in required_fragments:
        # require the real public host path
        if fragment not in combined:
            fail(f"host probe lacks {fragment}")

    collapsed_probe = probe.replace("\\\n", " ")
    case_calls = [
        shlex.split(match.group(1))
        for match in re.finditer(r"^run_case\s+(.+)$", collapsed_probe, re.MULTILINE)
    ]
    expected_case_variants = {
        "01-maximum-light-large": ("maximumDensity", "$MAXIMUM_SELECTOR", "1"),
        "02-maximum-dark-large": ("maximumDensity", "$MAXIMUM_SELECTOR", "0"),
        "03-maximum-light-ax5": ("maximumDensity", "$MAXIMUM_SELECTOR", "0"),
        "04-near-cutoff-light-large": ("nearCutoff", "$NEAR_CUTOFF_SELECTOR", "1"),
        "05-bedtime-light-large": ("bedtime", "$BEDTIME_SELECTOR", "1"),
        "06-maximum-tinted-large": ("maximumDensity", "$MAXIMUM_SELECTOR", "1"),
    }
    # bind every case to its compiled artifact and reset generation
    if len(case_calls) != len(expected_case_variants):
        fail("host probe does not define exactly six matrix cases")
    for arguments in case_calls:
        # reject malformed case invocations
        if len(arguments) != 10 or arguments[0] not in expected_case_variants:
            fail(f"host probe has malformed case invocation: {arguments}")
        expected_scenario, expected_selector, expected_fresh = expected_case_variants[arguments[0]]
        if (arguments[2], arguments[8], arguments[9]) != (
            expected_scenario,
            expected_selector,
            expected_fresh,
        ):
            fail(f"host probe has incorrect artifact binding for {arguments[0]}")

    semantic_interactions = ("widget.isHittable", "widget.tap()", "widget.press(")
    for fragment in semantic_interactions:
        # keep extension semantics inspection-only
        if fragment in ui_test:
            fail(f"host test directly interacts with extension semantics via {fragment}")

    forbidden_fragments = (
        "xcdebug",
        "tccutil",
        "osascript",
        "CGEvent",
        "simctl add-widget",
        "fixtureValueButtons",
        "configureWidget(",
        "WEATHER_WIDGET_FIXTURE",
    )
    for fragment in forbidden_fragments:
        # reject consent bypasses and private placement
        if fragment in combined:
            fail(f"host probe contains forbidden mechanism {fragment}")

    visual_claims = (
        '"allIntervalsExactlyOnce": True',
        '"noClippingOrOverlap": True',
        '"allTextFullyVisible": True',
        '"accessibleSemanticsComplete": True',
    )
    for fragment in visual_claims:
        # leave screenshot verdicts to independent review
        if fragment in probe:
            fail(f"host probe auto-asserts visual claim {fragment}")


def verify_build_evidence() -> None:
    """preserve compile and failed-test receipts"""
    build = (ROOT / "scripts/build-m0.sh").read_text()
    required_fragments = (
        "debug-build-passed.txt",
        "release-validation-passed.txt",
        "release_artifact_isolation=passed",
        "test-attachments",
        "xcresulttool export attachments",
        "test-app-lifecycle.log",
        "test-app-lifecycle-status.txt",
        "test-app-lifecycle-start-status.txt",
        "test-app-lifecycle-process-status.txt",
        "log stream",
        "-parallel-testing-enabled NO",
        'subsystem == "farm.ballydidean.weather"',
        'if [[ "$TEST_STATUS" -ne 0 ]]',
    )
    for fragment in required_fragments:
        # require durable stage evidence
        if fragment not in build:
            fail(f"build script lacks {fragment}")
    stream_index = build.find("log stream")
    parallel_disabled_index = build.find("-parallel-testing-enabled NO")
    test_index = build.find('test | tee "$RESULTS/test.log"')
    # start lifecycle capture before the test can stop the Simulator
    if test_index < 0 or stream_index > test_index:
        fail("build script starts lifecycle capture after Simulator tests")
    # keep regular tests on the selected streamed destination
    if parallel_disabled_index < 0 or parallel_disabled_index > test_index:
        fail("build script permits cloned Simulator test destinations")


def main() -> None:
    """run deterministic structural checks"""
    verify_files()
    verify_plists()
    verify_schemes()
    verify_project_graph()
    verify_release_reachable_sources()
    verify_host_probe()
    verify_build_evidence()
    print("iOS project structure verified")


# run only as a script
if __name__ == "__main__":
    main()
