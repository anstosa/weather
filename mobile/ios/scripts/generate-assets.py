#!/usr/bin/env python3
"""Generate the deterministic iOS app icon from the repository brand master."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

IOS_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = IOS_ROOT.parents[1]
SOURCE = REPOSITORY / "apps/web/public/brand/weather-app-icon-master.png"
CATALOG = IOS_ROOT / "WeatherApp/Resources/Assets.xcassets"
APP_ICON = CATALOG / "AppIcon.appiconset/AppIcon-1024.png"
CONTENTS = CATALOG / "AppIcon.appiconset/Contents.json"
CATALOG_CONTENTS = CATALOG / "Contents.json"
PROVENANCE = CATALOG / "AppIcon.appiconset/source-provenance.json"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
BLUSH = (251, 242, 248)
TARGET_SIZE = 1024


# apply one PNG scanline filter
def unfilter(row: bytearray, previous: bytes, filter_type: int, stride: int) -> bytes:
    """restore one noninterlaced PNG row"""
    # restore every byte from its filtered neighbors
    for index in range(len(row)):
        left = row[index - stride] if index >= stride else 0
        up = previous[index] if previous else 0
        upper_left = previous[index - stride] if previous and index >= stride else 0
        # apply the encoded filter
        if filter_type == 1:
            row[index] = (row[index] + left) & 0xFF
        elif filter_type == 2:
            row[index] = (row[index] + up) & 0xFF
        elif filter_type == 3:
            row[index] = (row[index] + ((left + up) // 2)) & 0xFF
        elif filter_type == 4:
            estimate = left + up - upper_left
            left_distance = abs(estimate - left)
            up_distance = abs(estimate - up)
            upper_left_distance = abs(estimate - upper_left)
            predictor = (
                left
                if left_distance <= up_distance and left_distance <= upper_left_distance
                else up if up_distance <= upper_left_distance else upper_left
            )
            row[index] = (row[index] + predictor) & 0xFF
        elif filter_type != 0:
            raise ValueError(f"unsupported PNG filter {filter_type}")
    return bytes(row)


# decode the reviewed RGBA brand master
def decode_rgba(path: Path) -> tuple[int, int, list[bytes]]:
    """decode one 8-bit noninterlaced RGBA PNG"""
    payload = path.read_bytes()
    if not payload.startswith(PNG_SIGNATURE):
        raise ValueError("brand master is not PNG")
    offset = len(PNG_SIGNATURE)
    compressed = bytearray()
    width = height = 0
    # read every PNG chunk
    while offset < len(payload):
        length = struct.unpack(">I", payload[offset : offset + 4])[0]
        chunk_type = payload[offset + 4 : offset + 8]
        chunk = payload[offset + 8 : offset + 8 + length]
        offset += 12 + length
        # capture the strict input contract
        if chunk_type == b"IHDR":
            width, height, depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
            if (depth, color_type, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("brand master must be 8-bit noninterlaced RGBA")
        elif chunk_type == b"IDAT":
            compressed.extend(chunk)
        elif chunk_type == b"IEND":
            break
    raw = zlib.decompress(compressed)
    stride = width * 4
    rows: list[bytes] = []
    previous = b""
    cursor = 0
    # restore every RGBA scanline
    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        row = unfilter(bytearray(raw[cursor : cursor + stride]), previous, filter_type, 4)
        cursor += stride
        rows.append(row)
        previous = row
    if cursor != len(raw):
        raise ValueError("brand master has unexpected trailing image data")
    return width, height, rows


# composite transparent pixels onto the approved blush background
def composite(rows: list[bytes], width: int) -> list[bytes]:
    """convert RGBA rows to opaque blush-composited RGB"""
    output: list[bytes] = []
    # convert every source row
    for row in rows:
        converted = bytearray(width * 3)
        # composite every source pixel
        for x in range(width):
            source = x * 4
            target = x * 3
            alpha = row[source + 3]
            inverse = 255 - alpha
            # composite every color channel deterministically
            for channel in range(3):
                converted[target + channel] = (
                    row[source + channel] * alpha + BLUSH[channel] * inverse + 127
                ) // 255
        output.append(bytes(converted))
    return output


# resize the square source with deterministic bilinear sampling
def resize(rows: list[bytes], source_size: int) -> list[bytes]:
    """resize opaque square RGB rows to 1024 pixels"""
    output: list[bytes] = []
    scale = source_size / TARGET_SIZE
    # sample every destination row
    for target_y in range(TARGET_SIZE):
        source_y = (target_y + 0.5) * scale - 0.5
        y0 = max(0, min(source_size - 1, int(source_y)))
        y1 = min(source_size - 1, y0 + 1)
        y_weight = max(0.0, source_y - y0)
        converted = bytearray(TARGET_SIZE * 3)
        # sample every destination pixel
        for target_x in range(TARGET_SIZE):
            source_x = (target_x + 0.5) * scale - 0.5
            x0 = max(0, min(source_size - 1, int(source_x)))
            x1 = min(source_size - 1, x0 + 1)
            x_weight = max(0.0, source_x - x0)
            # interpolate every color channel
            for channel in range(3):
                top = (
                    rows[y0][x0 * 3 + channel] * (1 - x_weight)
                    + rows[y0][x1 * 3 + channel] * x_weight
                )
                bottom = (
                    rows[y1][x0 * 3 + channel] * (1 - x_weight)
                    + rows[y1][x1 * 3 + channel] * x_weight
                )
                converted[target_x * 3 + channel] = round(
                    top * (1 - y_weight) + bottom * y_weight
                )
        output.append(bytes(converted))
    return output


# encode one deterministic opaque RGB PNG
def encode_rgb(rows: list[bytes]) -> bytes:
    """encode filter-zero RGB rows without ancillary metadata"""
    def chunk(kind: bytes, payload: bytes) -> bytes:
        """encode one checksummed PNG chunk"""
        return (
            struct.pack(">I", len(payload))
            + kind
            + payload
            + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + row for row in rows)
    header = struct.pack(">IIBBBBB", TARGET_SIZE, TARGET_SIZE, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


# build every deterministic asset-catalog byte
def generated() -> dict[Path, bytes]:
    """return the complete expected asset catalog"""
    width, height, rgba = decode_rgba(SOURCE)
    if width != height:
        raise ValueError("brand master must remain square")
    icon = encode_rgb(resize(composite(rgba, width), width))
    contents = {
        "images": [
            {
                "filename": APP_ICON.name,
                "idiom": "universal",
                "platform": "ios",
                "size": "1024x1024",
            }
        ],
        "info": {"author": "xcode", "version": 1},
    }
    catalog_contents = {"info": {"author": "xcode", "version": 1}}
    provenance = {
        "background": "#fbf2f8",
        "generator": "mobile/ios/scripts/generate-assets.py",
        "output": "AppIcon-1024.png",
        "source": "apps/web/public/brand/weather-app-icon-master.png",
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    }
    return {
        APP_ICON: icon,
        CONTENTS: (json.dumps(contents, indent=2, sort_keys=True) + "\n").encode(),
        CATALOG_CONTENTS: (json.dumps(catalog_contents, indent=2, sort_keys=True) + "\n").encode(),
        PROVENANCE: (json.dumps(provenance, indent=2, sort_keys=True) + "\n").encode(),
    }


# write or verify the exact generated catalog
def main() -> int:
    """run deterministic generation or check mode"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    expected = generated()
    # compare or write every catalog artifact
    for path, payload in expected.items():
        if arguments.check:
            if not path.is_file() or path.read_bytes() != payload:
                print(f"iOS asset drift: {path.relative_to(REPOSITORY)}", file=sys.stderr)
                return 1
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
    print("iOS asset catalog verified" if arguments.check else "iOS asset catalog generated")
    return 0


# execute only as a script
if __name__ == "__main__":
    raise SystemExit(main())
