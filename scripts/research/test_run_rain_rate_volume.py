"""lock frozen continuation reporting and inherited baseline populations."""

import copy
import datetime as dt
import gzip
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import run_rain_rate_volume as run
from test_run_rain_rate_research import event


# bind synthetic native rows to their own out-of-sample model identities
def baseline(day=370, hour=0, raw=1, actual=1, supported=True):
    value = event(day=day, hour=hour, raw=raw, actual=actual)
    month = run.scoring.shared.issue_month(value)
    value.update({
        'recordKind': 'native', 'modelSupported': supported,
        'modelIdentity': [month, value['cohort'], run.scoring.shared.lead_band(value)],
        'trainingCutoffUtc': run.scoring.shared.format_instant(run.scoring.shared.month_start(month) - dt.timedelta(hours=168)),
    })
    value['predictions']['tweedieBlend'] = actual if supported else raw
    value['predictions']['intensityGuard'] = run.scoring.model.intensity_guard(raw, value['predictions']['tweedieBlend'])
    return value


# construct report-only challenger records without changing the baseline
def extended(**kwargs):
    value = baseline(**kwargs)
    value['predictions'].update({name: value['rawPrecipitationMm'] for name in run.NEW_CANDIDATES})
    value['candidateSupported'] = {name: True for name in run.volume.CANDIDATES}
    value['calibrationReasons'] = {name: 'applied' for name in run.NEW_CANDIDATES}
    return value


# keep all scores comparable and freeze conservative artifact handling
class VolumeRunnerTests(unittest.TestCase):
    # use global balancing weights rather than category-specific denominators
    def test_category_volume_uses_global_weights(self):
        first = extended(day=370, raw=0, actual=2)
        second = extended(day=371, raw=1, actual=6)
        rows = [first, copy.deepcopy(first), copy.deepcopy(first), second]
        categories = run.category_volume(rows)
        self.assertAlmostEqual(categories['zero']['weightMass'], .5)
        self.assertAlmostEqual(categories['zero']['observedMeanContributionMmPerHour'], 1)
        self.assertAlmostEqual(categories['zero']['observedVolumeShare'], .25)
        self.assertAlmostEqual(categories['heavy1']['observedMeanContributionMmPerHour'], 3)
        self.assertAlmostEqual(sum(value['observedVolumeShare'] for value in categories.values()), 1)
        self.assertEqual(categories['zero']['predictedMeanContributionMmPerHour']['volumeCalibratedGuard'], 0)

    # keep empty and dry populations explicit rather than inventing ratios
    def test_category_boundaries_and_empty_population(self):
        self.assertEqual([run.raw_category(value) for value in (0, .01, .1, 1, 2.5)], list(run.RAW_CATEGORIES))
        self.assertTrue(all(value['observedVolumeShare'] is None for value in run.category_volume([]).values()))
        self.assertEqual(run.continuation_screen(run.scoring.score([])), {})

    # stronger requirements cannot replace or relax the original event gates
    def test_continuation_requires_all_three_checks(self):
        candidates = {name: {'maeMmPerHour': .97, 'volumeRatio': .9} for name in run.volume.CANDIDATES}
        candidates['raw'] = {'maeMmPerHour': 1, 'volumeRatio': .8}
        candidates['intensityGuard'] = {'maeMmPerHour': .9, 'volumeRatio': .6}
        summary = {'candidates': candidates}
        existing = {name: {'passesDevelopmentScreen': True} for name in run.NEW_CANDIDATES}
        with patch.object(run.scoring, 'screen', return_value=existing):
            self.assertTrue(run.continuation_screen(summary)['volumeCalibratedGuard']['passesContinuationScreen'])
            candidates['volumeCalibratedGuard']['maeMmPerHour'] = .981
            self.assertFalse(run.continuation_screen(summary)['volumeCalibratedGuard']['passesContinuationScreen'])
            candidates['volumeCalibratedGuard']['maeMmPerHour'] = .97
            candidates['volumeCalibratedGuard']['volumeRatio'] = .6
            self.assertFalse(run.continuation_screen(summary)['volumeCalibratedGuard']['passesContinuationScreen'])
            candidates['volumeCalibratedGuard']['volumeRatio'] = .9
            existing['volumeCalibratedGuard']['passesDevelopmentScreen'] = False
            self.assertFalse(run.continuation_screen(summary)['volumeCalibratedGuard']['passesContinuationScreen'])

    # the calibration stage preserves every row and every original prediction
    def test_cold_start_replay_preserves_baseline_and_support(self):
        rows = [baseline(raw=0, actual=2), baseline(day=371, raw=2, actual=1), baseline(day=372, raw=3, actual=2, supported=False)]
        original = copy.deepcopy(rows)
        with TemporaryDirectory() as temporary:
            output = Path(temporary)
            report = run.evaluate(rows, output, 'baseline-receipt')
            with gzip.open(output / 'predictions.jsonl.gz', 'rt') as stream:
                predictions = [json.loads(line) for line in stream]
            self.assertEqual(report['predictionRows'], len(rows))
            self.assertEqual(rows, original)
            self.assertEqual({row['key'] for row in predictions}, {row['key'] for row in rows})
            by_key = {row['key']: row for row in original}
            # check inherited scores and exact candidate-specific fallback provenance
            for row in predictions:
                source = by_key[row['key']]
                self.assertEqual({name: row['predictions'][name] for name in run.scoring.model.CANDIDATES}, source['predictions'])
                for name in run.NEW_CANDIDATES:
                    self.assertEqual(row['predictions'][name], source['rawPrecipitationMm'])
                    self.assertFalse(row['candidateSupported'][name])
                    self.assertEqual(row['calibrationReasons'][name], 'insufficient_support' if source['modelSupported'] else 'base_model_unsupported')
            summary = report['periods']['completeMonths']['native']['ecmwf_single_run_hindcast']['overall']
            self.assertEqual(summary['supportByCandidate']['volumeCalibratedGuard']['rows'], 0)
            self.assertEqual(summary['candidates']['raw'], run.scoring.score(original)['candidates']['raw'])

    # reject duplicate or transfer rows before writing partial state outputs
    def test_replay_rejects_changed_population(self):
        value = baseline()
        with TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, 'unique native'):
                run.evaluate([value, value], Path(temporary), 'baseline')
            with self.assertRaisesRegex(ValueError, 'unique native'):
                run.evaluate([{**value, 'recordKind': 'transfer'}], Path(temporary), 'baseline')
            self.assertEqual(list(Path(temporary).iterdir()), [])

    # hashes and full-refit evidence must both bind the inherited artifact set
    def test_baseline_receipt_binding_and_tampering(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'sources').mkdir()
            (directory / 'input.jsonl.gz').write_bytes(b'fixture')
            (directory / 'sources' / 'fixture.py').write_text('# fixture\n')
            source_hash = run.scoring.digest(directory / 'sources' / 'fixture.py')
            input_hash = run.scoring.digest(directory / 'input.jsonl.gz')
            freeze = {'policy': {'contractVersion': 'rain-rate-tweedie-research/v1'}, 'sourceSha256': {'fixture.py': source_hash}, 'inputSha256': input_hash}
            run.scoring.write_json(directory / 'freeze.json', freeze)
            files = {'input.jsonl.gz': input_hash, 'sources/fixture.py': source_hash, 'freeze.json': run.scoring.digest(directory / 'freeze.json')}
            run.scoring.write_json(directory / 'receipt.json', {'files': files})
            verification = {'verified': True, 'fullDeterministicRefit': True, 'productionEligible': False, 'accuracyQualification': False, 'retainedReceiptSha256': run.scoring.digest(directory / 'receipt.json'), 'inputSha256': input_hash}
            verification_path = directory / 'verification.json'
            verification_path.write_text(json.dumps(verification))
            self.assertEqual(set(run.verify_baseline(directory, verification_path)), {*files, 'receipt.json'})
            verification['fullDeterministicRefit'] = False
            verification_path.write_text(json.dumps(verification))
            with self.assertRaisesRegex(ValueError, 'full-refit'):
                run.verify_baseline(directory, verification_path)
            verification['fullDeterministicRefit'] = True
            verification_path.write_text(json.dumps(verification))
            (directory / 'input.jsonl.gz').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                run.verify_baseline(directory, verification_path)


# importing the test helpers never starts a research run
if __name__ == '__main__':
    unittest.main()
