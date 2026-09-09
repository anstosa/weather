"""Synthetic checks for the research-only continuation gate."""

import json
import tempfile
import unittest
from pathlib import Path

import run_moisture_continuation as continuation


# exercise the stage journal without models, network or production
class ContinuationTests(unittest.TestCase):
    # reject altered journal contracts without rewriting them as completed research
    def test_rejects_unsafe_or_malformed_journal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "analysis-status.json"
            baseline = {
                "contractVersion": "moisture-research-continuation/v1",
                "productionEligible": False,
                "freezeSha256": "freeze",
                "completedStages": [],
                "status": "running",
            }
            # check each independent schema violation
            for change in (
                {"contractVersion": "wrong"},
                {"productionEligible": True},
                {"completedStages": {}},
                {"status": "unknown"},
            ):
                path.write_text(json.dumps({**baseline, **change}))
                before = path.read_bytes()
                with self.assertRaisesRegex(
                    ValueError, "invalid research continuation journal"
                ):
                    continuation.run_stages([], root, "freeze")
                self.assertEqual(path.read_bytes(), before)
            baseline.pop("status")
            path.write_text(json.dumps(baseline))
            with self.assertRaisesRegex(
                ValueError, "invalid research continuation journal"
            ):
                continuation.run_stages([], root, "freeze")

    # preserve ordering and revalidate completed stages on resume
    def test_sequential_run_and_verified_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input"
            source.write_text("frozen input")
            first, second = root / "first.json", root / "second.json"
            stages = [
                continuation.Stage(name="first", command=("python", "first"), inputs=(source,), outputs=(first,)),
                continuation.Stage(name="second", command=("python", "second"), inputs=(first,), outputs=(second,)),
            ]
            seen = []

            # publish only the current stage's declared output
            def execute(stage, log):
                seen.append(stage.name)
                self.assertTrue(all(path.exists() for path in stage.inputs))
                stage.outputs[0].write_text('{"verdict":"PASS"}')

            continuation.run_stages(stages, root, "freeze", execute)
            self.assertEqual(seen, ["first", "second"])
            continuation.run_stages(stages, root, "freeze", execute)
            self.assertEqual(seen, ["first", "second"])
            first.write_text("tampered")
            with self.assertRaises(ValueError):
                continuation.run_stages(stages, root, "freeze", execute)
            self.assertEqual(seen, ["first", "second"])

    # stop after a failure without publishing a completion claim
    def test_failure_stops_downstream_and_keeps_partial_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "partial"
            stages = [continuation.Stage(name="fit", command=("python", "fit"), inputs=(), outputs=(output,))]

            # simulate an interrupted model writer
            def fail(stage, log):
                output.write_text("partial")
                raise RuntimeError("fit failed")

            with self.assertRaises(RuntimeError):
                continuation.run_stages(stages, root, "freeze", fail)
            state = json.loads((root / "analysis-status.json").read_text())
            self.assertEqual(state["status"], "failed")
            self.assertEqual(state["completedStages"], [])
            with self.assertRaises(ValueError):
                continuation.run_stages(stages, root, "freeze", fail)
            self.assertEqual(output.read_text(), "partial")

    # a successful process without its promised output is not a successful stage
    def test_missing_output_and_changed_freeze_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = continuation.Stage(
                name="verify", command=("python", "verify"), inputs=(), outputs=(root / "receipt",)
            )
            with self.assertRaises(ValueError):
                continuation.run_stages(
                    [stage], root, "freeze", lambda stage, log: None
                )
            with self.assertRaises(ValueError):
                continuation.run_stages(
                    [stage], root, "different-freeze", lambda stage, log: None
                )

    # include filenames as well as bytes when binding a stage directory
    def test_directory_identity_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "one").write_text("same bytes")
            original = continuation.artifact_hash(root)
            (root / "one").rename(root / "two")
            self.assertNotEqual(continuation.artifact_hash(root), original)
            (root / "linked").symlink_to(root / "two")
            with self.assertRaises(ValueError):
                continuation.artifact_hash(root)

    # a verifier must publish an explicit pass rather than merely exit successfully
    def test_failed_verdict_cannot_complete_stage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "verification.json"
            stage = continuation.Stage(
                name="verify", command=("python", "verify"), inputs=(), outputs=(output,), pass_receipts=(output,)
            )

            # simulate a verifier that reports failure with exit zero
            def execute(stage, log):
                output.write_text('{"verdict":"FAIL"}')

            with self.assertRaises(ValueError):
                continuation.run_stages([stage], root, "freeze", execute)

    # preserve the complete bounded graph and restart without repeated fits
    def test_full_stage_graph_with_synthetic_artifacts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root, evidence, runtime = (
                base / name for name in ("private", "evidence", "runtime")
            )
            # create isolated synthetic stage roots
            for directory in (root, evidence, runtime):
                directory.mkdir()
            stages = continuation.build_stages(root, evidence, runtime)
            seen = []
            directory_names = {
                "acquisition",
                "targets",
                "pairs-archive",
                "pairs-production",
                "humidity",
                "predictions",
                "runtime-sources",
            }

            # materialize one path with the declared file or directory shape
            def materialize(path):
                # keep generated pair sets directory-shaped
                if path.name in directory_names:
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text('{"verdict":"PASS"}')

            outputs = {path for stage in stages for path in stage.outputs}
            # initialize only prerequisites not produced by an earlier stage
            for stage in stages:
                for path in stage.inputs:
                    if (
                        path not in outputs
                        and not any(parent in outputs for parent in path.parents)
                        and not path.exists()
                    ):
                        materialize(path)

            # stand in for external commands without fitting models or retaining data
            def execute(stage, log):
                seen.append(stage.name)
                # publish each declared artifact only after its inputs were checked
                for path in stage.outputs:
                    materialize(path)
                # populate the files that the archive pair stage promises
                if stage.name == "pair-rain-pressure":
                    for name in (
                        "rain",
                        "pressure-001-012",
                        "pressure-013-024",
                        "pressure-025-048",
                    ):
                        materialize(root / "pairs-archive" / (name + ".jsonl.gz"))

            state = continuation.run_stages(
                stages, evidence, "synthetic-freeze", execute
            )
            self.assertEqual(state["status"], "complete")
            self.assertEqual(
                seen[:3], ["verify-acquisition", "pair-humidity", "pair-rain-pressure"]
            )
            self.assertEqual(seen[-3:], ["final-verification", "retain", "complete"])
            self.assertEqual(sum(name.startswith("fit-") for name in seen), 5)
            self.assertEqual(sum(name.startswith("verify-") for name in seen), 6)
            continuation.run_stages(stages, evidence, "synthetic-freeze", execute)
            self.assertEqual(len(seen), len(stages))

    # require the exact root identities and literal member hashes
    def test_snapshot_contract_and_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.write_text("frozen")
            freeze = {
                "contractVersion": "moisture-research-continuation-freeze/v1",
                "privateRoot": str(root),
                "evidenceRoot": str(root),
                **{
                    name: {"source": continuation.digest(source)}
                    for name in ("runtimeFiles", "privateInputs", "evidenceFiles")
                },
            }
            continuation.verify_snapshot(root, root, root, freeze)
            source.write_text("changed")
            with self.assertRaisesRegex(ValueError, "artifact changed"):
                continuation.verify_snapshot(root, root, root, freeze)
            freeze["runtimeFiles"] = {"../outside": "a" * 64}
            with self.assertRaisesRegex(ValueError, "invalid frozen"):
                continuation.verify_snapshot(root, root, root, freeze)

    # never publish final completion after only local checkpoint retention
    def test_completion_requires_full_remote_retention_and_final_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "final-verification.json").write_text('{"verdict":"PASS"}')
            receipt = {
                "verdict": "PASS",
                "encryptedRoundtripVerified": True,
                "remoteCipherChecksumVerified": False,
            }
            (root / "retention-receipt.json").write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, "retention has not completed"):
                continuation.finalize_completion(root)
            self.assertFalse((root / "completion.json").exists())
            (root / "final-verification.json").write_text('{"verdict":"FAIL"}')
            with self.assertRaisesRegex(ValueError, "verification did not pass"):
                continuation.finalize_completion(root)

    # failure of any required independent population blocks retention
    def test_final_verification_requires_all_independent_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "production-recovery-verification.json").write_text(
                '{"verdict":"PASS"}'
            )
            (root / "acquisition-verification.json").write_text('{"verdict":"FAIL"}')
            with self.assertRaisesRegex(ValueError, "verification incomplete"):
                continuation.finalize_verification(root)
            self.assertFalse((root / "final-verification.json").exists())


# run only synthetic unit tests
if __name__ == "__main__":
    unittest.main()
