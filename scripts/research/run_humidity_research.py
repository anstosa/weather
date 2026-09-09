#!/usr/bin/env python3
"""Run one bounded all-source frozen humidity research fit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import humidity_research

CONTRACT_VERSION = "humidity-research-runner/v1"
SHA256_LENGTH = 64


# hash one artifact without loading it into memory
def file_sha256(path):
    """return one file sha256"""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


# recognize one lowercase hexadecimal sha256
def is_sha256(value):
    """return whether a value is one canonical sha256"""
    # reject nontext and noncanonical digests
    if not isinstance(value, str) or len(value) != SHA256_LENGTH:
        return False
    return all(character in "0123456789abcdef" for character in value)


# collect path-bound hashes from one evidence document
def collect_attestations(document):
    """return basename-to-hash evidence from common manifest shapes"""
    attestations = {}

    # retain one unambiguous file binding
    def add(locator, digest):
        """record one path or filename digest"""
        # ignore non-file bindings
        if not isinstance(locator, str) or not locator or not is_sha256(digest):
            return
        name = Path(locator).name
        # retain only jsonl inputs
        if not name.endswith(".jsonl"):
            return
        attestations.setdefault(name, set()).add(digest)

    # inspect nested evidence without requiring one historical schema
    def visit(value):
        """walk one json evidence value"""
        # inspect path-and-sha records
        if isinstance(value, dict):
            digest = value.get("sha256")
            # bind explicit record shapes
            if is_sha256(digest):
                for field in ("path", "file", "name", "relativePath"):
                    locator = value.get(field)
                    # use the first declared locator
                    if isinstance(locator, str):
                        add(locator, digest)
                        break
            # inspect filename-to-sha maps and nested values
            for key, child in value.items():
                # bind direct input-file maps
                if is_sha256(child):
                    add(key, child)
                visit(child)
            return
        # inspect manifest record lists
        if isinstance(value, list):
            for child in value:
                visit(child)

    visit(document)
    return attestations


# read one frozen json evidence document
def read_json_document(path):
    """load one required json object"""
    try:
        document = json.loads(path.read_bytes())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid json evidence: {path}") from error
    # require object-shaped evidence
    if not isinstance(document, dict):
        raise TypeError(f"json evidence must be an object: {path}")
    return document


# reject missing or special input files
def validate_regular_file(path, label):
    """require one existing regular file"""
    # reject missing and nonregular paths
    if not path.is_file():
        raise ValueError(f"{label} is not a regular file: {path}")


# fail before any model-owned output can be created
def validate_outputs(paths):
    """require distinct absent output paths"""
    resolved = [path.resolve(strict=False) for path in paths]
    # reject aliases between outputs
    if len(set(resolved)) != len(resolved):
        raise ValueError("output paths must be distinct")
    # reject every existing path including broken symlinks
    for path in paths:
        if os.path.lexists(path):
            raise FileExistsError(f"output exists: {path}")
        # require one existing output directory
        if not path.parent.is_dir():
            raise ValueError(f"output directory is not a directory: {path.parent}")


# validate the four frozen input identities
def validate_inputs(paths):
    """require four unique jsonl input files"""
    # bind this runner to the complete four-source stage
    if len(paths) != 4:
        raise ValueError("exactly four humidity inputs are required")
    # reject path and basename aliases
    if len({path.resolve(strict=False) for path in paths}) != len(paths):
        raise ValueError("humidity input paths must be distinct")
    if len({path.name for path in paths}) != len(paths):
        raise ValueError("humidity input basenames must be distinct")
    # validate every literal input
    for path in paths:
        validate_regular_file(path, "input")
        # keep plaintext prediction inputs explicit
        if path.suffix != ".jsonl":
            raise ValueError(f"input must be a .jsonl file: {path}")


# bind two production and two archive inputs to separate evidence
def verify_input_attestations(input_hashes, production, pairing):
    """verify every input against exactly one frozen evidence source"""
    production_matches = set()
    pairing_matches = set()
    # compare all actual input hashes
    for name, actual in input_hashes.items():
        sources = []
        # verify production evidence when it names the input
        if name in production:
            expected = production[name]
            # reject ambiguous or stale production evidence
            if expected != {actual}:
                raise ValueError(
                    f"input hash does not match production manifest: {name}"
                )
            production_matches.add(name)
            sources.append("production")
        # verify archive evidence when it names the input
        if name in pairing:
            expected = pairing[name]
            # reject ambiguous or stale pairing evidence
            if expected != {actual}:
                raise ValueError(f"input hash does not match pairing manifest: {name}")
            pairing_matches.add(name)
            sources.append("pairing")
        # require one unique evidence owner
        if not sources:
            raise ValueError(f"input hash is not attested: {name}")
        if len(sources) != 1:
            raise ValueError(f"input is attested by multiple manifests: {name}")
    # require the declared two-plus-two source composition
    if len(production_matches) != 2 or len(pairing_matches) != 2:
        raise ValueError("inputs must contain two production and two archive files")
    return {
        "productionManifest": sorted(production_matches),
        "pairingManifest": sorted(pairing_matches),
    }


# load model-ready rows from all frozen sources
def read_rows(paths):
    """read strict object json lines in command order"""
    rows = []
    # preserve the caller's frozen source order
    for path in paths:
        with path.open("r", encoding="utf-8") as stream:
            # validate every physical input line
            for line_number, line in enumerate(stream, start=1):
                # reject hidden gaps in a frozen jsonl source
                if not line.strip():
                    raise ValueError(f"blank input line: {path}:{line_number}")
                try:
                    row = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(
                        f"invalid input json: {path}:{line_number}"
                    ) from error
                # require model row objects
                if not isinstance(row, dict):
                    raise TypeError(
                        f"input row must be an object: {path}:{line_number}"
                    )
                rows.append(row)
    return rows


# count and validate plaintext prediction records
def count_predictions(path):
    """return the number of strict prediction json lines"""
    count = 0
    with path.open("r", encoding="utf-8") as stream:
        # validate every model-emitted record
        for line_number, line in enumerate(stream, start=1):
            # reject incomplete or blank prediction output
            if not line.strip():
                raise ValueError(f"blank prediction line: {path}:{line_number}")
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"invalid prediction json: {path}:{line_number}"
                ) from error
            # require verifier-compatible records
            if not isinstance(record, dict):
                raise TypeError(
                    f"prediction row must be an object: {path}:{line_number}"
                )
            count += 1
    return count


# create one file without replacing earlier evidence
def write_json_exclusive(path, value, *, compact):
    """write one json artifact with exclusive creation"""
    with path.open("x", encoding="utf-8") as stream:
        # keep aggregate output canonical for repeat verification
        if compact:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
        else:
            json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


# parse the bounded command surface
def parse_arguments(argv=None):
    """parse one humidity research invocation"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", nargs="+", required=True, type=Path)
    parser.add_argument("--predictions", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--production-manifest", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--pairing-manifest", required=True, type=Path)
    return parser.parse_args(argv)


# run one immutable all-source humidity evaluation
def run(argv=None):
    """fit the frozen model and publish verifier-compatible evidence"""
    args = parse_arguments(argv)
    started = time.monotonic()
    model_source = Path(humidity_research.__file__)
    source_paths = (
        model_source,
        args.production_manifest,
        args.plan,
        args.pairing_manifest,
    )
    outputs = (args.predictions, args.report, args.receipt)
    # preflight all sources and outputs before fitting
    validate_inputs(args.inputs)
    for path in source_paths:
        validate_regular_file(path, "source")
    validate_outputs(outputs)
    # require the model's absolute private-output contract
    if not args.predictions.is_absolute():
        raise ValueError("predictions path must be absolute")
    if args.predictions.suffix != ".jsonl":
        raise ValueError("predictions path must use the .jsonl suffix")

    source_hashes_before = {
        str(path.resolve()): file_sha256(path) for path in source_paths
    }
    input_hashes_before = {path.name: file_sha256(path) for path in args.inputs}
    production_document = read_json_document(args.production_manifest)
    pairing_document = read_json_document(args.pairing_manifest)
    # parse the plan even though input hashes live in dedicated manifests
    read_json_document(args.plan)
    input_evidence = verify_input_attestations(
        input_hashes_before,
        collect_attestations(production_document),
        collect_attestations(pairing_document),
    )
    rows = read_rows(args.inputs)

    report = humidity_research.evaluate(rows, args.predictions)
    # require the model to create its exclusive plaintext prediction output
    if not args.predictions.is_file():
        raise ValueError("model did not create plaintext predictions")
    prediction_rows = count_predictions(args.predictions)
    input_hashes_after = {path.name: file_sha256(path) for path in args.inputs}
    source_hashes_after = {
        str(path.resolve()): file_sha256(path) for path in source_paths
    }
    # reject any fitted result derived across changing inputs
    if input_hashes_before != input_hashes_after:
        raise ValueError("input changed while fitting")
    # reject any fitted result derived across changing sources
    if source_hashes_before != source_hashes_after:
        raise ValueError("source changed while fitting")

    write_json_exclusive(args.report, report, compact=True)
    predictions_sha256 = file_sha256(args.predictions)
    report_sha256 = file_sha256(args.report)
    model_source_sha256 = source_hashes_after[str(model_source.resolve())]
    receipt = {
        "contractVersion": CONTRACT_VERSION,
        "metric": "humidity",
        "elapsedSeconds": time.monotonic() - started,
        "inputFiles": input_hashes_after,
        "inputHashesBefore": input_hashes_before,
        "inputHashesAfter": input_hashes_after,
        "inputEvidence": input_evidence,
        "inputRows": len(rows),
        "predictionRows": prediction_rows,
        "predictionsFile": args.predictions.name,
        "predictionStorage": "plaintext",
        "predictionsSha256": predictions_sha256,
        "compressedPredictionsSha256": None,
        "reportFile": args.report.name,
        "reportSha256": report_sha256,
        "aggregateReportSha256": report_sha256,
        "modelSourceSha256": model_source_sha256,
        "productionManifestSha256": source_hashes_after[
            str(args.production_manifest.resolve())
        ],
        "planSha256": source_hashes_after[str(args.plan.resolve())],
        "pairingManifestSha256": source_hashes_after[
            str(args.pairing_manifest.resolve())
        ],
        "sourceHashesBefore": source_hashes_before,
        "sourceHashesAfter": source_hashes_after,
        "productionEligible": False,
    }
    # publish the completion receipt last
    write_json_exclusive(args.receipt, receipt, compact=False)
    return receipt


# expose one json receipt to the orchestrator
def main():
    """run from command-line arguments"""
    receipt = run()
    print(json.dumps(receipt, sort_keys=True), flush=True)


# imports never start fitting
if __name__ == "__main__":
    main()
