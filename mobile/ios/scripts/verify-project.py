#!/usr/bin/env python3
"""validate the checked-in iOS project without requiring Xcode"""

from __future__ import annotations

import plistlib
import re
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
    "WeatherWidget-NearCutoff.xcscheme",
    "WeatherWidget-Bedtime.xcscheme",
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
    """parse all shared schemes and fixed scenarios"""
    for filename in EXPECTED_SCHEMES:
        path = SCHEMES / filename
        # reject missing shared schemes
        if not path.is_file():
            fail(f"missing shared scheme {filename}")
        ElementTree.parse(path)

    expected_scenarios = {
        "WeatherWidget-Maximum.xcscheme": "maximumDensity",
        "WeatherWidget-NearCutoff.xcscheme": "nearCutoff",
        "WeatherWidget-Bedtime.xcscheme": "bedtime",
    }
    for filename, scenario in expected_scenarios.items():
        path = SCHEMES / filename
        text = path.read_text()
        root = ElementTree.parse(path).getroot()
        launch = root.find("LaunchAction")
        remote = launch.find("RemoteRunnable") if launch is not None else None
        macro = launch.find("MacroExpansion/BuildableReference") if launch is not None else None

        # bind each run scheme to one fixed fixture
        if f'value="{scenario}"' not in text or 'value="medium"' not in text:
            fail(f"scheme {filename} lacks fixed medium/{scenario} settings")
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
    # keep scenario overrides out of Release compilation
    if "#if DEBUG" not in fixture_source or "WEATHER_WIDGET_FIXTURE" not in fixture_source:
        fail("debug fixture selector is not compilation-gated")


def verify_host_probe() -> None:
    """keep the automated host path public and fail-closed"""
    probe = (ROOT / "scripts/probe-widget-host.sh").read_text()
    ui_test = (ROOT / "WeatherUITests/WeatherDeepLinkUITests.swift").read_text()

    required_fragments = (
        "WeatherWidgetHostTests",
        "xcresulttool export attachments",
        "provider-ready.txt",
        "widget-host-test-executed.txt",
        "widget-host-test-skipped.txt",
        "public-xcui-widget-gallery",
        'XCUIApplication(bundleIdentifier: "com.apple.springboard")',
        'labeled: ["Edit"]',
        'labeled: ["Add Widget"]',
        'typeText("Weather")',
    )
    combined = probe + ui_test
    for fragment in required_fragments:
        # require the real public host path
        if fragment not in combined:
            fail(f"host probe lacks {fragment}")

    forbidden_fragments = (
        "xcdebug",
        "tccutil",
        "osascript",
        "CGEvent",
        "simctl add-widget",
    )
    for fragment in forbidden_fragments:
        # reject consent bypasses and private placement
        if fragment in probe:
            fail(f"host probe contains forbidden mechanism {fragment}")


def verify_build_evidence() -> None:
    """preserve compile and failed-test receipts"""
    build = (ROOT / "scripts/build-m0.sh").read_text()
    required_fragments = (
        "debug-build-passed.txt",
        "test-attachments",
        "xcresulttool export attachments",
        'if [[ "$TEST_STATUS" -ne 0 ]]',
    )
    for fragment in required_fragments:
        # require durable stage evidence
        if fragment not in build:
            fail(f"build script lacks {fragment}")


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
