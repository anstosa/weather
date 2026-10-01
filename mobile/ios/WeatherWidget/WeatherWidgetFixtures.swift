import Foundation

#if DEBUG
enum WeatherWidgetFixtures {
    // return the requested deterministic scenario
    static func fixture(for scenario: WeatherWidgetScenario) -> WeatherWidgetFixture {
        switch scenario {
        case .maximumDensity:
            return maximumDensity
        case .nearCutoff:
            return nearCutoff
        case .bedtime:
            return bedtime
        }
    }

    private static let maximumDensity = WeatherWidgetFixture(
        scenario: .maximumDensity,
        generatedAt: date("2026-11-01T07:00:00Z"),
        groups: [
            group(0, [0, 1, 2], "12a · 1a D/S", -3.0, -1.0, .dry, accessibilityTimeLabel: "12 a.m., 1 a.m. daylight, and 1 a.m. standard"),
            group(1, [3, 4, 5], "2–4a", -2.0, 0.0, .sprinkle),
            group(2, [6, 7, 8], "5–7a", -1.0, 2.0, .rain),
            group(3, [9, 10, 11], "8–10a", 2.0, 4.0, .dry),
            group(4, [12, 13, 14], "11a–1p", 4.0, 6.0, .sprinkle),
            group(5, [15, 16, 17], "2–4p", 5.0, 7.0, .rain),
            group(6, [18, 19, 20], "5–7p", 3.0, 5.0, .dry)
        ],
        sunsetLabel: "Sunset 5:52p",
        statusLabel: "7:42a · adjusted",
        bedtimeMessage: nil
    )

    private static let nearCutoff = WeatherWidgetFixture(
        scenario: .nearCutoff,
        generatedAt: date("2026-09-20T01:30:00Z"),
        groups: [
            group(0, [0], "7p", 11.0, 11.0, .sprinkle)
        ],
        sunsetLabel: "Sunset 7:08p",
        statusLabel: "6:30p · adjusted",
        bedtimeMessage: "go to bed"
    )

    private static let bedtime = WeatherWidgetFixture(
        scenario: .bedtime,
        generatedAt: date("2026-09-20T04:00:00Z"),
        groups: [],
        sunsetLabel: "Sunset 7:08p",
        statusLabel: "9:00p · day complete",
        bedtimeMessage: "go to bed"
    )

    // create one bounded group
    private static func group(
        _ id: Int,
        _ intervals: [Int],
        _ label: String,
        _ minimum: Double,
        _ maximum: Double,
        _ condition: WeatherCondition,
        accessibilityTimeLabel: String? = nil
    ) -> WeatherHourGroup {
        WeatherHourGroup(
            id: id,
            intervalIndexes: intervals,
            timeLabel: label,
            accessibilityTimeLabel: accessibilityTimeLabel ?? label,
            minimumTemperatureCelsius: minimum,
            maximumTemperatureCelsius: maximum,
            condition: condition
        )
    }

    // parse fixed fixture timestamps
    private static func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }
}
#endif
