"""lock the separate rain archive scope and unchanged shared safety controls."""

import copy
import datetime as dt
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import acquire_rain_sub24 as run
from test_acquire_moisture_runs import response_bytes, valid_response


# validate bounded requests without contacting a provider
class RainAcquisitionTests(unittest.TestCase):
    # cover more than two years of initialized forecast history
    def test_exact_population(self):
        plan = run.plan()
        rows = run.identities(plan)
        self.assertEqual(len(rows), 3604)
        self.assertEqual(len({row['key'] for row in rows}), len(rows))
        self.assertEqual(rows[0]['run'], '2024-03-14T00:00')
        self.assertEqual(rows[-1]['run'], '2026-08-31T18:00')
        self.assertEqual({row['cohort'] for row in rows}, {run.COHORT})
        self.assertGreaterEqual((run.END - run.START).days, 730)

    # policy edits cannot enlarge scope or consume the older job's budget
    def test_policy_tampering_is_rejected(self):
        value = run.plan()
        for key, replacement in [('maximumAttempts',4800),('minimumGlobalStartSpacingMs',300),('productionWrites',True),('endpoint','https://example.com')]:
            changed = copy.deepcopy(value)
            changed[key] = replacement
            with self.assertRaises(ValueError):
                run.validate_plan(changed)

    # shared controller enforces this plan's lower cap and halt semantics
    def test_controller_stops_at_separate_limit(self):
        value = run.plan()
        stop = threading.Event()
        starts = [dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=10)] * value['maximumAttempts']
        controller = run.shared.AttemptController(value, starts, stop)
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(run.shared.AcquisitionError):
            controller.reserve(Path(temporary)/'attempt', {'key':'synthetic'})
        self.assertTrue(stop.is_set())
        self.assertEqual(controller.total_attempts, 3800)

    # keep the proven normalization and hourly precipitation semantics
    def test_normalizer_keeps_all_forecast_leads(self):
        value = run.plan()
        identity = run.identities(value)[0]
        rows, _metadata = run.shared.normalize_response(response_bytes(valid_response()), identity, value)
        self.assertEqual(len(rows),48)
        self.assertEqual([row['targetLeadHours'] for row in rows],list(range(1,49)))
        self.assertEqual(rows[0]['rawPrecipitationMm'],.1)
        self.assertIsNone(rows[0]['actualIssueAt'])

    # reject even dangling symlinks before creating acquisition descendants
    def test_rejects_child_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'acquisition').symlink_to(root / 'missing', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                run.private_child(root, 'acquisition')
            self.assertFalse((root / 'missing').exists())

    # keep the single-cohort manifest distinct from the older experiment
    def test_finalization_uses_only_new_contract_and_cohort(self):
        value = run.plan()
        population = run.identities(value)
        first = population[0]
        rows, metadata = run.shared.normalize_response(response_bytes(valid_response()), first, value)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan_path = root / 'plan.json'
            run.shared.write_json(plan_path, value)
            acquisition = root / 'acquisition'
            run_root = acquisition / 'runs' / run.COHORT / first['slug']
            run_root.mkdir(parents=True)
            data = '\n'.join(run.shared.canonical_json(row) for row in rows) + '\n'
            (run_root / 'rows.jsonl').write_text(data)
            receipt = {**first, 'status': 'success', 'normalizedPath': 'rows.jsonl',
                       'nullCountsSelectedLeads': metadata['nullCountsSelectedLeads']}
            controller = run.shared.AttemptController(value, [], threading.Event())
            with mock.patch.object(run.shared, 'verified_success', side_effect=[receipt] + [None] * 3603):
                manifest = run.finalize(plan_path, value, population, acquisition, {'synthetic': 'hash'}, controller)
            self.assertEqual(manifest['contractVersion'], run.CONTRACT)
            self.assertEqual(set(manifest['cohortFiles']), {run.COHORT})
            self.assertEqual(set(manifest['nullCountsSelectedLeads']), {run.COHORT})
            self.assertEqual(manifest['statusCounts'], {'success': 1, 'pending': 3603})
            self.assertEqual(manifest['cohortFiles'][run.COHORT]['rows'], 48)
            self.assertEqual((acquisition / manifest['cohortFiles'][run.COHORT]['path']).read_text(), data)

    # preserve the original acquisition policy rather than broadening its loader
    def test_old_plan_rejects_the_new_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'plan.json'
            run.shared.write_json(path,run.plan())
            with self.assertRaises(run.shared.AcquisitionError):
                run.shared.load_plan(path)


# run only synthetic local checks
if __name__ == '__main__':
    unittest.main()
