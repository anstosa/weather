import Foundation

#if DEBUG
enum WeatherWidgetDebugFixtures {
    // decode one embedded frozen shared snapshot
    static func fixture(named name: String) throws -> (snapshot: WeatherWidgetSnapshot, now: Date, unit: TemperatureUnit) {
        guard let payload = payloads[name], let expected = expectations[name] else {
            throw WeatherWidgetContractError.invalid("debug-fixture")
        }
        return (
            try WeatherWidgetSnapshotDecoder().decode(payload),
            expected.now,
            expected.unit
        )
    }

    private struct Expectation {
        let now: Date
        let unit: TemperatureUnit
    }

    private static let expectations: [String: Expectation] = [
        "adjusted-standard": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-09-12T07:00:01.000Z")!,
            unit: .fahrenheit
        ),
        "fall-back-25": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-11-01T07:30:00.000Z")!,
            unit: .fahrenheit
        ),
        "midnight-race": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-09-12T07:00:01.000Z")!,
            unit: .fahrenheit
        ),
        "missing-raw-at-expiry": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-09-12T16:00:00.000Z")!,
            unit: .celsius
        ),
        "spring-forward-23": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-03-08T08:15:00.000Z")!,
            unit: .celsius
        ),
        "stale-old-source": Expectation(
            now: WeatherWidgetDateCodec.date(from: "2026-09-12T07:00:01.000Z")!,
            unit: .fahrenheit
        ),
    ]

    private static let payloads: [String: Data] = [
        "adjusted-standard": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-09-13T03:00:00.000Z",
    "date": "2026-09-12",
    "dayEnd": "2026-09-13T07:00:00.000Z",
    "dayStart": "2026-09-12T07:00:00.000Z",
    "sunset": "2026-09-13T02:27:49.262Z"
  },
  "generatedAt": "2026-09-12T07:00:00.000Z",
  "hours": [
    {
      "end": "2026-09-12T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0,
        "selectedSource": {
          "runAt": "2026-09-11T22:00:00.000Z",
          "receivedAt": "2026-09-12T05:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T07:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 15.555555555555555,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 15.555555555555555,
        "selectedSource": {
          "runAt": "2026-09-12T00:00:00.000Z",
          "receivedAt": "2026-09-12T01:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T08:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 17.22222222222222,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 17.22222222222222,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T02:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 2.500001,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 2.500001,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T09:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 16.11111111111111,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 16.11111111111111,
        "selectedSource": {
          "runAt": "2026-09-12T02:00:00.000Z",
          "receivedAt": "2026-09-12T03:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.000001,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.000001,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T10:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 1.5,
        "selectedSource": {
          "runAt": "2026-09-12T03:00:00.000Z",
          "receivedAt": "2026-09-12T04:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 2.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 2.5,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T11:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -1.5,
        "selectedSource": {
          "runAt": "2026-09-12T04:00:00.000Z",
          "receivedAt": "2026-09-12T05:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 2.500001,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 2.500001,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T12:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -0.5,
        "selectedSource": {
          "runAt": "2026-09-12T05:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 12,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T13:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.07,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T14:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.08,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T15:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.09,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T16:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T17:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.11,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T18:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.12,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T19:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.13,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T20:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.14,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T21:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-12T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T22:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.16,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-12T23:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -1.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.17,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T00:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": -0.5,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.18,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T01:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 2.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.19,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T02:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 3.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T03:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 0.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.21,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T04:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": -0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 1.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.22,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T05:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 0.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 2.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    },
    {
      "end": "2026-09-13T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "adjusted",
        "raw": 0.23,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "rain_adjustment",
        "selected": 0.23,
        "selectedSource": {
          "runAt": "2026-09-11T23:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      },
      "start": "2026-09-13T06:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 1.5,
        "rawSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "generic_adjustment",
        "selected": 3.5,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "selectedUntil": "2026-09-12T08:30:00.000Z"
      }
    }
  ],
  "receivedAt": "2026-09-12T07:00:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "adjusted"
}
"""#.utf8),
        "fall-back-25": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-11-02T04:00:00.000Z",
    "date": "2026-11-01",
    "dayEnd": "2026-11-02T08:00:00.000Z",
    "dayStart": "2026-11-01T07:00:00.000Z",
    "sunset": "2026-11-02T00:50:59.571Z"
  },
  "generatedAt": "2026-11-01T07:00:00.000Z",
  "hours": [
    {
      "end": "2026-11-01T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T07:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.01,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.01,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T08:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.1,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.02,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.02,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T09:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.2,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.03,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.03,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T10:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.3,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.04,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.04,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T11:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.4,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T12:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.5,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.06,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.06,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T13:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.6,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.07,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T14:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.7,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.08,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T15:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.8,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.09,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T16:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.9,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T17:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.11,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T18:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.1,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.12,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T19:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.2,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.13,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T20:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.3,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.14,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T21:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.4,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-01T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T22:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.5,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.16,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-01T23:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.6,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.17,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T00:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.7,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.18,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T01:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.8,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.19,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T02:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.9,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T03:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.21,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T04:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.1,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.22,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T05:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.2,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.23,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.23,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T06:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.3,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-11-02T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.24,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.24,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-11-02T07:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.4,
        "rawSource": {
          "runAt": "2026-11-01T01:00:00.000Z",
          "receivedAt": "2026-11-01T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    }
  ],
  "receivedAt": "2026-11-01T07:00:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "raw"
}
"""#.utf8),
        "midnight-race": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-09-12T03:00:00.000Z",
    "date": "2026-09-11",
    "dayEnd": "2026-09-12T07:00:00.000Z",
    "dayStart": "2026-09-11T07:00:00.000Z",
    "sunset": "2026-09-12T02:29:53.056Z"
  },
  "generatedAt": "2026-09-12T06:59:59.000Z",
  "hours": [
    {
      "end": "2026-09-11T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T07:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.01,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.01,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T08:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.1,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.02,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.02,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T09:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.2,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.03,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.03,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T10:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.3,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.04,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.04,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T11:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.4,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T12:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.5,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.06,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.06,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T13:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.6,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.07,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T14:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.7,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.08,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T15:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.8,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.09,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T16:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.9,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T17:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.11,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T18:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.1,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.12,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T19:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.2,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.13,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T20:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.3,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.14,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T21:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.4,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-11T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T22:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.5,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.16,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-11T23:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.6,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.17,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T00:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.7,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.18,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T01:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.8,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.19,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T02:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.9,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T03:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.21,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T04:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.1,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.22,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T05:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.2,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.23,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.23,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T06:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.3,
        "rawSource": {
          "runAt": "2026-09-12T00:59:59.000Z",
          "receivedAt": "2026-09-12T06:54:59.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    }
  ],
  "receivedAt": "2026-09-12T07:00:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "raw"
}
"""#.utf8),
        "missing-raw-at-expiry": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-09-13T03:00:00.000Z",
    "date": "2026-09-12",
    "dayEnd": "2026-09-13T07:00:00.000Z",
    "dayStart": "2026-09-12T07:00:00.000Z",
    "sunset": "2026-09-13T02:27:49.262Z"
  },
  "generatedAt": "2026-09-12T15:15:00.000Z",
  "hours": [
    {
      "end": "2026-09-12T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T07:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10,
        "selectedSource": {
          "runAt": "2026-09-12T00:00:00.000Z",
          "receivedAt": "2026-09-12T01:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.01,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.01,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T08:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.1,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.1,
        "selectedSource": {
          "runAt": "2026-09-12T01:00:00.000Z",
          "receivedAt": "2026-09-12T02:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.02,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.02,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T09:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.2,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.2,
        "selectedSource": {
          "runAt": "2026-09-12T02:00:00.000Z",
          "receivedAt": "2026-09-12T03:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.03,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.03,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T10:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.3,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.3,
        "selectedSource": {
          "runAt": "2026-09-12T03:00:00.000Z",
          "receivedAt": "2026-09-12T04:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.04,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.04,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T11:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.4,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.4,
        "selectedSource": {
          "runAt": "2026-09-12T04:00:00.000Z",
          "receivedAt": "2026-09-12T05:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T12:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.5,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.5,
        "selectedSource": {
          "runAt": "2026-09-12T05:00:00.000Z",
          "receivedAt": "2026-09-12T06:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.06,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.06,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T13:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.6,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.6,
        "selectedSource": {
          "runAt": "2026-09-12T06:00:00.000Z",
          "receivedAt": "2026-09-12T07:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.07,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T14:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.7,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.7,
        "selectedSource": {
          "runAt": "2026-09-12T07:00:00.000Z",
          "receivedAt": "2026-09-12T08:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.08,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T15:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 10.8,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 10.8,
        "selectedSource": {
          "runAt": "2026-09-12T08:00:00.000Z",
          "receivedAt": "2026-09-12T09:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.09,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T16:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": null,
        "rawSource": null,
        "reason": "independent_adjustment",
        "selected": 10,
        "selectedSource": {
          "runAt": "2026-09-12T09:00:00.000Z",
          "receivedAt": "2026-09-12T10:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T17:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11,
        "selectedSource": {
          "runAt": "2026-09-12T10:00:00.000Z",
          "receivedAt": "2026-09-12T11:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.11,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T18:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.1,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.1,
        "selectedSource": {
          "runAt": "2026-09-12T11:00:00.000Z",
          "receivedAt": "2026-09-12T12:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.12,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T19:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.2,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.2,
        "selectedSource": {
          "runAt": "2026-09-12T12:00:00.000Z",
          "receivedAt": "2026-09-12T13:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.13,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T20:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.3,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.3,
        "selectedSource": {
          "runAt": "2026-09-12T13:00:00.000Z",
          "receivedAt": "2026-09-12T14:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.14,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T21:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.4,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.4,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-12T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T22:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.5,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.5,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.16,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T23:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.6,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.6,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.17,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T00:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.7,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.7,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.18,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T01:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.8,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.8,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.19,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T02:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 11.9,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 11.9,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T03:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 12,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.21,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T04:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 12.1,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 12.1,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.22,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T05:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 12.2,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 12.2,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    },
    {
      "end": "2026-09-13T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.23,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.23,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T06:00:00.000Z",
      "temperatureC": {
        "mode": "adjusted",
        "raw": 12.3,
        "rawSource": {
          "runAt": "2026-09-12T09:15:00.000Z",
          "receivedAt": "2026-09-12T15:10:00.000Z"
        },
        "reason": "independent_adjustment",
        "selected": 12.3,
        "selectedSource": {
          "runAt": "2026-09-12T14:00:00.000Z",
          "receivedAt": "2026-09-12T15:00:00.000Z"
        },
        "selectedUntil": "2026-09-12T16:00:00.000Z"
      }
    }
  ],
  "receivedAt": "2026-09-12T15:15:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "mixed"
}
"""#.utf8),
        "spring-forward-23": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-03-09T03:00:00.000Z",
    "date": "2026-03-08",
    "dayEnd": "2026-03-09T07:00:00.000Z",
    "dayStart": "2026-03-08T08:00:00.000Z",
    "sunset": "2026-03-09T02:05:06.013Z"
  },
  "generatedAt": "2026-03-08T08:00:00.000Z",
  "hours": [
    {
      "end": "2026-03-08T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T08:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.01,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.01,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T09:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.1,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.02,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.02,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T10:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.2,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.03,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.03,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T11:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.3,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.04,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.04,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T12:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.4,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T13:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.5,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.06,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.06,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T14:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.6,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.07,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T15:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.7,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.08,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T16:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.8,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.09,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T17:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.9,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T18:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.11,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T19:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.1,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.12,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T20:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.2,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.13,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T21:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.3,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-08T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.14,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T22:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.4,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-08T23:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.5,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.16,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T00:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.6,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.17,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T01:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.7,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.18,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T02:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.8,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.19,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T03:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.9,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T04:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.21,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T05:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.1,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-03-09T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.22,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-03-09T06:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.2,
        "rawSource": {
          "runAt": "2026-03-08T02:00:00.000Z",
          "receivedAt": "2026-03-08T07:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    }
  ],
  "receivedAt": "2026-03-08T08:00:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "raw"
}
"""#.utf8),
        "stale-old-source": Data(#"""
{
  "attribution": {
    "label": "Open-Meteo · CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "providerUrl": "https://open-meteo.com/"
  },
  "calendar": {
    "cutoff": "2026-09-13T03:00:00.000Z",
    "date": "2026-09-12",
    "dayEnd": "2026-09-13T07:00:00.000Z",
    "dayStart": "2026-09-12T07:00:00.000Z",
    "sunset": "2026-09-13T02:27:49.262Z"
  },
  "generatedAt": "2026-09-12T07:00:00.000Z",
  "hours": [
    {
      "end": "2026-09-12T08:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T07:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T09:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.01,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.01,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T08:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.1,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T10:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.02,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.02,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T09:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.2,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T11:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.03,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.03,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T10:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.3,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T12:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.04,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.04,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T11:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.4,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T13:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T12:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.5,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T14:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.06,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.06,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T13:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.6,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T15:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.07,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.07,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T14:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.7,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T16:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.08,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.08,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T15:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.8,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T17:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.09,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.09,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T16:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 10.9,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 10.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T18:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T17:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T19:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.11,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.11,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T18:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.1,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T20:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.12,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.12,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T19:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.2,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T21:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.13,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.13,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T20:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.3,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T22:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.14,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.14,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T21:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.4,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.4,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-12T23:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T22:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.5,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.5,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T00:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.16,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.16,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-12T23:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.6,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.6,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T01:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.17,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.17,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T00:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.7,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.7,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T02:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.18,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.18,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T01:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.8,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.8,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T03:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.19,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.19,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T02:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 11.9,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 11.9,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T04:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T03:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T05:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.21,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.21,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T04:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.1,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.1,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T06:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.22,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.22,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T05:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.2,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.2,
        "selectedSource": null,
        "selectedUntil": null
      }
    },
    {
      "end": "2026-09-13T07:00:00.000Z",
      "rainMmPerHour": {
        "mode": "raw",
        "raw": 0.23,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 0.23,
        "selectedSource": null,
        "selectedUntil": null
      },
      "start": "2026-09-13T06:00:00.000Z",
      "temperatureC": {
        "mode": "raw",
        "raw": 12.3,
        "rawSource": {
          "runAt": "2026-09-11T18:00:00.000Z",
          "receivedAt": "2026-09-12T06:55:00.000Z"
        },
        "reason": "raw_forecast",
        "selected": 12.3,
        "selectedSource": null,
        "selectedUntil": null
      }
    }
  ],
  "receivedAt": "2026-09-12T07:00:01.000Z",
  "schemaVersion": "weather-widget/v1",
  "site": {
    "latitude": 47.950429954185445,
    "longitude": -122.42797012608193,
    "name": "Ballydidean",
    "slug": "ballydidean",
    "timezone": "America/Los_Angeles"
  },
  "status": "raw"
}
"""#.utf8),
    ]
}
#endif
