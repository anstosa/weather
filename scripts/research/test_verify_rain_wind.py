"""synthetic checks for independent wind-source and vector model replay."""

import copy
import datetime as dt
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import verify_rain_wind as verify


# construct one original issued forecast and its context profiles
def original_profiles():
    initialized = dt.datetime(2026, 5, 12, tzinfo=dt.timezone.utc)
    hour = int(initialized.timestamp() // 3600)
    original = {
        "initialized": "2026-05-12T00:00:00Z",
        "run": "2026-05-12T00:00",
        "grid": (47.97891, -122.44185),
    }
    rain = np.arange(1, 49, dtype=np.float64) / 10
    wind = np.full(48, 4.0, dtype=np.float64)
    return original, hour, {hour: {"rain": rain}}, {hour: {"wind": wind}}


# retain forty-eight no-label wind supplement rows in original lead order
def supplement_rows(original, context, hour):
    initialized = dt.datetime.fromisoformat(original["initialized"].replace("Z", "+00:00"))
    rows = []
    # each source lead has one exact original-run identity
    for lead in range(1, 49):
        rows.append(
            {
                "cohort": "ecmwf_single_run_hindcast",
                "key": f'ecmwf_single_run_hindcast|{original["run"]}|lead={lead}',
                "runInitializedAt": original["initialized"],
                "validAt": (initialized + dt.timedelta(hours=lead)).strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "targetLeadHours": lead,
                "rawPrecipitationMm": float(context[hour]["rain"][lead - 1]),
                "rawWindDirectionDegrees": 360.0 if lead == 9 else 90.0,
                "directionSourceStatus": "available",
                "returnedGrid": {
                    "latitude": original["grid"][0],
                    "longitude": original["grid"][1],
                },
                "responseSha256": "a" * 64,
                "responseReceivedAtUtc": "2026-09-13T06:00:00Z",
                "actualIssueAt": None,
            }
        )
    return rows


# write complete source bytes before recalculating their exact digest
def write_rows(path, rows):
    path.write_bytes(b"".join(verify.direction_audit.canonical_json(row) for row in rows))
    return verify.sha(path)


# exercise only source and feature paths without observed labels
class IndependentWindTests(unittest.TestCase):
    # all source rows retain one run, correct rain and nullable directions
    def test_source_join_and_nullable_direction(self):
        original, hour, context, trajectory = original_profiles()
        rows = supplement_rows(original, context, hour)
        rows[8]["rawWindDirectionDegrees"] = None
        rows[8]["directionSourceStatus"] = "providerNull"
        # isolate source bytes from any producer or acquisition process
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "direction.jsonl"
            digest = write_rows(path, rows)
            # shrink only the synthetic corpus cardinality
            with patch.object(verify, "SOURCE_RUNS", 1), patch.object(
                verify, "SOURCE_ROWS", 48
            ):
                profiles = verify.load_directions(
                    path, digest, [original], context, trajectory
                )
            self.assertEqual(set(profiles), {hour})
            self.assertTrue(np.isnan(profiles[hour]["direction"][8]))
            np.testing.assert_array_equal(profiles[hour]["wind"], trajectory[hour]["wind"])

    # rehashed malformed rows still fail semantic source-to-original parity
    def test_source_tamper_regressions(self):
        original, hour, context, trajectory = original_profiles()
        baseline = supplement_rows(original, context, hour)
        mutations = (
            lambda rows: rows[8].update(rawPrecipitationMm=9.0),
            lambda rows: rows[8].update(rawWindDirectionDegrees=361.0),
            lambda rows: rows[8].update(targetLeadHours=8),
            lambda rows: rows[8].update(runInitializedAt="2026-05-12T06:00:00Z"),
            lambda rows: rows[8].update(responseSha256="b" * 64),
            lambda rows: rows[8].update(returnedGrid={"latitude": 47, "longitude": -122}),
            lambda rows: rows[8].update(directionSourceStatus="notRequested"),
            lambda rows: rows[8].update(directionSourceStatus="providerNull"),
        )
        # test changed content even when its declared checksum is updated
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "direction.jsonl"
            # isolate each mutation from the valid original forecast
            for mutation in mutations:
                rows = copy.deepcopy(baseline)
                mutation(rows)
                digest = write_rows(path, rows)
                # reject every rehashed identity or physical measurement change
                with self.subTest(mutation=mutation), patch.object(
                    verify, "SOURCE_RUNS", 1
                ), patch.object(verify, "SOURCE_ROWS", 48), self.assertRaises(ValueError):
                    verify.load_directions(path, digest, [original], context, trajectory)

    # short and unresolved source statuses preserve every original rain row
    def test_short_and_unresolved_status_patterns(self):
        original, hour, context, trajectory = original_profiles()
        rows = supplement_rows(original, context, hour)
        # the short HTTP response has no new direction after lead thirty-four
        for row in rows[34:]:
            row["rawWindDirectionDegrees"] = None
            row["directionSourceStatus"] = "notRequested"
        # keep short-run fixtures outside retained source trees
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "direction.jsonl"
            digest = write_rows(path, rows)
            # shrink only synthetic corpus cardinality
            with patch.object(verify, "SOURCE_RUNS", 1), patch.object(verify, "SOURCE_ROWS", 48):
                result = verify.load_directions(path, digest, [original], context, trajectory)
            self.assertTrue(np.isnan(result[hour]["direction"][34:]).all())
            # a transport-unresolved run is unknown at every source lead
            for row in rows:
                row["rawWindDirectionDegrees"] = None
                row["directionSourceStatus"] = "transportUnresolved"
            digest = write_rows(path, rows)
            # keep the unresolved case on the same one-run synthetic population
            with patch.object(verify, "SOURCE_RUNS", 1), patch.object(verify, "SOURCE_ROWS", 48):
                result = verify.load_directions(path, digest, [original], context, trajectory)
            self.assertTrue(np.isnan(result[hour]["direction"]).all())
            rows[9]["directionSourceStatus"] = "providerNull"
            digest = write_rows(path, rows)
            # one mixed unresolved/provider row cannot be silently accepted
            with patch.object(verify, "SOURCE_RUNS", 1), patch.object(verify, "SOURCE_ROWS", 48), self.assertRaises(ValueError):
                verify.load_directions(path, digest, [original], context, trajectory)

    # calculate wind-from vectors and tendencies before float32 projection
    def test_six_vector_columns_and_missing_direction(self):
        _, hour, _, trajectory = original_profiles()
        wind = trajectory[hour]["wind"]
        wind[5], wind[8], wind[11] = 2.0, 4.0, 6.0
        directions = np.full(48, 90.0, dtype=np.float64)
        directions[5], directions[8], directions[11] = 0.0, 90.0, 180.0
        profiles = {hour: {"wind": wind, "direction": directions}}
        names = [f"name{index}" for index in range(77)]
        names[14] = "rawWind"
        full101 = np.zeros((2, 101), dtype=np.float32)
        full101[0, 14] = 4.0
        full101[1, 14] = 4.0
        data = {
            "initialized": np.array([hour, hour], dtype=np.int64),
            "lead": np.array([1, 1], dtype=np.int64),
            "hour": np.array([hour + 9, hour + 9], dtype=np.int64),
        }
        extended, flags = verify.build_wind(data, full101, profiles, names)
        self.assertEqual(extended.shape, (2, 107))
        np.testing.assert_array_equal(extended[:, :101], full101)
        expected = np.asarray(
            [
                *verify.components(4.0, 90.0),
                verify.components(4.0, 90.0)[0] - verify.components(2.0, 0.0)[0],
                verify.components(4.0, 90.0)[1] - verify.components(2.0, 0.0)[1],
                verify.components(6.0, 180.0)[0] - verify.components(4.0, 90.0)[0],
                verify.components(6.0, 180.0)[1] - verify.components(4.0, 90.0)[1],
            ],
            dtype=np.float32,
        )
        np.testing.assert_array_equal(extended[0, 101:], expected)
        np.testing.assert_array_equal(flags["windVectorAvailable"], [True, True])
        self.assertNotIn("actual", data)
        self.assertEqual(verify.components(5.0, 360.0), verify.components(5.0, 0.0))
        profiles[hour]["direction"][8] = np.nan
        profiles[hour]["wind"][8] = 0.0
        full101[:, 14] = 0.0
        missing, flags = verify.build_wind(data, full101, profiles, names)
        self.assertTrue(np.isnan(missing[:, 101:]).all())
        np.testing.assert_array_equal(flags["windVectorAvailable"], [False, False])

    # never substitute another initialized forecast for an absent run
    def test_missing_or_misaligned_run_fails(self):
        _, hour, _, trajectory = original_profiles()
        names = [f"name{index}" for index in range(77)]
        names[14] = "rawWind"
        full = np.zeros((1, 101), dtype=np.float32)
        data = {
            "initialized": np.array([hour]),
            "lead": np.array([1]),
            "hour": np.array([hour + 9]),
        }
        # require the same issued run to be present
        with self.assertRaises(ValueError):
            verify.build_wind(data, full, {}, names)
        profiles = {hour: {"wind": trajectory[hour]["wind"], "direction": np.zeros(48)}}
        data["hour"][0] += 1
        # reject a shifted target hour even with a valid profile
        with self.assertRaises(ValueError):
            verify.build_wind(data, full, profiles, names)

    # reject changed source keys and keep exactly fourteen registered arms
    def test_schema_and_source_hour(self):
        self.assertEqual(len(verify.WIND_NAMES), 6)
        self.assertEqual(len(verify.ARMS), 14)
        self.assertEqual(verify.ARMS[-2:], ("trajectoryOriginal", "hurdleWind"))
        self.assertEqual(verify.source_hour("2026-05-12T00:00:00Z"), 494040)
        # reject noncanonical initialization timestamps
        with self.assertRaises(ValueError):
            verify.source_hour("2026-05-12T00:00:00+00:00")

    # retain failed V3 status while accepting only independently qualified V4
    def test_v4_source_proof_preserves_failed_parent_and_new_counts(self):
        proof = {
            "contractVersion": "rain-wind-continuation-verification/v1", "verdict": "PASS",
            "sourceQualified": True, "parentSourceQualified": False,
            "parentTransportPolicyConformant": False, "inheritedSpacingViolationCount": 25,
            "uniqueRepresentedRuns": 3301, "uniqueSuccessfulRuns": 3301,
            "inheritedFullResponses": 113, "inheritedShortResponses": 1600,
            "newSuccessfulRuns": 1588, "newUnresolvedRuns": 0,
            "parentHttpAttempts": 1716, "newHttpAttempts": 1588, "totalHttpAttempts": 3304,
            "normalizedRows": 158448, "responseLineageRows": 3301,
            "historicalAsIssuedVerified": False, "freshHoldoutVerified": False,
            "modelGatesEvaluated": False, "productionEligible": False,
            "verifierSourceSha256": verify.sha(verify.source_audit.__file__),
        }
        report = {
            "contractVersion": "rain-wind-continuation/v1", "status": "complete",
            "sourceQualified": True, "parentSourceQualified": False,
            "parentTransportPolicyConformant": False, "inheritedSpacingViolationCount": 25,
            "newUnresolvedRuns": 0,
            "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 0, "qualified": True}},
        }
        self.assertEqual(verify.check_source_result(proof, report)["perMonthCoverage"], report["perMonthCoverage"])
        # false qualification, laundered parent and changed union counts are fatal
        for key, value in (("sourceQualified", False), ("parentSourceQualified", True), ("parentTransportPolicyConformant", True), ("inheritedSpacingViolationCount", 0), ("inheritedFullResponses", 114), ("inheritedShortResponses", 1599), ("newSuccessfulRuns", 1587), ("newUnresolvedRuns", 1), ("newHttpAttempts", 3177), ("totalHttpAttempts", 3303), ("modelGatesEvaluated", True)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                verify.check_source_result({**proof, key: value}, report)
        # an unqualified month cannot be hidden by an overall source pass
        with self.assertRaises(ValueError):
            verify.check_source_result(proof, {**report, "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 2, "qualified": False}}})

    # a two-round native smoke refit must retain exact 107-column booster bytes
    def test_native_refit_uses_wind_schema_and_weighted_wet_head(self):
        names = verify.POLICY["featureNames"]
        self.assertEqual(len(names), 107)
        hours = np.asarray(
            [24 * day + hour for day in range(24) for hour in range(10)],
            dtype=np.int64,
        )
        actual = np.asarray([3.0 if index % 10 < 5 else 0.0 for index in range(240)])
        features = np.zeros((len(hours), 107), dtype=np.float32)
        features[:, 0] = np.arange(len(hours), dtype=np.float32) % 23
        # save each real booster at the deterministic native state path
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "wind-models/2026-01"
            directory.mkdir(parents=True)
            original_train = verify.xgb.train
            files = ["event-0.1.json", "event-1.0.json", "event-2.5.json", "amount.json"]
            calls = []

            # retain the trained model under its expected objective file
            def save_native(*args, **kwargs):
                booster = original_train(*args, **kwargs)
                booster.save_model(directory / files[len(calls)])
                calls.append((kwargs["num_boost_round"], args[0]["objective"]))
                return booster

            # shorten only round count for synthetic native interface coverage
            with patch.object(verify, "ROUNDS", 2), patch.object(
                verify.xgb, "train", side_effect=save_native
            ):
                models, state = verify.refit_heads(
                    root, features, names, actual, hours, "2026-01"
                )
            self.assertEqual(state["rounds"], 2)
            self.assertEqual(len(calls), 4)
            self.assertEqual([objective for _, objective in calls], ["binary:logistic"] * 3 + ["reg:gamma"])
            self.assertTrue(all(rounds == 2 for rounds, _ in calls))
            self.assertTrue(all(model.feature_names == names for model in models.values()))
            self.assertEqual(
                {head["modelFile"] for head in state["heads"].values()},
                set(files),
            )

    # matched controls retain exact parent bytes and all original decision rows
    def test_fourteen_arm_control_aliases_and_population(self):
        count = 32896
        indices = np.arange(count, dtype=np.int64)
        old = {
            "amount::" + name: np.full(count, index, dtype=np.float64)
            for index, name in enumerate(verify.ORIGINAL_ARMS)
        }
        old["amount::hurdleOriginal"] = np.full(count, 12.0)
        old["amount::hurdleTrajectory"] = np.full(count, 13.0)
        # create a no-label parent prediction artifact only
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "inputs/trajectory"
            directory.mkdir(parents=True)
            np.savez_compressed(directory / "predictions.npz", indices=indices, **old)
            mask = np.ones(count, dtype=bool)

            # isolate the month partition while exercising the actual alias replay
            with patch.object(verify, "MONTHS", ("2026-01",)), patch.object(
                verify, "month_masks", return_value=(None, None, mask, None)
            ), patch.object(
                verify,
                "replay_month",
                return_value=(indices, np.full(count, 14.0), {"supported": True}),
            ):
                rows, amounts, flags, states = verify.replay_all(
                    root, {}, np.empty((count, 107), dtype=np.float32), [], {}
                )
            np.testing.assert_array_equal(rows, indices)
            self.assertEqual(set(amounts), set(verify.ARMS))
            self.assertEqual(len(amounts), 14)
            self.assertTrue(flags.all())
            self.assertEqual(set(states), {"2026-01"})
            # original ordinal remains the fallback and both parent aliases stay distinct
            np.testing.assert_array_equal(amounts["ordinal90"], old["amount::ordinal90"])
            np.testing.assert_array_equal(amounts["hurdleOriginal"], old["amount::hurdleOriginal"])
            np.testing.assert_array_equal(
                amounts["trajectoryOriginal"], old["amount::hurdleTrajectory"]
            )
            self.assertTrue(np.all(amounts[verify.PRIMARY] == 14.0))

    # independently reconstructed source coverage enters the fixed-gate report
    def test_report_binds_source_coverage_and_all_gates(self):
        source = {
            "normalizedSha256": "a" * 64,
            "newUnresolvedRuns": 1,
            "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 1, "qualified": True}},
        }
        data = {
            "hour": np.asarray([24, 25], dtype=np.int64),
            "mean": np.asarray([0.1, 1.0], dtype=np.float64),
        }
        indices = np.asarray([0, 1], dtype=np.int64)
        amounts = {name: np.asarray([0.1, 1.0], dtype=np.float64) for name in verify.ARMS}
        states = {"2024-05": {"model": {"heads": {"0.1": {"modelFile": "event-0.1.json"}}}}}
        availability = {"windVectorAvailable": np.asarray([True, False])}
        screen = {"gates": {f"gate{index}": True for index in range(49)}, "passed": False}
        # isolate report assembly from scoring, not from new source provenance
        with tempfile.TemporaryDirectory() as temporary, patch.object(verify.goal, "recomputed_scores", return_value={"overall": {}}), patch.object(verify.goal, "gate_view", return_value={}), patch.object(verify.goal, "independent_gate", return_value=screen), patch.object(verify, "metrics", return_value={}), patch.object(verify, "sha", return_value="b" * 64):
            report = verify.expected_report(Path(temporary), data, {}, indices, amounts, np.asarray([True, True]), states, availability, source)
        self.assertEqual(report["directionSourceCoverage"], {"unresolvedRuns": 1, "perMonthCoverage": source["perMonthCoverage"]})
        self.assertEqual(report["directionSourceSha256"], source["normalizedSha256"])
        self.assertEqual(len(report["candidateScreen"]["gates"]), 49)
        self.assertIsNone(report["selectedCandidate"])
        self.assertEqual(report["nativeModelsFit"], 1)

    # a copied source proof cannot replace the full recovery snapshot replay
    def test_continuation_snapshot_proof_binding(self):
        parent = (
            Path.home()
            / ".weather/research-work/weather-moisture-research-rain-trajectory-20260913-v1"
        )
        names = verify.POLICY["featureNames"][:77]
        proof = {
            "contractVersion": "rain-wind-continuation-verification/v1",
            "verdict": "PASS",
            "sourceQualified": True,
            "parentSourceQualified": False,
            "parentTransportPolicyConformant": False,
            "inheritedSpacingViolationCount": 25,
            "uniqueRepresentedRuns": 3301,
            "newUnresolvedRuns": 0,
            "uniqueSuccessfulRuns": 3301,
            "inheritedFullResponses": 113,
            "inheritedShortResponses": 1600,
            "newSuccessfulRuns": 1588,
            "parentHttpAttempts": 1716,
            "newHttpAttempts": 1588,
            "totalHttpAttempts": 3304,
            "normalizedRows": 158448,
            "responseLineageRows": 3301,
            "historicalAsIssuedVerified": False,
            "freshHoldoutVerified": False,
            "modelGatesEvaluated": False,
            "productionEligible": False,
            "verifierSourceSha256": verify.sha(verify.source_audit.__file__),
            "verifiedAtUtc": "2026-09-13T07:00:00Z",
        }
        # use pinned prior-control files without touching their original bytes
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "wind-sources").mkdir()
            (root / "inputs/trajectory/final-evidence").mkdir(parents=True)
            (root / "inputs/direction/final-evidence").mkdir(parents=True)
            (root / "freeze.json").write_text("{}\n")
            inputs = {}
            # retain only pinned parent controls for the synthetic proof
            for source_name, target in (
                ("trajectory-freeze.json", "trajectory-freeze.json"),
                ("report.json", "inputs/trajectory/report.json"),
                ("predictions.npz", "inputs/trajectory/predictions.npz"),
                (
                    "final-evidence/independent-verification-final.json",
                    "inputs/trajectory/final-evidence/independent-verification-final.json",
                ),
            ):
                destination = root / target
                shutil.copyfile(parent / source_name, destination)
                inputs[target] = verify.sha(destination)
            sources = {}
            # snapshot only live source bytes needed for the fake freeze boundary
            # retain only named source copies in the synthetic freeze
            for name in verify.SOURCE_FILES:
                current = Path(verify.__file__).with_name(name)
                saved = root / "wind-sources" / name
                shutil.copyfile(current, saved)
                sources[name] = verify.sha(current)
            freeze = {
                "policy": verify.POLICY,
                "featureNames": names,
                "contextFeatureNames": verify.POLICY["featureNames"],
                "inputSchemaFreezeSha256": verify.sha(root / "freeze.json"),
                "parentFreezeSha256": verify.POLICY["parentPins"]["trajectory-freeze.json"],
                "newCandidateOutcomesRead": False,
                "priorOutcomesAlreadyKnown": True,
                "productionWrites": False,
                "sourceSha256": sources,
                "inputSha256": inputs,
            }
            (root / "wind-freeze.json").write_text(json.dumps(freeze))
            # bind a complete V4 source receipt to frozen report and output bytes
            (root / "inputs/direction/wind-continuation-freeze.json").write_text("{}\n")
            (root / "inputs/direction/normalized").mkdir()
            (root / "inputs/direction/normalized/ecmwf_single_run_wind_direction.jsonl").write_text("source\n")
            (root / "inputs/direction/response-lineage.jsonl").write_text("lineage\n")
            source_report = {
                "contractVersion": "rain-wind-continuation/v1", "status": "complete",
                "sourceQualified": True, "parentSourceQualified": False,
                "parentTransportPolicyConformant": False, "inheritedSpacingViolationCount": 25,
                "newUnresolvedRuns": 0,
                "perMonthCoverage": {"2024-05": {"totalRuns": 100, "unresolvedRuns": 0, "qualified": True}},
            }
            (root / "inputs/direction/report.json").write_text(json.dumps(source_report))
            proof.update({
                "reportSha256": verify.sha(root / "inputs/direction/report.json"),
                "freezeSha256": verify.sha(root / "inputs/direction/wind-continuation-freeze.json"),
                "normalizedSha256": verify.sha(root / "inputs/direction/normalized/ecmwf_single_run_wind_direction.jsonl"),
                "responseLineageSha256": verify.sha(root / "inputs/direction/response-lineage.jsonl"),
            })
            copied_proof = (
                root / "inputs/direction/final-evidence/independent-verification.json"
            )
            copied_proof.write_text(json.dumps(proof))
            replayed = {**proof, "verifiedAtUtc": "2026-09-13T07:10:00Z"}
            # the independent snapshot result must match every copied proof value
            with patch.object(verify, "check_trajectory_freeze", return_value=({}, {})), patch.object(
                verify.source_audit, "audit_snapshot", return_value=replayed
            ) as audit:
                verify.check_freeze(root, names)
                audit.assert_called_once_with(root / "inputs/direction")
                proof["normalizedRows"] = 48
                copied_proof.write_text(json.dumps(proof))
                # reject a copied receipt that reassigns source row coverage
                with self.assertRaises(ValueError):
                    verify.check_freeze(root, names)


# run only local synthetic and mocked native checks
if __name__ == "__main__":
    unittest.main()
