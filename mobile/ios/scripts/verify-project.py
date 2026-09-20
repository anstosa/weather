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
        text = (SCHEMES / filename).read_text()
        # bind each run scheme to one fixed fixture
        if f'value="{scenario}"' not in text or 'value="medium"' not in text:
            fail(f"scheme {filename} lacks fixed medium/{scenario} settings")


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


def main() -> None:
    """run deterministic structural checks"""
    verify_files()
    verify_plists()
    verify_schemes()
    verify_project_graph()
    verify_release_reachable_sources()
    print("iOS project structure verified")


# run only as a script
if __name__ == "__main__":
    main()
