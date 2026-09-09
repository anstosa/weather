#!/usr/bin/env python3
"""Pair verified archive humidity forecasts to private network observations."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import verify_moisture_acquisition as verifier

CONTRACT_VERSION = "humidity-shortlead-pairing/v2"
COHORTS = tuple(verifier.COHORT_MODELS)
COUNT_KEYS = (
    "eligibleRows",
    "forecastHumidityNull",
    "targetMissing",
    "targetHumidityNull",
    "outOfScopeLead",
    "duplicateKeys",
)


class PairingError(Exception):
    """Represent a closed humidity pairing failure."""


# encode deterministic json
def canonical_json(value: Any) -> str:
    """Encode strict canonical JSON."""
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


# require one ordinary file
def require_file(path: Path, label: str) -> Path:
    """Reject absent files and terminal symlinks."""
    if path.is_symlink() or not path.is_file():
        raise PairingError(f"{label} is missing or not a regular file: {path}")

    return path


# hash one ordinary file
def file_sha256(path: Path) -> str:
    """Hash one file without retaining it in memory."""
    require_file(path, "hash input")

    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


# read strict json lines
def read_jsonl(path: Path, label: str) -> Iterator[dict[str, Any]]:
    """Yield nonblank strict JSON objects."""
    require_file(path, label)

    try:
        with path.open("r", encoding="utf-8") as stream:
            # parse every input row
            for line_number, line in enumerate(stream, start=1):
                # reject blank records
                if not line.strip():
                    raise PairingError(f"blank {label} row at line {line_number}")

                try:
                    value = json.loads(
                        line,
                        parse_constant=lambda _value: (_ for _ in ()).throw(
                            ValueError("non-finite number")
                        ),
                    )
                except (json.JSONDecodeError, ValueError) as error:
                    raise PairingError(
                        f"invalid {label} row at line {line_number}"
                    ) from error

                # require row objects
                if not isinstance(value, dict):
                    raise PairingError(f"non-object {label} row at line {line_number}")

                yield value
    except UnicodeError as error:
        raise PairingError(f"invalid UTF-8 in {label}") from error


# require one finite number
def finite(value: Any, label: str) -> float | int:
    """Require a finite non-boolean number."""
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(float(value))
    ):
        raise PairingError(f"{label} must be finite")

    return value


# canonicalize an hourly utc timestamp
def canonical_hour(value: Any, label: str) -> str:
    """Normalize one UTC hour to millisecond spelling."""
    if not isinstance(value, str):
        raise PairingError(f"{label} must be a UTC timestamp")

    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PairingError(f"{label} must be a UTC timestamp") from error

    # require explicit utc and an exact hour
    if (
        parsed.tzinfo is None
        or parsed.utcoffset() != dt.timedelta(0)
        or parsed.minute != 0
        or parsed.second != 0
        or parsed.microsecond != 0
    ):
        raise PairingError(f"{label} must be an exact UTC hour")

    return (
        parsed.astimezone(dt.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# create one exclusive temporary output
def temporary_output(path: Path) -> tuple[Path, Any]:
    """Open one private temporary output without following links."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)

    # reject stale temporary files
    if temporary.exists():
        raise PairingError(f"temporary pairing output exists: {temporary}")

    descriptor = os.open(temporary, flags, 0o600)
    return temporary, os.fdopen(descriptor, "w", encoding="utf-8")


# validate one acquisition member
def acquisition_member(
    root: Path, summary: dict[str, Any], cohort: str
) -> tuple[Path, dict[str, Any]]:
    """Bind a normalized cohort to verified acquisition evidence."""
    members = summary.get("cohortFiles")

    # require declared cohort map
    if not isinstance(members, dict) or set(members) != set(COHORTS):
        raise PairingError("verified acquisition cohort set changed")

    member = members.get(cohort)

    # require one verified descriptor
    if (
        not isinstance(member, dict)
        or member.get("hashVerified") is not True
        or member.get("rowCountVerified") is not True
    ):
        raise PairingError("acquisition cohort is not independently verified")

    expected = (root / "acquisition/normalized" / f"{cohort}.jsonl").resolve(
        strict=True
    )

    # bind both relative and absolute paths
    if member.get("path") != f"normalized/{cohort}.jsonl" or member.get(
        "absolutePath"
    ) != str(expected):
        raise PairingError("verified acquisition cohort path changed")

    require_file(expected, "verified acquisition cohort")

    # recheck member bytes
    if expected.stat().st_size != member.get("bytes") or file_sha256(
        expected
    ) != member.get("sha256"):
        raise PairingError("verified acquisition cohort content changed")

    return expected, member


# load canonical target humidity
def load_network(path: Path) -> tuple[dict[str, float | int | None], dict[str, Any]]:
    """Load unique canonical target hours without imputing labels."""
    network = {}
    rows = 0
    before_sha = file_sha256(path)
    before_bytes = path.stat().st_size

    # index every observation hour
    for row in read_jsonl(path, "humidity network"):
        rows += 1
        valid_at = canonical_hour(row.get("validAt"), "network validAt")

        # reject canonical duplicates
        if valid_at in network:
            raise PairingError("duplicate network target hour")

        actual = row.get("actualRelativeHumidityPercent")

        # validate present targets
        if actual is not None:
            actual = finite(actual, "actual relative humidity")

            # enforce physical bounds
            if not 0 <= actual <= 100:
                raise PairingError(
                    "actual relative humidity is outside physical bounds"
                )

        network[valid_at] = actual

    after_sha = file_sha256(path)

    # reject changes during indexing
    if before_sha != after_sha or before_bytes != path.stat().st_size:
        raise PairingError("humidity network changed during pairing")

    receipt = {
        "path": str(path.resolve()),
        "sha256": after_sha,
        "rows": rows,
        "uniqueValidHours": len(network),
    }
    return network, receipt


# validate and pair one cohort
def pair_cohort(
    cohort: str,
    source_path: Path,
    source_member: dict[str, Any],
    network: dict[str, float | int | None],
    destination: Path,
) -> tuple[Path, dict[str, Any]]:
    """Stream one verified cohort into a private paired member."""
    counts = {
        "inputRows": 0,
        "eligibleRows": 0,
        "forecastHumidityNull": 0,
        "targetMissing": 0,
        "targetHumidityNull": 0,
        "outOfScopeLead": 0,
        "duplicateKeys": 0,
    }
    seen = set()
    temporary, target = temporary_output(destination)

    # complete one staged member
    try:
        with target:
            # inspect every verified forecast
            for row in read_jsonl(source_path, f"{cohort} forecast"):
                counts["inputRows"] += 1
                key = row.get("key")

                # reject invalid identities
                if not isinstance(key, str) or not key:
                    raise PairingError("forecast key must be nonempty text")

                # reject duplicate identities
                if key in seen:
                    counts["duplicateKeys"] += 1
                    raise PairingError("duplicate verified forecast key")

                seen.add(key)

                # bind cohort identity
                if row.get("cohort") != cohort or row.get("actualIssueAt") is not None:
                    raise PairingError("forecast cohort boundary changed")

                lead = row.get("targetLeadHours")

                # preserve the selected lead range
                if (
                    not isinstance(lead, int)
                    or isinstance(lead, bool)
                    or not 1 <= lead <= 48
                ):
                    counts["outOfScopeLead"] += 1
                    continue

                valid_at = canonical_hour(row.get("validAt"), "forecast validAt")
                reference_at = canonical_hour(
                    row.get("referenceAt"), "forecast referenceAt"
                )
                initialized_at = canonical_hour(
                    row.get("runInitializedAt"), "forecast runInitializedAt"
                )

                # bind truthful run references
                if reference_at != initialized_at:
                    raise PairingError(
                        "forecast reference differs from run initialization"
                    )

                valid = dt.datetime.fromisoformat(valid_at.replace("Z", "+00:00"))
                reference = dt.datetime.fromisoformat(
                    reference_at.replace("Z", "+00:00")
                )

                # bind lead to forecast instants
                if valid - reference != dt.timedelta(hours=lead):
                    raise PairingError("forecast lead differs from timestamps")

                humidity = row.get("rawRelativeHumidityPercent")

                # preserve forecast missingness
                if humidity is None:
                    counts["forecastHumidityNull"] += 1
                    continue

                humidity = finite(humidity, "forecast relative humidity")

                # enforce physical bounds
                if not 0 <= humidity <= 100:
                    raise PairingError(
                        "forecast relative humidity is outside physical bounds"
                    )

                # preserve absent target hours
                if valid_at not in network:
                    counts["targetMissing"] += 1
                    continue

                actual = network[valid_at]

                # preserve null target labels
                if actual is None:
                    counts["targetHumidityNull"] += 1
                    continue

                temperature = row.get("rawTemperatureC")
                wind = row.get("rawWindSpeedMps")

                # validate optional covariates
                if temperature is not None:
                    finite(temperature, "forecast temperature")

                # validate optional wind
                if wind is not None:
                    finite(wind, "forecast wind speed")

                paired = {
                    "key": key,
                    "cohort": cohort,
                    "validAt": valid_at,
                    "referenceAt": reference_at,
                    "targetLeadHours": lead,
                    "rawRelativeHumidityPercent": humidity,
                    "actualRelativeHumidityPercent": actual,
                    "rawTemperatureC": temperature,
                    "rawWindSpeedMps": wind,
                }
                target.write(canonical_json(paired) + "\n")
                counts["eligibleRows"] += 1

            target.flush()
            os.fsync(target.fileno())
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    # close source row accounting
    if counts["inputRows"] != sum(counts[key] for key in COUNT_KEYS):
        temporary.unlink(missing_ok=True)
        raise PairingError("pairing accounting does not close")

    # bind verified source row count
    if counts["inputRows"] != source_member.get("rows"):
        temporary.unlink(missing_ok=True)
        raise PairingError("verified source row count changed")

    # reject source changes during pairing
    if source_path.stat().st_size != source_member.get("bytes") or file_sha256(
        source_path
    ) != source_member.get("sha256"):
        temporary.unlink(missing_ok=True)
        raise PairingError("verified source changed during pairing")

    receipt = {
        "inputPath": str(source_path.resolve()),
        "inputSha256": source_member["sha256"],
        "inputRows": source_member["rows"],
        "pairedPath": str(destination.resolve()),
        "pairedSha256": file_sha256(temporary),
        "pairedBytes": temporary.stat().st_size,
        "pairedMode": oct(temporary.stat().st_mode & 0o777),
        "counts": counts,
    }
    return temporary, receipt


# install staged outputs exclusively
def install_outputs(temporaries: dict[Path, Path]) -> None:
    """Install all staged outputs without replacing existing files."""
    installed = []

    # link every output exclusively
    try:
        for destination, temporary in temporaries.items():
            os.link(temporary, destination)
            installed.append(destination)
    except FileExistsError as error:
        # remove only owned installed links
        for destination in installed:
            destination.unlink()

        raise PairingError("pairing output appeared concurrently") from error
    finally:
        # remove every staged path
        for temporary in temporaries.values():
            temporary.unlink(missing_ok=True)


# compare reusable outputs
def reuse_outputs(
    outputs: dict[Path, Path], manifest_path: Path, receipt: dict[str, Any]
) -> dict[str, Any]:
    """Require existing output hashes and manifest to match recomputation."""
    # compare every staged member
    for destination, temporary in outputs.items():
        if destination.stat().st_size != temporary.stat().st_size or file_sha256(
            destination
        ) != file_sha256(temporary):
            raise PairingError("existing pairing output changed")

    try:
        existing = json.loads(
            manifest_path.read_text(encoding="utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(
                ValueError("non-finite number")
            ),
        )
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise PairingError("existing pairing output changed") from error

    # bind exact manifest content
    if existing != receipt:
        raise PairingError("existing pairing output changed")

    # remove staged comparisons
    for temporary in outputs.values():
        temporary.unlink(missing_ok=True)

    return receipt


# pair both verified archive cohorts
def pair(private_root: Path, evidence: Path) -> dict[str, Any]:
    """Pair verified forecasts and safely retain exact v2 outputs."""
    private_root = private_root.resolve(strict=True)
    evidence = evidence.resolve()
    summary = verifier.verify(private_root, evidence)

    # require completed verification
    if summary.get("status") != "complete":
        raise PairingError("acquisition verification is not complete")

    humidity_candidate = private_root / "humidity"

    # reject redirected private outputs
    if humidity_candidate.is_symlink() or not humidity_candidate.is_dir():
        raise PairingError("humidity root is missing or linked")

    humidity_root = humidity_candidate.resolve(strict=True)
    network_path = humidity_root / "network.jsonl"
    manifest_path = humidity_root / "shortlead-pairing-manifest-v2.json"
    destinations = {
        cohort: humidity_root / f"{cohort}-paired-v2.jsonl" for cohort in COHORTS
    }
    expected_outputs = [*destinations.values(), manifest_path]
    present = [path.exists() for path in expected_outputs]

    # reject incomplete reusable sets
    if any(present) and not all(present):
        raise PairingError("partial pairing output set exists")

    network, network_receipt = load_network(network_path)
    staged = {}
    source_receipts = {}

    # stage both isolated cohorts
    try:
        for cohort, destination in destinations.items():
            source_path, source_member = acquisition_member(
                private_root, summary, cohort
            )
            temporary, source_receipt = pair_cohort(
                cohort, source_path, source_member, network, destination
            )
            staged[destination] = temporary
            source_receipts[cohort] = source_receipt
    except Exception:
        # remove completed staged cohorts
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)

        raise

    # recheck inputs before output installation
    for cohort, source_receipt in source_receipts.items():
        source_path, source_member = acquisition_member(private_root, summary, cohort)

        # bind the staged source receipt
        if (
            source_receipt["inputSha256"] != source_member["sha256"]
            or file_sha256(source_path) != source_member["sha256"]
        ):
            for temporary in staged.values():
                temporary.unlink(missing_ok=True)

            raise PairingError("verified source changed before output installation")

    # recheck targets before output installation
    if file_sha256(network_path) != network_receipt["sha256"]:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)

        raise PairingError("humidity network changed before output installation")

    # expose only archive paired members to the runner
    input_files = {
        Path(source["pairedPath"]).name: source["pairedSha256"]
        for source in source_receipts.values()
    }
    receipt = {
        "contractVersion": CONTRACT_VERSION,
        "acquisition": {
            "manifestSha256": summary["manifestSha256"],
            "status": summary["status"],
            "requestedRuns": summary.get("requestedRuns"),
        },
        "network": network_receipt,
        "inputFiles": input_files,
        "sources": source_receipts,
    }

    # reverify complete prior outputs
    if all(present):
        try:
            return reuse_outputs(staged, manifest_path, receipt)
        finally:
            # remove staged comparisons after failure
            for temporary in staged.values():
                temporary.unlink(missing_ok=True)

    manifest_temporary, manifest_stream = temporary_output(manifest_path)

    # sync staged manifest
    try:
        with manifest_stream:
            manifest_stream.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
            manifest_stream.flush()
            os.fsync(manifest_stream.fileno())
    except Exception:
        manifest_temporary.unlink(missing_ok=True)

        # remove staged cohort files
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)

        raise

    staged[manifest_path] = manifest_temporary
    install_outputs(staged)
    return receipt


# parse two positional roots
def parse_arguments() -> argparse.Namespace:
    """Parse the private root and evidence root."""
    parser = argparse.ArgumentParser()
    parser.add_argument("private_root", type=Path)
    parser.add_argument("evidence", type=Path)
    return parser.parse_args()


# expose one closed cli boundary
def main() -> int:
    """Pair without disclosing row data or tracebacks."""
    args = parse_arguments()

    try:
        receipt = pair(args.private_root, args.evidence)
    except (OSError, PairingError, verifier.VerificationError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(canonical_json(receipt))
    return 0


# avoid reads on import
if __name__ == "__main__":
    raise SystemExit(main())
