#!/usr/bin/env python3
"""verify genuine WidgetKit Home Screen evidence receipts"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REQUIRED_CASES = {
    ("maximumDensity", "large", "light", "fullColor"),
    ("maximumDensity", "large", "dark", "fullColor"),
    (
        "maximumDensity",
        "accessibility-extra-extra-extra-large",
        "light",
        "fullColor",
    ),
    ("maximumDensity", "large", "light", "accented"),
    ("nearCutoff", "large", "light", "fullColor"),
    ("bedtime", "large", "light", "fullColor"),
}


def fail(message: str) -> None:
    """exit with one evidence blocker"""
    raise SystemExit(f"M0-IOS-HOST-ACCESS: {message}")


def require_file(base: Path, relative: str, expected_hash: str) -> None:
    """require and hash one immutable artifact"""
    path = base / relative
    # reject missing or empty artifacts
    if not path.is_file() or path.stat().st_size == 0:
        fail(f"missing artifact {relative}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    # reject receipt substitution
    if digest != expected_hash:
        fail(f"hash mismatch for {relative}")


def verify_receipt(base: Path, path: Path) -> tuple[str, str, str, str]:
    """validate one host capture receipt"""
    payload = json.loads(path.read_text())
    allowed_methods = {
        "xcode-product-run",
        "xcdebug-widget-scheme-run",
        "xcui-home-screen-conversion",
        "xcui-widget-gallery",
    }
    # reject preview or custom-host evidence
    if payload.get("method") not in allowed_methods:
        fail(f"{path.name} has unsupported method={payload.get('method')!r}")

    required_values = {
        "xcodeVersion": "26.6",
        "simulatorRuntime": "iOS 26.5",
        "widgetFamily": "systemMedium",
    }
    for key, expected in required_values.items():
        # reject preview or unpinned evidence
        if payload.get(key) != expected:
            fail(f"{path.name} has {key}={payload.get(key)!r}, expected {expected!r}")

    for key in (
        "sourceCommit",
        "runnerImage",
        "simulatorName",
        "fixtureScenario",
        "contentSize",
        "appearance",
        "renderingMode",
        "scheme",
    ):
        # require explicit environment identity
        if not payload.get(key):
            fail(f"{path.name} lacks {key}")

    truthy_keys = (
        "providerRan",
        "allIntervalsExactlyOnce",
        "noClippingOrOverlap",
        "allTextFullyVisible",
        "accessibleSemanticsComplete",
        "primaryTapOpenedForecast",
    )
    for key in truthy_keys:
        # reject partial host claims
        if payload.get(key) is not True:
            fail(f"{path.name} does not prove {key}")

    scenario = payload["fixtureScenario"]
    expected_groups = 7 if scenario == "maximumDensity" else 1 if scenario == "nearCutoff" else 0
    expected_intervals = 21 if scenario == "maximumDensity" else 1 if scenario == "nearCutoff" else 0
    # bind density counts to each fixture
    if payload.get("groupCount") != expected_groups or payload.get("intervalCount") != expected_intervals:
        fail(f"{path.name} has incorrect group/interval counts")
    # enforce the chosen widget-only visual type policy
    if payload.get("visualTextPolicy") != "fixed-12pt-widget-only":
        fail(f"{path.name} lacks the fixed widget visual text policy")
    # require the corresponding complete spoken summary
    if payload.get("voiceOverDetailPolicy") != "full-fixture-summary":
        fail(f"{path.name} lacks the complete VoiceOver detail policy")
    # preserve the reviewed 12-point visual presentation
    if (
        float(payload.get("minimumNormalTextPoints", 0)) != 12
        or float(payload.get("maximumVisualTextPoints", 0)) != 12
    ):
        fail(f"{path.name} reports visual text outside 12 points")

    outer_bounds = payload.get("systemMediumOuterBoundsPoints", {})
    raw_content_bounds = payload.get("semanticContentRawBoundsPoints", {})
    content_bounds = payload.get("semanticContentNormalizedBoundsPoints", {})
    coordinate_space = payload.get("semanticContentCoordinateSpace")
    # require a documented semantic coordinate space
    if coordinate_space not in {"screen", "extension-local"}:
        fail(f"{path.name} lacks a supported semantic coordinate space")
    # require measured outer, raw, and normalized geometry
    for name, bounds in (
        ("outer", outer_bounds),
        ("raw content", raw_content_bounds),
        ("normalized content", content_bounds),
    ):
        # reject missing geometry
        if float(bounds.get("width", 0)) <= 0 or float(bounds.get("height", 0)) <= 0:
            fail(f"{path.name} lacks measured {name} bounds")
    tolerance = 1.0
    raw_x = float(raw_content_bounds.get("x", 0))
    raw_y = float(raw_content_bounds.get("y", 0))
    normalized_x = float(content_bounds.get("x", 0))
    normalized_y = float(content_bounds.get("y", 0))
    raw_width = float(raw_content_bounds.get("width", 0))
    raw_height = float(raw_content_bounds.get("height", 0))
    normalized_width = float(content_bounds.get("width", 0))
    normalized_height = float(content_bounds.get("height", 0))
    outer_x = float(outer_bounds.get("x", 0))
    outer_y = float(outer_bounds.get("y", 0))
    # bind extension-local receipts to the evidenced zero origin
    if coordinate_space == "extension-local" and (
        abs(raw_x) > tolerance or abs(raw_y) > tolerance
    ):
        fail(f"{path.name} has nonlocal extension coordinates")
    # bind local normalization to the actual host origin
    if coordinate_space == "extension-local" and (
        abs(normalized_x - outer_x) > tolerance
        or abs(normalized_y - outer_y) > tolerance
    ):
        fail(f"{path.name} did not translate local semantics to the host origin")
    # bind screen receipts to their unmodified coordinates
    if coordinate_space == "screen" and (
        abs(raw_x - normalized_x) > tolerance
        or abs(raw_y - normalized_y) > tolerance
    ):
        fail(f"{path.name} changed screen coordinates during normalization")
    # preserve semantic size during coordinate normalization
    if (
        abs(raw_width - normalized_width) > tolerance
        or abs(raw_height - normalized_height) > tolerance
    ):
        fail(f"{path.name} changed semantic size during normalization")
    # reject semantic content that escaped the fixed host
    if payload.get("semanticContentWithinOuterBounds") is not True:
        fail(f"{path.name} reports semantic content outside the host")
    outer_min_x = float(outer_bounds.get("x", 0)) - tolerance
    outer_min_y = float(outer_bounds.get("y", 0)) - tolerance
    outer_max_x = (
        float(outer_bounds.get("x", 0))
        + float(outer_bounds.get("width", 0))
        + tolerance
    )
    outer_max_y = (
        float(outer_bounds.get("y", 0))
        + float(outer_bounds.get("height", 0))
        + tolerance
    )
    content_min_x = float(content_bounds.get("x", 0))
    content_min_y = float(content_bounds.get("y", 0))
    content_max_x = content_min_x + float(content_bounds.get("width", 0))
    content_max_y = content_min_y + float(content_bounds.get("height", 0))
    # verify the claimed containment from coordinates
    if (
        content_min_x < outer_min_x
        or content_min_y < outer_min_y
        or content_max_x > outer_max_x
        or content_max_y > outer_max_y
    ):
        fail(f"{path.name} geometry proves semantic content escaped the host")

    weather_visible = scenario != "bedtime"
    # require visible credit with weather
    if weather_visible and (
        payload.get("visibleAttribution") is not True
        or payload.get("accessibleProviderLicense") is not True
    ):
        fail(f"{path.name} lacks visible accessible attribution")
    # require exact bedtime copy after cutoff
    if scenario in {"nearCutoff", "bedtime"} and payload.get("bedtimeText") != "go to bed":
        fail(f"{path.name} lacks exact bedtime text")

    for artifact_key, hash_key in (
        ("homeScreenScreenshot", "homeScreenScreenshotSHA256"),
        ("providerLog", "providerLogSHA256"),
        ("tapScreenshot", "tapScreenshotSHA256"),
        ("tapLog", "tapLogSHA256"),
    ):
        require_file(base, payload.get(artifact_key, ""), payload.get(hash_key, ""))

    provider_log = (base / payload["providerLog"]).read_text(errors="replace")
    tap_log = (base / payload["tapLog"]).read_text(errors="replace")
    # bind provider execution to the scenario
    if f"fixture={scenario}" not in provider_log:
        fail(f"{path.name} provider log lacks fixture identity")
    # bind the widget tap to the fixed app route
    if "route=forecast source=deep-link" not in tap_log:
        fail(f"{path.name} tap log lacks forecast route")

    return scenario, payload["contentSize"], payload["appearance"], payload["renderingMode"]


def main() -> None:
    """require the complete M0 host matrix"""
    if len(sys.argv) != 2:
        fail("usage: verify-widget-host-evidence.py <evidence-directory>")
    base = Path(sys.argv[1]).resolve()
    receipts = sorted((base / "receipts").glob("*.json"))
    # reject absent host receipts
    if not receipts:
        fail("no host receipts found")

    covered = {verify_receipt(base, receipt) for receipt in receipts}
    missing = sorted(REQUIRED_CASES - covered)
    # reject incomplete appearance and density coverage
    if missing:
        fail(f"missing host cases: {missing}")
    print(f"WidgetKit Home Screen evidence verified: {len(receipts)} receipts")


# run only as a script
if __name__ == "__main__":
    main()
