#!/usr/bin/env python3
"""Verify one public WidgetInfo observation against one native provider phase."""

import argparse
import datetime
import json
import re
import struct
import zlib
from pathlib import Path

KIND = "farm.ballydidean.weather.forecast"
SUMMARY = re.compile(
    r"widget-config epoch=([1-9][0-9]*) observedAtMs=([1-9][0-9]*) "
    r"status=complete total=([1-9][0-9]*) matchCount=([1-9][0-9]*) "
    r"kind=" + re.escape(KIND) + r" family=systemMedium entries=([^ ]+)"
)
ENTRY = re.compile(
    r"widget-config-entry epoch=([1-9][0-9]*) index=([0-9]+) kind="
    + re.escape(KIND) + r" family=systemMedium unit=(fahrenheit|celsius)"
)
STAMP = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+) ")
TARGET = re.compile(r"page=([1-9][0-9]*/[1-9][0-9]*) frame=(-?[0-9]+(?:\.[0-9]+)?),(-?[0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?),([0-9]+(?:\.[0-9]+)?)")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


# reject duplicate or missing exact attachment names
def attachment(items, base, suffix):
    pattern = re.compile(re.escape(base) + r"_\d+_[0-9A-Fa-f-]{36}\." + suffix)
    found = [item for item in items if pattern.fullmatch(item.get("suggestedHumanReadableName", ""))]
    # reject duplicate or absent stage evidence
    if len(found) != 1:
        raise ValueError(f"expected exactly one {base} attachment")
    return found[0]


# accept only one safe bounded exported attachment
def exported_text(item, directory):
    name = item.get("exportedFileName", "")
    path = (directory / name).resolve()
    # reject paths outside the exported phase
    if not name or Path(name).name != name or path.suffix != ".txt" \
            or not path.is_relative_to(directory.resolve()) or not path.is_file() \
            or path.stat().st_size > 1000:
        raise ValueError("invalid typed attachment")
    return path.read_text().strip()


# bind edit anchors to one genuine exported screenshot
def exported_timestamp(item, directory):
    name = item.get("exportedFileName", "")
    path = (directory / name).resolve()
    # reject missing or unsafe screenshot paths
    if not name or Path(name).name != name or path.suffix != ".png" \
            or not path.is_relative_to(directory.resolve()) or not path.is_file() \
            or path.stat().st_size > 8388608:
        raise ValueError("invalid selected-edit screenshot")
    payload = path.read_bytes()
    # require checked PNG chunks rather than a named empty or ASCII file
    if not payload.startswith(PNG_SIGNATURE):
        raise ValueError("selected-edit screenshot is not PNG")
    position = len(PNG_SIGNATURE)
    seen_header = seen_image = seen_end = False
    # inspect the complete bounded PNG container
    while position + 12 <= len(payload):
        length = struct.unpack_from(">I", payload, position)[0]
        end = position + 12 + length
        # reject truncated or oversized chunks
        if end > len(payload):
            raise ValueError("selected-edit PNG chunk is truncated")
        kind = payload[position + 4:position + 8]
        data = payload[position + 8:position + 8 + length]
        checksum = struct.unpack_from(">I", payload, position + 8 + length)[0]
        # reject corrupt screenshot bytes
        if zlib.crc32(kind + data) & 0xffffffff != checksum:
            raise ValueError("selected-edit PNG checksum failed")
        # require a positive image header first
        if position == len(PNG_SIGNATURE):
            if kind != b"IHDR" or length != 13 or not all(struct.unpack_from(">II", data)):
                raise ValueError("selected-edit PNG header is invalid")
            seen_header = True
        # retain a nonempty compressed image payload
        if kind == b"IDAT" and length > 0:
            seen_image = True
        # require the terminal image chunk
        if kind == b"IEND":
            seen_end = length == 0 and end == len(payload)
            break
        position = end
    if not (seen_header and seen_image and seen_end):
        raise ValueError("selected-edit PNG is incomplete")
    return float(item["timestamp"])


# decode compact-log times using the query's own wall-clock offset
def log_time(line, offset):
    match = STAMP.match(line)
    # reject lines without a compact-log clock
    if not match:
        raise ValueError("log line lacks a timestamp")
    reading = datetime.datetime.strptime(match.group(1) + offset, "%Y-%m-%d %H:%M:%S.%f%z")
    return reading.timestamp()


# compare current page and frame across independently executed phases
def target_matches(current, baseline):
    first = TARGET.fullmatch(current)
    second = TARGET.fullmatch(baseline)
    # reject another page before comparing host geometry
    if not first or not second or first.group(1) != second.group(1):
        return False
    return all(abs(float(first.group(index)) - float(second.group(index))) <= 2 for index in range(2, 6))


# require the complete bounded public record set
def verify(args):
    manifest = Path(args.manifest)
    log = Path(args.log)
    # bound retained public evidence
    if not manifest.is_file() or manifest.stat().st_size > 262144 \
            or not log.is_file() or log.stat().st_size > 4194304:
        raise ValueError("phase evidence is absent or oversized")
    payload = json.loads(manifest.read_text())
    items = [item for test in payload for item in test.get("attachments", [])]
    offset = Path(args.utc_offset).read_text().strip()
    # use only the recorded runner timezone
    if not re.fullmatch(r"[+-][0-9]{4}", offset) or abs(int(offset[1:3]) * 60 + int(offset[3:])) > 840:
        raise ValueError("runner UTC offset is missing or invalid")
    target = exported_text(attachment(items, args.target_stage + "-target", "txt"), manifest.parent)
    # require one structured current-page receipt
    if not TARGET.fullmatch(target):
        raise ValueError("current page and host frame receipt is malformed")
    # compare across the real reboot boundary when requested
    if args.baseline_target and not target_matches(target, Path(args.baseline_target).read_text().strip()):
        raise ValueError("current page or host frame differs from baseline")
    selected = attachment(items, args.stage, "txt")
    summary = exported_text(selected, manifest.parent)
    match = SUMMARY.fullmatch(summary)
    # reject failed, partial, or overflow summaries
    if not match:
        raise ValueError("typed summary is not complete and bounded")
    epoch, observed_at, total, count = map(int, match.groups()[:4])
    attachment_time = float(selected["timestamp"])
    # bind the attachment to its own query time
    if not observed_at / 1000 <= attachment_time <= observed_at / 1000 + 120:
        raise ValueError("typed attachment does not follow its public query")
    # reject more than the eight listed public records
    if count > 8 or count > total:
        raise ValueError("public listing overflow or count mismatch")
    pairs = []
    # decode all declared public records
    for part in match.group(5).split(","):
        pair = re.fullmatch(r"([0-9]+):(fahrenheit|celsius)", part)
        # reject an unrecognized typed unit
        if not pair:
            raise ValueError("public listing contains an untyped record")
        pairs.append((int(pair.group(1)), pair.group(2)))
    if len(pairs) != count or len({index for index, _ in pairs}) != count \
            or any(index >= total for index, _ in pairs) \
            or args.unit not in {unit for _, unit in pairs}:
        raise ValueError("public listing is incomplete or lacks expected unit")

    lines = log.read_text(errors="replace").splitlines()
    # require one full-text phase-log match, not a reused epoch
    matches = [
        index for index, line in enumerate(lines)
        if " Weather[" in line and line.partition("widget-info ")[2] == summary
    ]
    if len(matches) != 1:
        raise ValueError("typed attachment does not bind one exact phase-log query")
    position = matches[0]
    query_time = log_time(lines[position], offset)
    # reject any shifted or stale compact-log clock
    if abs(observed_at / 1000 - query_time) > 2:
        raise ValueError("public query and phase log clocks disagree")
    app_pid = re.search(r"\bWeather\[([0-9]+):", lines[position])
    # bind the summary to its app process
    if not app_pid:
        raise ValueError("public summary lacks an app process identity")
    logged = []
    # reconcile every adjacent entry with the accepted summary
    for line in lines[position + 1:]:
        detail = line.partition("widget-info ")[2]
        # stop at the next public query
        if detail.startswith("widget-config epoch="):
            break
        # inspect only bounded matching entry logs
        if detail.startswith("widget-config-entry "):
            # reject entries from another app process
            if not re.search(r"\bWeather\[" + app_pid.group(1) + r":", line):
                raise ValueError("public entry came from another app process")
            entry = ENTRY.fullmatch(detail)
            # reject mixed epochs and malformed records
            if not entry or int(entry.group(1)) != epoch:
                raise ValueError("public entry is malformed or from another epoch")
            logged.append((int(entry.group(2)), entry.group(3)))
            # reject more than eight entry lines
            if len(logged) > 8:
                raise ValueError("public entry log overflow")
    if logged != pairs:
        raise ValueError("phase-log entries do not reconcile with the typed summary")

    observation_time = exported_timestamp(attachment(items, args.observation, "png"), manifest.parent)
    # require the render before the typed query
    if observation_time > observed_at / 1000:
        raise ValueError("public query predates the target render observation")
    reopened = attachment(items, args.reopened, "txt")
    expected_switch = "1" if args.unit == "celsius" else "0"
    if exported_text(reopened, manifest.parent) != f"reopened-native-unit={args.unit} switch={expected_switch}":
        raise ValueError("reopened native switch receipt disagrees with target unit")
    reopened_time = float(reopened["timestamp"])
    # require the read-only reopen after the observed render
    if reopened_time < observation_time:
        raise ValueError("native switch was reread before target render")
    # honor the two intentional UI-test query orders
    if args.reopen_order == "before" and reopened_time > observed_at / 1000:
        raise ValueError("native switch reread followed the typed query")
    if args.reopen_order == "after" and reopened_time < attachment_time:
        raise ValueError("native switch reread preceded the typed query")
    # compare only genuine exported native-edit anchors
    anchor_time = None
    if args.anchor:
        image = attachment(items, args.anchor, "png")
        anchor_time = exported_timestamp(image, manifest.parent)
        # require the selected edit before the target render and query
        if args.order == "after" and not anchor_time < observation_time <= observed_at / 1000:
            raise ValueError("selected edit, render, and typed query are out of order")
        # require the post-reboot Celsius proof before returning to Fahrenheit
        if args.order == "before" and not observation_time <= observed_at / 1000 < anchor_time:
            raise ValueError("rebooted Celsius proof did not precede the return edit")
    provider_events = []
    # retain callback values as phase diagnostics without claiming a host join
    for line in lines:
        if " WeatherWidgetExtension[" not in line or "v4-provider-input stage=" not in line:
            continue
        callback = re.search(r"v4-provider-input stage=(placeholder|snapshot|timeline) unit=(unsupplied|fahrenheit|celsius)", line)
        if not callback:
            continue
        try:
            callback_time = log_time(line, offset)
        except ValueError:
            provider_events.append(f"{callback.group(1)}:{callback.group(2)}:unclocked")
            continue
        position_name = "after-render" if callback_time > observation_time else "before-render"
        if anchor_time is not None and callback_time < anchor_time:
            position_name = "before-selection"
        provider_events.append(f"{callback.group(1)}:{callback.group(2)}:{position_name}")
    # retain the verified target for a later process phase
    if args.target_out:
        Path(args.target_out).write_text(target + "\n")
    print(
        f"stage={args.stage} epoch={epoch} observedAtMs={observed_at} "
        f"matching={count} typed={','.join(unit for _, unit in pairs)} "
        f"provider_diagnostic={','.join(provider_events) or 'none'} order={args.order} target={target}"
    )


# preserve a nonzero probe verdict on any malformed evidence
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--target-stage", required=True)
    parser.add_argument("--target-out")
    parser.add_argument("--baseline-target")
    parser.add_argument("--utc-offset", required=True)
    parser.add_argument("--observation", required=True)
    parser.add_argument("--reopened", required=True)
    parser.add_argument("--reopen-order", choices=("before", "after"), default="before")
    parser.add_argument("--unit", choices=("fahrenheit", "celsius"), required=True)
    parser.add_argument("--anchor")
    parser.add_argument("--order", choices=("after", "before"), default="after")
    args = parser.parse_args()
    # preserve every malformed proof as a failed probe
    try:
        verify(args)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        parser.exit(78, f"widget configuration evidence failed: {error}\n")


# run only for explicit phase verification
if __name__ == "__main__":
    main()
