"""Synthetic regression checks for rain-rate scoring and development gates."""

import copy
import gzip
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import run_rain_rate_research as run
from test_rain_research import row


# bind synthetic forecasts to named candidate rates
def event(day=0, hour=0, actual=1, raw=1, lead=12):
    value = row(day=day, hour=hour, actual=actual, raw=raw, lead=lead)
    return {**value, 'modelSupported': True, 'liquidOnly': True,
            'predictions': {'raw': raw, 'zero': 0.0, 'tweedieBlend': actual, 'intensityGuard': raw}}


# preserve equal-date errors and no-missing-hour accumulation
class ScoringTests(unittest.TestCase):
    # lock the v1 default report before introducing optional candidate schemas
    def test_v1_default_summary_digest(self):
        rows = [event(day=0, actual=0, raw=0), event(day=1, actual=1, raw=.5), event(day=1, hour=1, actual=3, raw=2)]
        payload = json.dumps(run.summarize(rows), sort_keys=True, separators=(',', ':'), allow_nan=False)
        self.assertEqual(hashlib.sha256(payload.encode()).hexdigest(), '023ecc71cec4d2d7b889ab2d2e00a8fbdab89b5bd78f4a3461748fdbdec67b87')

    # optional candidate support cannot alter baseline metrics or hide sparse arms
    def test_extended_candidates_and_support(self):
        names = (*run.model.CANDIDATES, 'volumeGuard')
        rows = [event(day=day, actual=1, raw=2) for day in range(200)]
        original = run.score(rows)
        # keep identical forecast and target populations while adding one arm
        for index, value in enumerate(rows):
            value['predictions']['volumeGuard'] = 1
            value['candidateSupported'] = {name: name != 'volumeGuard' or index < 3 for name in names}
        summary = run.score(rows, candidates=names)
        self.assertEqual(summary['candidates']['raw'], original['candidates']['raw'])
        self.assertEqual(summary['supportByCandidate']['volumeGuard']['dates'], 3)
        self.assertFalse(run.screen(summary, names)['volumeGuard']['checks']['support'])
        self.assertEqual(run.summarize(rows, names)['ecmwf_single_run_hindcast']['overall'], summary)
        unsupported = {**original, 'supportedRows': 0}
        self.assertFalse(run.screen(unsupported)['tweedieBlend']['checks']['support'])

    # collapse repeated vintages before date averaging
    def test_date_hour_balancing(self):
        first = event(actual=1, raw=0)
        second = event(day=1, actual=3, raw=0)
        result = run.score([first, first, first, second])
        self.assertEqual(result['candidates']['raw']['maeMmPerHour'], 2)
        self.assertEqual(result['candidates']['tweedieBlend']['maeMmPerHour'], 0)
        self.assertEqual(result['hours'], 2)
        self.assertEqual(result['dates'], 2)

    # do not reward a dry-only control for missing storms
    def test_storm_detection_and_missing_gates(self):
        score = run.score([event(actual=2.0, raw=1.0)])
        self.assertEqual(score['candidates']['zero']['thresholds']['1.0']['POD'], 0)
        self.assertEqual(score['candidates']['raw']['thresholds']['1.0']['POD'], 1)
        self.assertFalse(run.screen(score)['tweedieBlend']['passesDevelopmentScreen'])
        self.assertFalse(run.screen(score)['tweedieBlend']['checks']['2.5:POD'])
        self.assertFalse(run.no_worse(float('nan'), 1))
        self.assertFalse(run.no_worse(1, None))

    # keep dry support explicit rather than inventing ratios or wet errors
    def test_empty_and_dry_scores(self):
        self.assertEqual(run.score([])['candidates'], {})
        self.assertEqual(run.screen(run.score([])), {})
        metrics = run.score([event(actual=0, raw=0)])['candidates']['raw']
        self.assertIsNone(metrics['volumeRatio'])
        self.assertIsNone(metrics['observedWetMaeMmPerHour'])
        self.assertIsNone(metrics['thresholds']['0.1']['FAR'])

    # totals require genuine matching references and every component hour
    def test_same_run_accumulation(self):
        events = [event(hour=hour, lead=hour + 1) for hour in range(5)]
        self.assertEqual(run.accumulations(events)['3']['rows'], 3)
        self.assertEqual(run.accumulations(events)['3']['candidates']['raw']['maeMm'], 0)
        self.assertEqual(run.accumulations(events)['6']['rows'], 0)
        del events[2]
        self.assertEqual(run.accumulations(events)['3']['rows'], 0)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            run.accumulations([events[0], events[0]])

    # anchors cannot become reconstructed same-initialization trajectories
    def test_anchor_has_no_accumulation(self):
        events = [{**event(hour=hour), 'referenceAt': None} for hour in range(6)]
        self.assertEqual(run.accumulations(events)['3']['rows'], 0)

    # changing the sensitivity target never changes model predictions
    def test_sensitivity_uses_unchanged_predictions(self):
        value = event(actual=1, raw=2)
        before = copy.deepcopy(value)
        value['gaugeMeanPrecipitationMm'] = 2
        summary = run.summarize([value])['ecmwf_single_run_hindcast']
        sensitivity = summary['networkMeanSensitivity']
        self.assertEqual(sensitivity['primary']['candidates']['raw']['maeMmPerHour'], 1)
        self.assertEqual(sensitivity['alternative']['candidates']['raw']['maeMmPerHour'], 0)
        self.assertEqual(value['predictions'], before['predictions'])

    # reject invalid rates and broken fallback contracts before scoring
    def test_predictions_fail_closed(self):
        value = event()
        run.validate_predictions(value, value['predictions'], True)
        with self.assertRaises(ValueError):
            run.validate_predictions(value, {**value['predictions'], 'unexpected': 1}, True)
        with self.assertRaises(ValueError):
            run.validate_predictions(value, {**value['predictions'], 'tweedieBlend': float('nan')}, True)
        with self.assertRaises(ValueError):
            run.validate_predictions(value, {**value['predictions'], 'tweedieBlend': 0}, False)
        with self.assertRaises(ValueError):
            run.validate_predictions(value, {**value['predictions'], 'intensityGuard': 0.5}, True)

    # retain unsupported predictions and split complete from partial dates
    def test_evaluate_writes_replay_material_and_keeps_periods_separate(self):
        values = [event(day=0), event(day=366), event(day=974)]
        with TemporaryDirectory() as directory:
            output = Path(directory)
            report = run.evaluate(values, output)
            with gzip.open(output / 'predictions.jsonl.gz', 'rt') as stream:
                predictions = [json.loads(line) for line in stream]
            self.assertEqual(len(predictions), 2)
            self.assertTrue(all(not value['modelSupported'] for value in predictions))
            self.assertTrue(all(value['predictions']['tweedieBlend'] == value['rawPrecipitationMm'] for value in predictions))
            self.assertEqual(report['periods']['completeMonths']['native']['ecmwf_single_run_hindcast']['overall']['rows'], 1)
            self.assertEqual(report['periods']['partialSeptember']['native']['ecmwf_single_run_hindcast']['overall']['rows'], 1)
            self.assertFalse(report['productionEligible'])
            self.assertTrue((output / 'models.jsonl.gz').exists())

    # evaluate rejects malformed input even when no date will be scored
    def test_duplicate_or_nonliquid_input_rejected(self):
        with TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                run.evaluate([event(), event()], Path(directory))
            with self.assertRaisesRegex(ValueError, 'non-liquid'):
                run.evaluate([{**event(), 'liquidOnly': False}], Path(directory))
            with self.assertRaisesRegex(ValueError, 'non-liquid'):
                run.evaluate([{**event(), 'liquidOnly': None}], Path(directory))


# direct invocation runs synthetic tests only
if __name__ == '__main__':
    unittest.main()
