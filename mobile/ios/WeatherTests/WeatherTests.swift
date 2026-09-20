import XCTest

final class WeatherNavigationPolicyTests: XCTestCase {
    // accept the canonical hosted origin
    func testCanonicalOriginStaysHosted() throws {
        let url = try XCTUnwrap(URL(string: "https://weather.ballydidean.farm/forecast"))
        XCTAssertEqual(WeatherNavigationPolicy.decision(for: url), .hosted)
    }

    // accept explicit default https port
    func testCanonicalDefaultPortStaysHosted() throws {
        let url = try XCTUnwrap(URL(string: "https://weather.ballydidean.farm:443/map"))
        XCTAssertEqual(WeatherNavigationPolicy.decision(for: url), .hosted)
    }

    // route safe external links out of WebKit
    func testExternalHTTPSUsesSystemBrowser() throws {
        let url = try XCTUnwrap(URL(string: "https://open-meteo.com/"))
        XCTAssertEqual(WeatherNavigationPolicy.decision(for: url), .external(url))
    }

    // reject every unsafe origin form
    func testUnsafeOriginsAreRejected() throws {
        let rejectedValues = [
            "http://weather.ballydidean.farm/",
            "https://weather.ballydidean.farm.evil.example/",
            "https://evil.weather.ballydidean.farm/",
            "https://user@weather.ballydidean.farm/",
            "https://weather.ballydidean.farm:444/",
            "file:///tmp/weather.html",
            "javascript:alert(1)",
            "data:text/html,weather"
        ]

        // verify each rejected form
        for value in rejectedValues {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertEqual(WeatherNavigationPolicy.decision(for: url), .rejected, value)
        }
    }

    // accept only the fixed forecast deep link
    func testDeepLinkHasNoInputSurface() throws {
        XCTAssertEqual(
            WeatherRoute(deepLink: try XCTUnwrap(URL(string: "ballydidean-weather://forecast"))),
            .forecast
        )

        let rejectedValues = [
            "ballydidean-weather://forecast/extra",
            "ballydidean-weather://forecast?url=https://evil.example",
            "ballydidean-weather://other",
            "https://weather.ballydidean.farm/forecast"
        ]

        // verify each rejected deep link
        for value in rejectedValues {
            XCTAssertNil(WeatherRoute(deepLink: try XCTUnwrap(URL(string: value))), value)
        }
    }
}

final class WeatherWidgetFixtureTests: XCTestCase {
    // prove the maximum-density interval coverage
    func testMaximumDensityCoversTwentyOneIntervalsExactlyOnce() {
        let fixture = WeatherWidgetFixtures.fixture(for: .maximumDensity)
        let intervals = fixture.groups.flatMap(\.intervalIndexes)

        XCTAssertEqual(fixture.groups.count, 7)
        XCTAssertEqual(intervals, Array(0..<21))
        XCTAssertEqual(Set(intervals).count, 21)
        XCTAssertEqual(fixture.intervalCount, 21)
        XCTAssertTrue(fixture.groups.allSatisfy { (1...3).contains($0.intervalIndexes.count) })
        XCTAssertTrue(fixture.groups[0].timeLabel.contains("D/S"))
        XCTAssertTrue(fixture.groups[0].accessibilityTimeLabel.contains("daylight"))
        XCTAssertTrue(fixture.groups[0].accessibilityTimeLabel.contains("standard"))
    }

    // prove ranges use adjusted air temperatures
    func testTemperatureRangesAndBelowZeroValues() {
        let first = WeatherWidgetFixtures.fixture(for: .maximumDensity).groups[0]
        XCTAssertEqual(first.temperatureLabel(unit: .celsius), "-3–-1°C")
        XCTAssertEqual(first.temperatureLabel(unit: .fahrenheit), "27–30°F")
    }

    // prove default and alternate units
    func testIntentDefaultsToFahrenheit() {
        XCTAssertEqual(WeatherWidgetConfigurationIntent().temperatureUnit, .fahrenheit)
        XCTAssertEqual(WeatherWidgetConfigurationIntent().fixtureScenario, .maximumDensity)
        XCTAssertEqual(
            WeatherWidgetConfigurationIntent(temperatureUnit: .celsius).temperatureUnit,
            .celsius
        )
        XCTAssertEqual(
            WeatherWidgetConfigurationIntent(
                temperatureUnit: .fahrenheit,
                fixtureScenario: .nearCutoff
            ).fixtureScenario,
            .nearCutoff
        )
    }

    // prove the exact bedtime message
    func testNearCutoffAndBedtimeUseExactMessage() {
        let nearCutoff = WeatherWidgetFixtures.fixture(for: .nearCutoff)
        let bedtime = WeatherWidgetFixtures.fixture(for: .bedtime)

        XCTAssertEqual(nearCutoff.groups.count, 1)
        XCTAssertEqual(nearCutoff.bedtimeMessage, "go to bed")
        XCTAssertTrue(bedtime.groups.isEmpty)
        XCTAssertEqual(bedtime.bedtimeMessage, "go to bed")
    }

    // prove visible weather requires licensed credit
    func testAccessibleCreditAndMetricArePresent() {
        let fixture = WeatherWidgetFixtures.fixture(for: .maximumDensity)
        let summary = fixture.accessibilitySummary(unit: .fahrenheit)

        XCTAssertTrue(summary.contains("adjusted air temperature"))
        XCTAssertTrue(summary.contains("Open-Meteo"))
        XCTAssertTrue(summary.contains("CC BY 4.0"))
        XCTAssertEqual(WeatherWidgetFixture.minimumNormalFontSize, 12)
    }

    // prove wettest-hour ordering
    func testWettestConditionWins() {
        XCTAssertEqual([WeatherCondition.dry, .rain, .sprinkle].max(), .rain)
    }
}
