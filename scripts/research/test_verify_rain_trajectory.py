"""synthetic checks for independent forecast-tendency verification."""

import datetime as dt
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from verify_rain_trajectory import (
    ARMS,
    TENDENCY_NAMES,
    build_tendencies,
    load_tendencies,
    measurement,
)


# construct no-label paired inputs for one issued forecast run
def paired_profile():
    names = [f"feature{index}" for index in range(77)]
    names[10:13] = ["rawHumidity", "rawCloud", "rawWind"]
    full = np.zeros((2, 95), dtype=np.float32)
    humidity = np.arange(48, dtype=float) + 50
    cloud = np.arange(48, dtype=float) * 2 + 10
    wind = np.arange(48, dtype=float) * 0.5 + 1
    full[0, 10:13] = [humidity[8], cloud[8], wind[8]]
    data = {
        "initialized": np.array([0, 10]),
        "lead": np.array([1, 1]),
        "hour": np.array([9, 19]),
    }
    return data, full, names, {0: {"humidity": humidity, "cloud": cloud, "wind": wind}}


class IndependentTrajectoryTests(unittest.TestCase):
    # calculate source float64 differences before casting six columns
    def test_six_same_run_differences_and_missing_run(self):
        data, full, names, profiles = paired_profile()
        extended, available = build_tendencies(data, full, profiles, names)
        self.assertEqual(extended.shape, (2, 101))
        np.testing.assert_array_equal(extended[:, :95], full)
        np.testing.assert_allclose(extended[0, 95:], [3.0, 3.0, 6.0, 6.0, 1.5, 1.5])
        self.assertTrue(np.isnan(extended[1, 95:]).all())
        np.testing.assert_array_equal(available["tendencyAvailable"], [True, False])
        self.assertNotIn("actual", data)

    # reject source-to-paired covariate drift before native fitting
    def test_current_source_must_match_paired_float32(self):
        data, full, names, profiles = paired_profile()
        full[0, 10] = 0
        with self.assertRaises(ValueError):
            build_tendencies(data, full, profiles, names)
        full[0, 10] = np.nan
        profiles[0]["humidity"][8] = np.nan
        extended, availability = build_tendencies(data, full, profiles, names)
        self.assertTrue(np.isnan(extended[0, 95:97]).all())
        self.assertFalse(availability["tendencyAvailable"][0])

    # require bounded numeric source fields but retain explicit nulls
    def test_measurement_bounds_and_nulls(self):
        self.assertTrue(np.isnan(measurement({"value": None}, "value", 0.0, 100.0)))
        self.assertEqual(measurement({"value": 50}, "value", 0.0, 100.0), 50.0)
        # reject each nonnumeric or out-of-range source value
        for value in (-1, 101, True, "5"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                measurement({"value": value}, "value", 0.0, 100.0)
        with self.assertRaises(KeyError):
            measurement({}, "value", 0.0, 100.0)

    # bind every row to exactly one complete 48-lead issued run
    def test_source_profile_requires_complete_unique_leads(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "source.jsonl"
            rows = []
            beginning = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
            # keep all forty-eight valid times physically ordered
            for lead in range(1, 49):
                rows.append(
                    {
                        "runInitializedAt": "2025-01-01T00:00:00Z",
                        "validAt": (beginning + dt.timedelta(hours=lead))
                        .isoformat()
                        .replace("+00:00", "Z"),
                        "targetLeadHours": lead,
                        "rawRelativeHumidityPercent": 50,
                        "rawCloudCoverPercent": 25,
                        "rawWindSpeedMps": 2,
                    }
                )
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            initialized = int(beginning.timestamp() // 3600)
            cohort = {
                "rows": 48,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            profile = load_tendencies(path, {initialized: {}}, cohort)
            self.assertEqual(len(profile), 1)
            self.assertEqual(profile[initialized]["humidity"].shape, (48,))
            rows[-1]["targetLeadHours"] = 47
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            cohort["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            with self.assertRaises(ValueError):
                load_tendencies(path, {initialized: {}}, cohort)

    # preserve exactly thirteen arms with one new selectable primary
    def test_candidate_schema(self):
        self.assertEqual(len(ARMS), 13)
        self.assertEqual(ARMS[-2:], ("hurdleOriginal", "hurdleTrajectory"))
        self.assertEqual(len(TENDENCY_NAMES), 6)


# run only the synthetic verifier regression suite
if __name__ == "__main__":
    unittest.main()
