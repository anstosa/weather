"""Finish frozen inactive moisture research after verified archive acquisition."""

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from export_moisture_history import validate_private_root


# describe one explicitly ordered research stage
@dataclass(frozen=True, kw_only=True, slots=True)
class Stage:
    name: str
    command: tuple
    inputs: tuple
    outputs: tuple
    pass_receipts: tuple = ()


# hash exact bytes without loading large private inputs into memory
def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


# bind directory identities without accepting linked or special files
def artifact_hash(path):
    path = Path(path)
    # reject missing artifacts and symlinked ancestors
    if not path.exists() or path.resolve() != path.absolute():
        raise ValueError("missing or linked research artifact: " + str(path))
    # retain exact file identities
    if path.is_file():
        return digest(path)
    # reject non-directory special files
    if not path.is_dir():
        raise ValueError("invalid research artifact: " + str(path))
    members = {}
    # include every member name as well as its content
    for child in sorted(path.rglob("*")):
        # reject links and special members
        if child.is_symlink() or not (child.is_file() or child.is_dir()):
            raise ValueError("linked or special research member")
        # bind only regular file contents
        if child.is_file():
            members[str(child.relative_to(path))] = digest(child)
    return hashlib.sha256(json.dumps(members, sort_keys=True).encode()).hexdigest()


# atomically publish an owned status record
def write_json(path, value):
    # do not replace a linked status destination
    if path.is_symlink():
        raise ValueError("linked research status")
    temporary = path.with_name(path.name + f".{os.getpid()}.partial")
    with temporary.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


# bind a stage's exact declared command and artifact identities
def stage_record(stage):
    return {
        "name": stage.name,
        "command": list(stage.command),
        "inputs": {str(path): artifact_hash(path) for path in stage.inputs},
        "outputs": {str(path): artifact_hash(path) for path in stage.outputs},
    }


# require explicit independent validation before advancing
def require_pass(stage):
    # check every declared validation receipt
    for path in stage.pass_receipts:
        # a successful process exit is insufficient
        if json.loads(path.read_text()).get("verdict") != "PASS":
            raise ValueError("research verification did not pass: " + stage.name)


# execute only an already constructed research command
def run_command(stage, log):
    with log.open("ab") as stream:
        subprocess.run(
            stage.command,
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=subprocess.STDOUT,
            check=True,
        )


# resume only stages whose inputs and outputs still match their committed receipt
def run_stages(stages, evidence, freeze_hash, execute=run_command, verify_freeze=None):
    status_path = evidence / "analysis-status.json"
    state = (
        json.loads(status_path.read_text())
        if status_path.exists()
        else {
            "contractVersion": "moisture-research-continuation/v1",
            "freezeSha256": freeze_hash,
            "completedStages": [],
            "productionEligible": False,
            "status": "running",
        }
    )
    # reject corrupted journals or research-boundary changes before rewriting state
    if (
        state.get("contractVersion") != "moisture-research-continuation/v1"
        or state.get("productionEligible") is not False
        or not isinstance(state.get("completedStages"), list)
        or state.get("status") not in ("running", "failed", "complete")
    ):
        raise ValueError("invalid research continuation journal")
    # do not resume another plan or discard completed stages
    if state.get("freezeSha256") != freeze_hash or len(state["completedStages"]) > len(
        stages
    ):
        raise ValueError("continuation freeze or stage count changed")
    try:
        # keep memory-heavy fits strictly sequential
        for index, stage in enumerate(stages):
            # recheck the frozen sources before every stage
            if verify_freeze is not None:
                verify_freeze()
            # reverify prior outputs rather than trusting a success flag
            if index < len(state["completedStages"]):
                # refuse altered completed artifacts
                if state["completedStages"][index] != stage_record(stage):
                    raise ValueError(
                        "completed research artifacts changed: " + stage.name
                    )
                require_pass(stage)
                continue
            # preserve unpublished partial artifacts for explicit recovery
            if any(path.exists() or path.is_symlink() for path in stage.outputs):
                raise ValueError(
                    "uncommitted output requires inspection: " + stage.name
                )
            inputs_before = {str(path): artifact_hash(path) for path in stage.inputs}
            state.update(
                status="running",
                currentStage=stage.name,
                updatedAtUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
            )
            write_json(status_path, state)
            execute(stage, evidence / ("analysis-" + stage.name + ".log"))
            record = stage_record(stage)
            # reject inputs edited while a stage was running
            if record["inputs"] != inputs_before:
                raise ValueError("research inputs changed during stage: " + stage.name)
            # detect source mutation during execution
            if verify_freeze is not None:
                verify_freeze()
            require_pass(stage)
            state["completedStages"].append(record)
            write_json(status_path, state)
        state.pop("error", None)
        state.update(
            status="complete",
            currentStage=None,
            updatedAtUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
        )
        write_json(status_path, state)
    except Exception as error:
        state.update(
            status="failed",
            error=str(error)[:500],
            updatedAtUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
        )
        write_json(status_path, state)
        raise
    return state


# require every frozen source and prerequisite artifact to remain identical
def verify_snapshot(runtime, root, evidence, freeze):
    bases = {"runtimeFiles": runtime, "privateInputs": root, "evidenceFiles": evidence}
    # require the explicit continuation contract and destination identities
    if (
        freeze.get("contractVersion") != "moisture-research-continuation-freeze/v1"
        or freeze.get("privateRoot") != str(root)
        or freeze.get("evidenceRoot") != str(evidence)
    ):
        raise ValueError("incompatible continuation freeze")
    # interpret hashes only as file identities, never executable commands
    for category, base in bases.items():
        # reject empty or malformed identity maps
        if not isinstance(freeze.get(category), dict) or not freeze[category]:
            raise ValueError("missing frozen artifact category: " + category)
        # validate every literal member and digest
        for name, expected in freeze[category].items():
            relative = Path(name)
            # refuse traversal and malformed hashes
            if (
                not name
                or relative.is_absolute()
                or ".." in relative.parts
                or not isinstance(expected, str)
                or len(expected) != 64
                or any(character not in "0123456789abcdef" for character in expected)
            ):
                raise ValueError("invalid frozen artifact path")
            # bind exact immutable bytes
            if artifact_hash(base / relative) != expected:
                raise ValueError("frozen research artifact changed: " + name)


# keep every model population and published output explicit
def build_stages(root, evidence, runtime):
    python = sys.executable
    plan = evidence / "research-plan.json"
    acquisition = root / "acquisition"
    humidity = root / "humidity"
    predictions = root / "predictions"
    archive_cohorts = ("ecmwf_single_run_hindcast", "best_match_single_run_transfer")
    humidity_inputs = tuple(
        humidity / (name + ".jsonl")
        for name in ("fixed_lead_anchor", "legacy_v4_retrieval_snapshot")
    ) + tuple(humidity / (name + "-paired-v2.jsonl") for name in archive_cohorts)
    pairing_manifest = humidity / "shortlead-pairing-manifest-v2.json"
    acquisition_summary = evidence / "acquisition-summary.json"
    acquisition_verification = evidence / "acquisition-verification.json"
    stages = [
        Stage(
            name="verify-acquisition",
            command=(
                python,
                str(runtime / "verify_moisture_acquisition.py"),
                str(root),
                str(evidence),
            ),
            inputs=(
                acquisition,
                evidence / "acquisition-plan.json",
                evidence / "acquisition-code-freeze.json",
            ),
            outputs=(acquisition_summary, acquisition_verification),
            pass_receipts=(acquisition_verification,),
        ),
        Stage(
            name="pair-humidity",
            command=(
                python,
                str(runtime / "pair_archive_humidity.py"),
                str(root),
                str(evidence),
            ),
            inputs=(humidity / "network.jsonl", acquisition, acquisition_summary),
            outputs=humidity_inputs[2:] + (pairing_manifest,),
        ),
        Stage(
            name="pair-rain-pressure",
            command=(
                python,
                str(runtime / "build_moisture_pairs.py"),
                str(root),
                str(evidence),
                "--source-group",
                "archive",
            ),
            inputs=(
                root / "targets",
                root / "production-moisture/manifest.json",
                evidence / "production-extraction-summary.json",
                evidence / "coverage-inventory.json",
                acquisition,
                acquisition_summary,
            ),
            outputs=(root / "pairs-archive", evidence / "moisture-pairs-summary-archive.json"),
        ),
    ]
    humidity_report = evidence / "humidity-all-source-report.json"
    humidity_receipt = evidence / "humidity-all-source-manifest.json"
    humidity_predictions = predictions / "humidity-all-source-v1.jsonl"
    production_manifest = evidence / "humidity-anchor-live-manifest-v2.json"
    stages.append(
        Stage(
            name="fit-humidity",
            command=(
                python,
                str(runtime / "run_humidity_research.py"),
                "--inputs",
                *map(str, humidity_inputs),
                "--predictions",
                str(humidity_predictions),
                "--report",
                str(humidity_report),
                "--receipt",
                str(humidity_receipt),
                "--plan",
                str(plan),
                "--pairing-manifest",
                str(pairing_manifest),
                "--production-manifest",
                str(production_manifest),
            ),
            inputs=humidity_inputs + (plan, pairing_manifest, production_manifest),
            outputs=(humidity_predictions, humidity_report, humidity_receipt),
        )
    )
    verifications = []

    # bind each independent verifier to the exact fitted rows and receipt
    def add_verifier(metric, inputs, prediction, report, receipt, band=None):
        label = metric + ("-" + band if band else "")
        output = evidence / ("archive-" + label + "-verification.json")
        command = (
            python,
            str(runtime / "verify_moisture_models.py"),
            metric,
            "--inputs",
            *map(str, inputs),
            "--predictions",
            str(prediction),
            "--report",
            str(report),
            "--receipt",
            str(receipt),
            "--output",
            str(output),
        )
        # keep pressure validation inside its literal lead partition
        if band is not None:
            command += ("--band", band)
        stages.append(
            Stage(
                name="verify-" + label,
                command=command,
                inputs=tuple(inputs) + (prediction, report, receipt),
                outputs=(output,),
                pass_receipts=(output,),
            )
        )
        verifications.append(output)

    add_verifier(
        "humidity",
        humidity_inputs,
        humidity_predictions,
        humidity_report,
        humidity_receipt,
    )
    reports = [humidity_report]
    # run the rain challenger and each pressure band in separate processes
    for metric, band in [
        ("rain", None),
        ("pressure", "001-012"),
        ("pressure", "013-024"),
        ("pressure", "025-048"),
    ]:
        label = metric + ("-" + band if band else "")
        input_path = root / "pairs-archive" / (label + ".jsonl.gz")
        output_label = metric + "-archive" + ("-" + band if band else "")
        plain_prediction = predictions / (output_label + "-v1.jsonl")
        compressed_prediction = plain_prediction.with_suffix(".jsonl.gz")
        report = evidence / (output_label + "-report-v1.json")
        receipt = report.with_suffix(".receipt.json")
        stages.append(
            Stage(
                name="fit-" + label,
                command=(
                    python,
                    str(runtime / "run_moisture_research.py"),
                    metric,
                    str(input_path),
                    str(plain_prediction),
                    str(report),
                ),
                inputs=(input_path,),
                outputs=(compressed_prediction, report, receipt),
            )
        )
        add_verifier(
            metric, (input_path,), compressed_prediction, report, receipt, band
        )
        reports.append(report)
    summary_outputs = (
        evidence / "research-summary.json",
        evidence / "research-summary.md",
    )
    production_reports = (evidence / "rain-production-report-v1.json",) + tuple(
        evidence / f"pressure-production-{band}-report-v1.json"
        for band in ("001-012", "013-024", "025-048", "049-072", "073-120", "121-168")
    )
    final_verification = evidence / "final-verification.json"
    command = (
        python,
        str(runtime / "run_moisture_continuation.py"),
        str(root),
        str(evidence),
        "--freeze",
        str(runtime / "continuation-freeze.json"),
    )
    stages.append(
        Stage(
            name="summarize",
            command=command + ("--action", "summarize"),
            inputs=tuple(reports) + production_reports + (acquisition_summary,),
            outputs=summary_outputs,
        )
    )
    stages.append(
        Stage(
            name="final-verification",
            command=command + ("--action", "verify"),
            inputs=tuple(verifications)
            + tuple(reports)
            + summary_outputs
            + (
                evidence / "production-recovery-verification.json",
                acquisition_verification,
            ),
            outputs=(final_verification,),
            pass_receipts=(final_verification,),
        )
    )
    retention_receipt = evidence / "retention-receipt.json"
    retained_directories = tuple(
        root / name
        for name in (
            "acquisition",
            "production-moisture",
            "targets",
            "pairs-production",
            "pairs-archive",
            "humidity",
            "predictions",
            "runtime-sources",
        )
    )
    stages.append(
        Stage(
            name="retain",
            command=(
                python,
                str(runtime / "retain_moisture_research.py"),
                str(root),
                str(evidence),
            ),
            inputs=retained_directories
            + tuple(verifications)
            + tuple(reports)
            + production_reports
            + summary_outputs
            + (
                final_verification,
                acquisition_summary,
                acquisition_verification,
                evidence / "production-recovery-verification.json",
            ),
            outputs=(retention_receipt,),
            pass_receipts=(retention_receipt,),
        )
    )
    completion = evidence / "completion.json"
    stages.append(
        Stage(
            name="complete",
            command=command + ("--action", "complete"),
            inputs=(retention_receipt, final_verification, evidence / "research-summary.json"),
            outputs=(completion,),
            pass_receipts=(completion,),
        )
    )
    return stages


# publish aggregate results without selecting winners or combining source cohorts
def summarize(evidence):
    humidity = json.loads((evidence / "humidity-all-source-report.json").read_text())
    rain = json.loads((evidence / "rain-archive-report-v1.json").read_text())
    pressure = {
        band: json.loads(
            (evidence / f"pressure-archive-{band}-report-v1.json").read_text()
        )
        for band in ("001-012", "013-024", "025-048")
    }
    production_rain = json.loads(
        (evidence / "rain-production-report-v1.json").read_text()
    )
    production_pressure = {
        band: json.loads(
            (evidence / f"pressure-production-{band}-report-v1.json").read_text()
        )
        for band in ("001-012", "013-024", "025-048", "049-072", "073-120", "121-168")
    }
    summary = {
        "researchOnly": True,
        "productionEligible": False,
        "acquisition": json.loads((evidence / "acquisition-summary.json").read_text()),
        "humidity": humidity,
        "rain": rain,
        "pressure": pressure,
        "productionRain": production_rain,
        "productionPressure": production_pressure,
    }
    write_json(evidence / "research-summary.json", summary)
    lines = [
        "# Short-lead moisture research",
        "",
        "Retrospective research only; no model is qualified or deployed.",
        "",
        "Sources and native/transfer populations remain separate. Missing data and unsupported cells retain their reported status.",
        "",
        "## Humidity: complete-month native results",
        "",
        "| Source / lead band | Dates | Raw MAE (pp) | Ridge MAE (pp) |",
        "| --- | ---: | ---: | ---: |",
    ]
    # prioritize the first twelve hours without omitting longer bands
    for key, score in sorted(
        humidity["completeMonths"]["groups"]["cohortLeadBand"].items()
    ):
        values = score["predictions"]
        lines.append(
            f"| {key} | {score['dates']} | {values['raw']['equalDateMaePercentagePoints']:.4f} | {values['ridge']['equalDateMaePercentagePoints']:.4f} |"
        )
    lines += [
        "",
        "## Rain: complete-month native results",
        "",
        "| Source / lead band | Dates | Raw MAE (mm) | Hurdle MAE (mm) | Raw wet detection | Hurdle wet detection |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    # report wet detection alongside dry-hour-dominated error
    for cohort, result in sorted(
        {
            **production_rain["completeMonths"],
            **{
                name: value
                for name, value in rain["completeMonths"].items()
                if value["byLeadBand"]
            },
        }.items()
    ):
        # leave unsupported populations absent rather than inventing scores
        for band, score in sorted(result["byLeadBand"].items()):
            raw, hurdle = score["candidates"]["raw"], score["candidates"]["hurdle"]
            lines.append(
                f"| {cohort} / {band} | {score['dates']} | {raw['maeMm']:.5f} | {hurdle['maeMm']:.5f} | {raw['thresholds']['0.1']['POD']} | {hurdle['thresholds']['0.1']['POD']} |"
            )
    lines += [
        "",
        "## Pressure: complete-month native results",
        "",
        "| Source / lead band | Station/date cells | Raw MAE (hPa) | Offset MAE (hPa) | Ridge MAE (hPa) |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    # distinguish reference alignment from incremental model skill
    for band, report in pressure.items():
        # retain station/date weighting separately for each source
        for cohort, score in sorted(report["completeMonths"]["byCohort"].items()):
            values = score["predictions"]
            lines.append(
                f"| {cohort} / {band} | {score['dates']} | {values['raw']['equalStationDateMaeHpa']:.4f} | {values['stationOffset']['equalStationDateMaeHpa']:.4f} | {values['ridge']['equalStationDateMaeHpa']:.4f} |"
            )
    # retain all completed production partitions alongside short-lead archive results
    for band, report in production_pressure.items():
        # avoid pooling station references or source populations
        for cohort, score in sorted(report["completeMonths"]["byCohort"].items()):
            values = score["predictions"]
            lines.append(
                f"| {cohort} / {band} | {score['dates']} | {values['raw']['equalStationDateMaeHpa']:.4f} | {values['stationOffset']['equalStationDateMaeHpa']:.4f} | {values['ridge']['equalStationDateMaeHpa']:.4f} |"
            )
    lines += [
        "",
        "Full seasonal, partial-September, support, accumulation, tendency, and non-refit transfer results remain in `research-summary.json`.",
        "Model deployment requires a separate qualification decision.",
        "",
    ]
    with (evidence / "research-summary.md").open("x") as stream:
        stream.write("\n".join(lines))


# require all independent native and transfer verifiers before final retention
def finalize_verification(evidence):
    names = [
        "production-recovery-verification.json",
        "acquisition-verification.json",
        "archive-humidity-verification.json",
        "archive-rain-verification.json",
    ] + [
        f"archive-pressure-{band}-verification.json"
        for band in ("001-012", "013-024", "025-048")
    ]
    hashes = {}
    # reject absent or failed evidence rather than weakening the final gate
    for name in names:
        path = evidence / name
        # require every independent receipt to pass
        if json.loads(path.read_text()).get("verdict") != "PASS":
            raise ValueError("independent verification incomplete: " + name)
        hashes[name] = artifact_hash(path)
    write_json(
        evidence / "final-verification.json",
        {
            "verdict": "PASS",
            "scope": "all frozen research populations, not production qualification",
            "productionEligible": False,
            "fullExperimentComplete": False,
            "verifiedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "verificationFiles": hashes,
        },
    )


# declare completion only after exact encrypted roundtrip and remote checksum verification
def finalize_completion(evidence):
    require_pass(
        Stage(name="final-verification", command=(), inputs=(), outputs=(), pass_receipts=(evidence / "final-verification.json",))
    )
    receipt = json.loads((evidence / "retention-receipt.json").read_text())
    # distinguish locally saved evidence from completed encrypted delivery
    if (
        receipt.get("verdict") != "PASS"
        or receipt.get("encryptedRoundtripVerified") is not True
        or receipt.get("remoteCipherChecksumVerified") is not True
    ):
        raise ValueError("encrypted retention has not completed")
    archive = Path(receipt["localEncryptedDirectory"]) / receipt["archive"]
    # bind completion to the retained ciphertext still present on disk
    if artifact_hash(archive) != receipt["cipherSha256"]:
        raise ValueError("retained archive changed")
    write_json(
        evidence / "completion.json",
        {
            "verdict": "PASS",
            "fullExperimentComplete": True,
            "researchOnly": True,
            "productionQualifiedOrDeployed": False,
            "completedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "retentionReceiptSha256": artifact_hash(
                evidence / "retention-receipt.json"
            ),
            "summarySha256": artifact_hash(evidence / "research-summary.json"),
            "liveForecastUrl": "https://weather.ballydidean.farm/forecast",
        },
    )


# expose one research-only continuation entry point
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("private_root", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("--freeze", required=True, type=Path)
    parser.add_argument("--action", choices=("summarize", "verify", "complete"))
    args = parser.parse_args()
    os.umask(0o077)
    root = validate_private_root(args.private_root)
    evidence = args.evidence.absolute()
    # keep status output inside an existing owned private evidence directory
    if (
        evidence.resolve() != evidence
        or not evidence.is_dir()
        or evidence.stat().st_uid != os.getuid()
        or evidence.stat().st_mode & 0o077
    ):
        raise ValueError("private evidence directory required")
    runtime = Path(__file__).resolve().parent
    # keep the manifest alongside its frozen implementation
    if (
        args.freeze.absolute() != runtime / "continuation-freeze.json"
        or args.freeze.is_symlink()
    ):
        raise ValueError("continuation freeze must be the adjacent regular manifest")
    freeze = json.loads(args.freeze.read_text())
    freeze_hash = digest(args.freeze)
    verify_snapshot(runtime, root, evidence, freeze)
    # internal reporting actions remain behind the same immutable-source gate
    if args.action is not None:
        actions = {
            "summarize": summarize,
            "verify": finalize_verification,
            "complete": finalize_completion,
        }
        actions[args.action](evidence)
        return
    # prevent overlapping invocations from sharing model output paths
    descriptor = os.open(
        evidence / "analysis.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        # revalidate the manifest itself as well as every bound artifact
        def verify():
            # reject changes to the loaded plan during execution
            if artifact_hash(args.freeze) != freeze_hash:
                raise ValueError("continuation freeze changed during execution")
            verify_snapshot(runtime, root, evidence, freeze)

        verify()
        stages = build_stages(root, evidence, runtime)
        run_stages(stages, evidence, freeze_hash, verify_freeze=verify)


# imports never start research or access production
if __name__ == "__main__":
    main()
