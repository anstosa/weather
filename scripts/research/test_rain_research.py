"""Synthetic causal and metric checks for rainfall research."""

import datetime as dt
import unittest

import numpy as np
import rain_research as rain


# construct a synthetic model-ready rain forecast
def row(day=0, hour=0, lead=12, cohort='ecmwf_single_run_hindcast', actual=0.2, raw=0.4):
    valid = dt.datetime(2024, 1, 1, 12, tzinfo=dt.timezone.utc) + dt.timedelta(days=day, hours=hour)
    return {'key': f'{cohort}|{day}|{hour}|{lead}', 'cohort': cohort, 'validAt': rain.shared.format_instant(valid), 'referenceAt': rain.shared.format_instant(valid - dt.timedelta(hours=lead)), 'targetLeadHours': lead, 'rawRelativeHumidityPercent': 80, 'rawTemperatureC': 10, 'rawWindSpeedMps': 2, 'rawCloudCoverPercent': 80, 'actualPrecipitationMm': actual, 'rawPrecipitationMm': raw, 'liquidOnly': True}


# lock chronological boundaries and rain-specific failure controls
class RainTests(unittest.TestCase):
    # leave every unsupported row raw except the explicit zero control
    def test_cold_start(self):
        model = rain.fit([row()], '2025-01', 'ecmwf_single_run_hindcast', '001-012')
        result = rain.predict(row(), model)
        self.assertFalse(model['supported'])
        self.assertEqual(result['raw'], result['hurdle'])
        self.assertEqual(result['raw'], result['volumeScale'])
        self.assertEqual(result['zero'], 0)

    # prevent future labels or other providers changing a source fit
    def test_fit_is_chronological_and_cohort_isolated(self):
        rows = [row(day, hour) for day in range(200) for hour in range(6)]
        baseline = rain.fit(rows, '2025-01', 'ecmwf_single_run_hindcast', '001-012')
        contaminated = rows + [row(500, actual=100), row(1, cohort='best_match_single_run_transfer', actual=100)]
        actual = rain.fit(contaminated, '2025-01', 'ecmwf_single_run_hindcast', '001-012')
        self.assertEqual(actual, baseline)
        self.assertTrue(actual['hurdleSupported'])
        self.assertLess(rain.predict(row(), actual)['hurdle'], 0.4)

    # a zero model cannot win wet detection merely by exploiting dry hours
    def test_wet_metrics_detect_zero_failure(self):
        rows = [row(day, actual=0 if day < 9 else 2, raw=0 if day < 9 else 1) for day in range(10)]
        # process each selected item
        for value in rows:
            value['predictions'] = {'raw': value['rawPrecipitationMm'], 'zero': 0, 'volumeScale': value['rawPrecipitationMm'], 'hurdle': value['rawPrecipitationMm'], 'wetProbability': float(value['rawPrecipitationMm'] > 0)}
        score = rain.score(rows)['candidates']
        self.assertEqual(score['raw']['thresholds']['0.1']['POD'], 1)
        self.assertEqual(score['zero']['thresholds']['0.1']['POD'], 0)
        self.assertEqual(score['zero']['observedWetMaeMm'], 2)
        self.assertEqual(score['zero']['volumeRatio'], 0)
        self.assertEqual(rain.score(rows)['hurdleSupportedRows'], 0)
        self.assertIn('cold_fallback', score['hurdle']['brierReference'])
        self.assertIsNone(score['hurdle']['hurdleSupportedPairedWetBrier'])

    # missing accumulation hours cannot become synthetic dry hours
    def test_accumulation_requires_same_run_contiguous_hours(self):
        rows = [row(hour=hour, lead=hour + 1) for hour in range(5)]
        # process each selected item
        for value in rows:
            value['predictions'] = {candidate: 0.3 for candidate in rain.CANDIDATES}
        self.assertEqual(rain.accumulation(rows)['3']['rows'], 3)
        rows.pop(2)
        self.assertEqual(rain.accumulation(rows)['3']['rows'], 0)

    # keep source state binding explicit during non-refit transfer
    def test_transfer_source_binding(self):
        value = row(800, cohort='best_match_single_run_transfer')
        month = rain.shared.issue_month(value)
        model = rain.fit([], month, 'ecmwf_single_run_hindcast', '001-012')
        self.assertEqual(rain.predict_transfer(value, model)['raw'], value['rawPrecipitationMm'])
        with self.assertRaises(ValueError):
            rain.predict_transfer(value, {**model, 'cohort': 'fixed_lead_anchor'})
        with self.assertRaises(ValueError):
            rain.predict_transfer(value, {**model, 'leadBand': '013-024'})

    # observed rain is unavailable to the feature path
    def test_features_are_forecast_only(self):
        original = row()
        poisoned = {**original, 'actualPrecipitationMm': object()}
        np.testing.assert_array_equal(rain.features(original), rain.features(poisoned))

    # reject nonliquid labels and nonphysical forecast covariates
    def test_validate_enforces_target_and_covariate_contract(self):
        cases = [
            {**row(), 'liquidOnly': False},
            {**row(), 'rawTemperatureC': 71},
            {**row(), 'rawWindSpeedMps': -1},
            {**row(), 'rawCloudCoverPercent': float('nan')},
            {**row(), 'rawCloudCoverPercent': 101},
        ]
        # reject each malformed contract independently
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                rain.validate(value)

    # reject nonfinite optional sensitivity targets before scoring
    def test_validate_enforces_optional_target_contract(self):
        for field in ('shiftMinus5MinutesMm', 'gaugeMeanPrecipitationMm'):
            # reject one malformed alternative target at a time
            with self.subTest(field=field), self.assertRaises(ValueError):
                rain.validate({**row(), field: float('nan')})


# run synthetic tests only
if __name__ == '__main__':
    unittest.main()
