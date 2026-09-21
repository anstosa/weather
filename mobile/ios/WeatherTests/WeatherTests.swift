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

    #if DEBUG
    // load only the explicit frozen HTTPS fixture contract
    func testHTTPSFixtureConfigurationRequiresExactLaunchInputs() throws {
        let arguments = [
            "Weather",
            WeatherHTTPSFixtureConfiguration.launchArgument,
            WeatherHTTPSFixtureConfiguration.pathArgument,
            "/settings"
        ]
        let environment = [
            WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                "https://127.0.0.1:18443",
            WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                "https://127.0.0.1:18444"
        ]
        let fixture = try XCTUnwrap(
            WeatherHTTPSFixtureConfiguration.load(
                arguments: arguments,
                environment: environment
            )
        )
        XCTAssertEqual(fixture.startURL.absoluteString, "https://127.0.0.1:18443/settings")
        XCTAssertEqual(fixture.forecastURL.absoluteString, "https://127.0.0.1:18443/forecast")
        XCTAssertEqual(
            WeatherHTTPSFixtureConfiguration.load(
                arguments: ["Weather"],
                environment: environment
            ),
            nil
        )
    }

    // reject malformed origins and initial routes without production fallback
    func testHTTPSFixtureConfigurationFailsClosed() {
        let arguments = ["Weather", WeatherHTTPSFixtureConfiguration.launchArgument]
        let malformedEnvironments = [
            [
                WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                    "http://127.0.0.1:18443",
                WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                    "https://127.0.0.1:18444"
            ],
            [
                WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                    "https://localhost:18443",
                WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                    "https://127.0.0.1:18444"
            ],
            [
                WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                    "https://127.0.0.1:18443",
                WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                    "https://127.0.0.1:18443"
            ]
        ]
        // reject every malformed environment
        for environment in malformedEnvironments {
            XCTAssertNil(
                WeatherHTTPSFixtureConfiguration.load(
                    arguments: arguments,
                    environment: environment
                )
            )
        }
        XCTAssertNil(
            WeatherHTTPSFixtureConfiguration.load(
                arguments: [
                    "Weather",
                    WeatherHTTPSFixtureConfiguration.launchArgument,
                    WeatherHTTPSFixtureConfiguration.pathArgument,
                    "/not-allowlisted"
                ],
                environment: [
                    WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                        "https://127.0.0.1:18443",
                    WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                        "https://127.0.0.1:18444"
                ]
            )
        )
    }

    // host only the two fixture origins during an explicit debug launch
    func testHTTPSFixtureNavigationPolicyIsClosedToEveryOtherOrigin() throws {
        let fixture = try XCTUnwrap(
            WeatherHTTPSFixtureConfiguration.load(
                arguments: ["Weather", WeatherHTTPSFixtureConfiguration.launchArgument],
                environment: [
                    WeatherHTTPSFixtureConfiguration.trustedOriginEnvironment:
                        "https://127.0.0.1:18443",
                    WeatherHTTPSFixtureConfiguration.untrustedOriginEnvironment:
                        "https://127.0.0.1:18444"
                ]
            )
        )
        for value in [
            "https://127.0.0.1:18443/admin",
            "https://127.0.0.1:18444/tls-negative"
        ] {
            // allow both exact fixture origins through normal WebKit trust
            XCTAssertEqual(
                WeatherNavigationPolicy.decision(
                    for: try XCTUnwrap(URL(string: value)),
                    fixture: fixture
                ),
                .hosted,
                value
            )
        }
        for value in [
            "http://127.0.0.1:18443/",
            "https://127.0.0.1:18445/",
            "https://user@127.0.0.1:18443/",
            "https://weather.ballydidean.farm/",
            "https://open-meteo.com/"
        ] {
            // reject every non-fixture destination instead of handing off
            XCTAssertEqual(
                WeatherNavigationPolicy.decision(
                    for: try XCTUnwrap(URL(string: value)),
                    fixture: fixture
                ),
                .rejected,
                value
            )
        }
    }
    #endif
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

    // prove the native switch maps both units without changing the default
    func testIntentBoolUnitMapping() {
        let defaultIntent = WeatherWidgetConfigurationIntent()
        XCTAssertFalse(defaultIntent.useCelsius)
        XCTAssertEqual(defaultIntent.temperatureUnit, .fahrenheit)

        let celsiusIntent = WeatherWidgetConfigurationIntent(temperatureUnit: .celsius)
        XCTAssertTrue(celsiusIntent.useCelsius)
        XCTAssertEqual(celsiusIntent.temperatureUnit, .celsius)

        let fahrenheitIntent = WeatherWidgetConfigurationIntent(temperatureUnit: .fahrenheit)
        XCTAssertFalse(fahrenheitIntent.useCelsius)
        XCTAssertEqual(fahrenheitIntent.temperatureUnit, .fahrenheit)

        var editedIntent = WeatherWidgetConfigurationIntent()
        editedIntent.useCelsius = true
        XCTAssertEqual(editedIntent.temperatureUnit, .celsius)
        editedIntent.useCelsius = false
        XCTAssertEqual(editedIntent.temperatureUnit, .fahrenheit)
    }

    // prove every compiled fixture maps to its own scenario
    func testEveryFixtureScenarioResolvesItsIdentity() {
        // verify all deterministic cases
        for scenario in WeatherWidgetScenario.allCases {
            XCTAssertEqual(WeatherWidgetFixtures.fixture(for: scenario).scenario, scenario)
        }
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
    }

    // preserve the selected widget-only visual size
    func testWidgetVisualTypeUsesReviewedTwelvePoints() {
        XCTAssertEqual(WeatherWidgetFixture.widgetVisualFontSize, 12)
    }

    // retain every interval group in VoiceOver
    func testVoiceOverSummaryRetainsEveryForecastGroup() {
        let fixture = WeatherWidgetFixtures.fixture(for: .maximumDensity)
        let summary = fixture.accessibilitySummary(unit: .fahrenheit)

        XCTAssertTrue(summary.hasPrefix("21 forecast intervals in 7 groups"))
        // retain every group in VoiceOver detail
        for group in fixture.groups {
            XCTAssertTrue(summary.contains(group.accessibilityLabel(unit: .fahrenheit)))
        }
    }

    // prove wettest-hour ordering
    func testWettestConditionWins() {
        XCTAssertEqual([WeatherCondition.dry, .rain, .sprinkle].max(), .rain)
    }
}

final class WeatherWidgetContractTests: XCTestCase {
    private let decoder = WeatherWidgetSnapshotDecoder()
    private let renderer = WeatherWidgetRenderer()

    // decode every frozen snapshot and match its independent semantic golden
    func testSharedFixtureParity() throws {
        let names = [
            "adjusted-standard",
            "fall-back-25",
            "midnight-race",
            "missing-raw-at-expiry",
            "spring-forward-23",
            "stale-old-source"
        ]
        // compare every frozen shared case
        for name in names {
            let snapshot = try decoder.decode(fixtureData(name, file: "snapshot.json"))
            let expected = try WeatherWidgetDateCodec.decoder().decode(
                WeatherWidgetPresentation.self,
                from: fixtureData(name, file: "expected.json")
            )
            let attempt = WeatherWidgetAttempt(
                attemptedAt: snapshot.receivedAt,
                outcome: .success,
                schemaVersion: WeatherWidgetStore.attemptSchemaVersion
            )
            let actual = renderer.render(
                snapshot: snapshot,
                acquiredAt: snapshot.receivedAt,
                attempt: attempt,
                now: expected.now,
                unit: expected.unit
            )
            XCTAssertEqual(actual, expected, name)
        }
    }

    // reject unknown fields before Codable can ignore them
    func testDecoderRejectsUnknownFields() throws {
        var payload = try fixtureObject("adjusted-standard")
        payload["unexpected"] = true
        XCTAssertThrowsError(try decoder.decode(try JSONSerialization.data(withJSONObject: payload)))
    }

    // reject site and generated-calendar mismatches
    func testDecoderRejectsSiteAndCalendarMismatch() throws {
        var sitePayload = try fixtureObject("adjusted-standard")
        var site = try XCTUnwrap(sitePayload["site"] as? [String: Any])
        site["slug"] = "other"
        sitePayload["site"] = site
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: sitePayload))
        )

        var calendarPayload = try fixtureObject("adjusted-standard")
        var calendar = try XCTUnwrap(calendarPayload["calendar"] as? [String: Any])
        calendar["date"] = "2026-09-11"
        calendarPayload["calendar"] = calendar
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: calendarPayload))
        )
    }

    // reject reversed causal clocks and extended adjustment deadlines
    func testDecoderRejectsCausalClockViolations() throws {
        var receiptPayload = try fixtureObject("adjusted-standard")
        receiptPayload["receivedAt"] = "2026-09-12T06:59:59.999Z"
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: receiptPayload))
        )

        var sourcePayload = try fixtureObject("adjusted-standard")
        var hours = try XCTUnwrap(sourcePayload["hours"] as? [[String: Any]])
        var first = hours[0]
        var temperature = try XCTUnwrap(first["temperatureC"] as? [String: Any])
        var rawSource = try XCTUnwrap(temperature["rawSource"] as? [String: Any])
        rawSource["receivedAt"] = sourcePayload["receivedAt"]
        temperature["rawSource"] = rawSource
        first["temperatureC"] = temperature
        hours[0] = first
        sourcePayload["hours"] = hours
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: sourcePayload))
        )

        var deadlinePayload = try fixtureObject("adjusted-standard")
        hours = try XCTUnwrap(deadlinePayload["hours"] as? [[String: Any]])
        first = hours[0]
        temperature = try XCTUnwrap(first["temperatureC"] as? [String: Any])
        temperature["selectedUntil"] = "2026-09-12T08:30:00.001Z"
        first["temperatureC"] = temperature
        hours[0] = first
        deadlinePayload["hours"] = hours
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: deadlinePayload))
        )
    }

    // reject incomplete grids and physical numeric violations
    func testDecoderRejectsGridAndNumericViolations() throws {
        var gridPayload = try fixtureObject("adjusted-standard")
        var hours = try XCTUnwrap(gridPayload["hours"] as? [[String: Any]])
        hours.removeLast()
        gridPayload["hours"] = hours
        XCTAssertThrowsError(try decoder.decode(try JSONSerialization.data(withJSONObject: gridPayload)))

        var temperaturePayload = try fixtureObject("adjusted-standard")
        hours = try XCTUnwrap(temperaturePayload["hours"] as? [[String: Any]])
        var first = hours[0]
        var temperature = try XCTUnwrap(first["temperatureC"] as? [String: Any])
        temperature["selected"] = -100.01
        first["temperatureC"] = temperature
        hours[0] = first
        temperaturePayload["hours"] = hours
        XCTAssertThrowsError(
            try decoder.decode(try JSONSerialization.data(withJSONObject: temperaturePayload))
        )

        var rainPayload = try fixtureObject("adjusted-standard")
        hours = try XCTUnwrap(rainPayload["hours"] as? [[String: Any]])
        first = hours[0]
        var rain = try XCTUnwrap(first["rainMmPerHour"] as? [String: Any])
        rain["raw"] = -0.01
        first["rainMmPerHour"] = rain
        hours[0] = first
        rainPayload["hours"] = hours
        XCTAssertThrowsError(try decoder.decode(try JSONSerialization.data(withJSONObject: rainPayload)))
    }

    // demote adjustments exactly at their deadline
    func testCorrectionDeadlineEqualityDemotesToRawSource() throws {
        let snapshot = try decoder.decode(fixtureData("adjusted-standard", file: "snapshot.json"))
        let field = snapshot.hours[0].temperatureC
        let deadline = try XCTUnwrap(field.selectedUntil)
        let resolved = renderer.resolve(field, now: deadline)
        XCTAssertEqual(resolved.mode, .raw)
        XCTAssertEqual(resolved.value, field.raw)
        XCTAssertEqual(resolved.sourceClock, field.rawSource?.runAt)
    }

    // preserve strict stale and hard-expiry equality contracts
    func testFreshnessBoundaryEqualityAndHardExpiry() throws {
        let snapshot = try decoder.decode(fixtureData("adjusted-standard", file: "snapshot.json"))
        let acquisitionStaleBoundary = snapshot.receivedAt.addingTimeInterval(90 * 60)
        let atStaleBoundary = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: nil,
            now: acquisitionStaleBoundary,
            unit: .fahrenheit
        )
        XCTAssertFalse(atStaleBoundary.stale)

        let atHardExpiry = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: nil,
            now: snapshot.calendar.dayEnd,
            unit: .fahrenheit
        )
        XCTAssertTrue(atHardExpiry.hardExpired)
        XCTAssertEqual(atHardExpiry.presentation, .unavailable)
        XCTAssertTrue(atHardExpiry.groups.isEmpty)
        XCTAssertNil(atHardExpiry.footer.sunset)
        XCTAssertFalse(atHardExpiry.bedtime)

        let afterStaleBoundary = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: nil,
            now: acquisitionStaleBoundary.addingTimeInterval(0.001),
            unit: .fahrenheit
        )
        XCTAssertTrue(afterStaleBoundary.stale)
    }

    // treat rollback clocks as stale and preserve bedtime status before expiry
    func testFutureClockIsStaleAndCutoffUsesBedtime() throws {
        let snapshot = try decoder.decode(fixtureData("adjusted-standard", file: "snapshot.json"))
        let beforeReceipt = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt.addingTimeInterval(60),
            attempt: nil,
            now: snapshot.receivedAt,
            unit: .fahrenheit
        )
        XCTAssertTrue(beforeReceipt.stale)

        let futureReceiptSnapshot = WeatherWidgetSnapshot(
            attribution: snapshot.attribution,
            calendar: snapshot.calendar,
            generatedAt: snapshot.generatedAt,
            hours: snapshot.hours,
            receivedAt: snapshot.receivedAt.addingTimeInterval(60),
            schemaVersion: snapshot.schemaVersion,
            site: snapshot.site,
            status: snapshot.status
        )
        let beforeFutureReceipt = renderer.render(
            snapshot: futureReceiptSnapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: nil,
            now: snapshot.receivedAt,
            unit: .fahrenheit
        )
        XCTAssertTrue(beforeFutureReceipt.stale)

        let cutoff = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: nil,
            now: snapshot.calendar.cutoff,
            unit: .fahrenheit
        )
        XCTAssertTrue(cutoff.groups.isEmpty)
        XCTAssertTrue(cutoff.bedtime)
        XCTAssertEqual(cutoff.presentation, .bedtime)
        XCTAssertEqual(cutoff.status, snapshot.status)
        XCTAssertFalse(cutoff.hardExpired)
    }

    // make known failure stale immediately without dropping good values
    func testKnownFailureMarksRecentSnapshotStale() throws {
        let snapshot = try decoder.decode(fixtureData("adjusted-standard", file: "snapshot.json"))
        let failure = WeatherWidgetAttempt(
            attemptedAt: snapshot.receivedAt.addingTimeInterval(1),
            outcome: .offline,
            schemaVersion: WeatherWidgetStore.attemptSchemaVersion
        )
        let presentation = renderer.render(
            snapshot: snapshot,
            acquiredAt: snapshot.receivedAt,
            attempt: failure,
            now: failure.attemptedAt,
            unit: .fahrenheit
        )
        XCTAssertTrue(presentation.stale)
        XCTAssertFalse(presentation.groups.isEmpty)
    }

    // retain terminal boundaries beyond a dense distinct-clock timeline
    func testTimelineRetainsExpiryBeyondSixtyFourDistinctBoundaries() throws {
        let snapshot = try decoder.decode(fixtureData("fall-back-25", file: "snapshot.json"))
        // give every field distinct correction and source transitions
        let hours = snapshot.hours.enumerated().map { index, hour in
            let offset = TimeInterval(index * 4)
            let temperatureRawSource = WeatherWidgetSource(
                receivedAt: snapshot.receivedAt,
                runAt: snapshot.calendar.dayStart.addingTimeInterval(offset + 1)
            )
            let temperatureSelectedSource = WeatherWidgetSource(
                receivedAt: snapshot.receivedAt,
                runAt: snapshot.calendar.dayStart.addingTimeInterval(offset + 2)
            )
            let rainRawSource = WeatherWidgetSource(
                receivedAt: snapshot.receivedAt,
                runAt: snapshot.calendar.dayStart.addingTimeInterval(offset + 3)
            )
            let rainSelectedSource = WeatherWidgetSource(
                receivedAt: snapshot.receivedAt,
                runAt: snapshot.calendar.dayStart.addingTimeInterval(offset + 4)
            )
            return WeatherWidgetHour(
                end: hour.end,
                rainMmPerHour: WeatherWidgetValue(
                    mode: .adjusted,
                    raw: hour.rainMmPerHour.raw,
                    rawSource: rainRawSource,
                    reason: .rainAdjustment,
                    selected: hour.rainMmPerHour.selected,
                    selectedSource: rainSelectedSource,
                    selectedUntil: snapshot.calendar.dayStart.addingTimeInterval(1_000 + offset)
                ),
                start: hour.start,
                temperatureC: WeatherWidgetValue(
                    mode: .adjusted,
                    raw: hour.temperatureC.raw,
                    rawSource: temperatureRawSource,
                    reason: .genericAdjustment,
                    selected: hour.temperatureC.selected,
                    selectedSource: temperatureSelectedSource,
                    selectedUntil: snapshot.calendar.dayStart.addingTimeInterval(2_000 + offset)
                )
            )
        }
        let denseSnapshot = WeatherWidgetSnapshot(
            attribution: snapshot.attribution,
            calendar: snapshot.calendar,
            generatedAt: snapshot.generatedAt,
            hours: hours,
            receivedAt: snapshot.receivedAt,
            schemaVersion: snapshot.schemaVersion,
            site: snapshot.site,
            status: .adjusted
        )
        let acquiredAt = snapshot.receivedAt.addingTimeInterval(7)
        let dates = renderer.transitionDates(
            snapshot: denseSnapshot,
            acquiredAt: acquiredAt,
            after: snapshot.calendar.dayStart.addingTimeInterval(-1)
        )
        XCTAssertGreaterThan(dates.count, 64)
        XCTAssertTrue(dates.contains(snapshot.calendar.cutoff))
        XCTAssertTrue(dates.contains(snapshot.calendar.dayEnd))
        XCTAssertTrue(dates.contains(snapshot.receivedAt.addingTimeInterval(24 * 60 * 60)))
        XCTAssertTrue(dates.contains(acquiredAt.addingTimeInterval(24 * 60 * 60)))
        XCTAssertEqual(dates, Array(Set(dates)).sorted())
    }

    // preserve rounded air range and wettest-hour rain boundaries
    func testTemperatureRangeAndRainThresholds() throws {
        let sprinkle = try snapshotWithFirstRainValues([0, 0.000_001, 2.5])
        let sprinklePresentation = renderer.render(
            snapshot: sprinkle,
            acquiredAt: sprinkle.receivedAt,
            attempt: nil,
            now: sprinkle.receivedAt,
            unit: .fahrenheit
        )
        XCTAssertEqual(sprinklePresentation.groups[0].temperature?.label, "60–63")
        XCTAssertEqual(sprinklePresentation.groups[0].condition, .sprinkle)

        let rain = try snapshotWithFirstRainValues([0, 2.5, 2.500_001])
        let rainPresentation = renderer.render(
            snapshot: rain,
            acquiredAt: rain.receivedAt,
            attempt: nil,
            now: rain.receivedAt,
            unit: .fahrenheit
        )
        XCTAssertEqual(rainPresentation.groups[0].condition, .rain)
    }

    // keep partial groups unavailable and round negative midpoint ties away
    func testPartialGroupAndNegativeMidpointSemantics() throws {
        var partialPayload = try fixtureObject("adjusted-standard")
        var hours = try XCTUnwrap(partialPayload["hours"] as? [[String: Any]])
        var first = hours[0]
        first["temperatureC"] = unavailableValueObject()
        first["rainMmPerHour"] = unavailableValueObject()
        hours[0] = first
        partialPayload["hours"] = hours
        partialPayload["status"] = "mixed"
        let partial = try decoder.decode(try JSONSerialization.data(withJSONObject: partialPayload))
        let partialPresentation = renderer.render(
            snapshot: partial,
            acquiredAt: partial.receivedAt,
            attempt: nil,
            now: partial.receivedAt,
            unit: .celsius
        )
        XCTAssertNil(partialPresentation.groups[0].temperature)
        XCTAssertEqual(partialPresentation.groups[0].condition, .unavailable)

        var roundingPayload = try fixtureObject("adjusted-standard")
        hours = try XCTUnwrap(roundingPayload["hours"] as? [[String: Any]])
        // set one complete group to negative and positive midpoint ties
        for (index, value) in [-1.5, -0.5, 0.5].enumerated() {
            var hour = hours[index]
            var temperature = try XCTUnwrap(hour["temperatureC"] as? [String: Any])
            temperature["selected"] = value
            hour["temperatureC"] = temperature
            hours[index] = hour
        }
        roundingPayload["hours"] = hours
        let rounding = try decoder.decode(try JSONSerialization.data(withJSONObject: roundingPayload))
        let roundingPresentation = renderer.render(
            snapshot: rounding,
            acquiredAt: rounding.receivedAt,
            attempt: nil,
            now: rounding.receivedAt,
            unit: .celsius
        )
        XCTAssertEqual(roundingPresentation.groups[0].temperature?.label, "-2–1")
    }

    // load one immutable shared fixture file
    private func fixtureData(_ name: String, file: String) throws -> Data {
        try Data(contentsOf: fixtureURL(name, file: file))
    }

    // locate the repository-owned frozen shared fixtures
    private func fixtureURL(_ name: String, file: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "shared/fixtures/\(name)/\(file)")
    }

    // deserialize one mutable fixture object
    private func fixtureObject(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: fixtureData(name, file: "snapshot.json")
            ) as? [String: Any]
        )
    }

    // create one schema-valid explicit unavailable field
    private func unavailableValueObject() -> [String: Any] {
        [
            "mode": "unavailable",
            "raw": NSNull(),
            "rawSource": NSNull(),
            "reason": "missing",
            "selected": NSNull(),
            "selectedSource": NSNull(),
            "selectedUntil": NSNull()
        ]
    }

    // create one valid snapshot with exact first-group rain values
    private func snapshotWithFirstRainValues(_ values: [Double]) throws -> WeatherWidgetSnapshot {
        var payload = try fixtureObject("adjusted-standard")
        var hours = try XCTUnwrap(payload["hours"] as? [[String: Any]])
        // update only the first three adjusted selected values
        for (index, value) in values.enumerated() {
            var hour = hours[index]
            var rain = try XCTUnwrap(hour["rainMmPerHour"] as? [String: Any])
            rain["selected"] = value
            hour["rainMmPerHour"] = rain
            hours[index] = hour
        }
        payload["hours"] = hours
        return try decoder.decode(try JSONSerialization.data(withJSONObject: payload))
    }
}

final class WeatherWidgetPersistenceTests: XCTestCase {
    private var directory: URL!

    // create one isolated extension-container substitute
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
    }

    // remove only this test's temporary container
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // retain good weather while persisting a failed attempt across restart
    func testFailedAttemptDoesNotClobberSnapshotAcrossRestart() async throws {
        let data = try fixtureData("adjusted-standard")
        let now = try XCTUnwrap(WeatherWidgetDateCodec.date(from: "2026-09-12T07:00:01.000Z"))
        let store = WeatherWidgetStore(directory: directory)
        let successful = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .success(data)),
            store: store,
            clock: { now }
        )
        let first = await successful.refresh()
        XCTAssertNotNil(first.cached)
        XCTAssertEqual(first.attempt?.outcome, .success)

        let failed = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory),
            clock: { now.addingTimeInterval(60) }
        )
        let second = await failed.refresh()
        XCTAssertEqual(second.cached?.snapshot, first.cached?.snapshot)
        XCTAssertEqual(second.attempt?.outcome, .offline)

        let restarted = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory)
        )
        let persisted = await restarted.cachedState()
        XCTAssertEqual(persisted.cached?.snapshot, first.cached?.snapshot)
        XCTAssertEqual(persisted.attempt?.outcome, .offline)
    }

    // accept success metadata bound to the exact cached acquisition
    func testMatchingSuccessMetadataSurvivesRestart() async throws {
        let store = WeatherWidgetStore(directory: directory)
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(fixtureData("adjusted-standard"))
        let cached = WeatherWidgetCachedSnapshot(
            acquiredAt: snapshot.receivedAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: snapshot
        )
        try store.saveSnapshot(cached)
        try store.saveAttempt(
            WeatherWidgetAttempt(
                attemptedAt: cached.acquiredAt,
                outcome: .success,
                schemaVersion: WeatherWidgetStore.attemptSchemaVersion,
                snapshotAcquiredAt: cached.acquiredAt,
                snapshotIdentifier: cached.snapshotIdentifier
            )
        )
        let restarted = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory)
        )
        let state = await restarted.cachedState()
        XCTAssertEqual(state.cached, cached)
        XCTAssertEqual(state.attempt?.outcome, .success)
        XCTAssertEqual(state.attempt?.snapshotAcquiredAt, cached.acquiredAt)
        XCTAssertEqual(state.attempt?.snapshotIdentifier, cached.snapshotIdentifier)
    }

    // reject an older success after an interrupted snapshot replacement
    func testInterruptedSnapshotReplacementIsConservativeAcrossRestart() async throws {
        let store = WeatherWidgetStore(directory: directory)
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(fixtureData("adjusted-standard"))
        let first = WeatherWidgetCachedSnapshot(
            acquiredAt: snapshot.receivedAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: snapshot
        )
        try store.saveSnapshot(first)
        try store.saveAttempt(
            WeatherWidgetAttempt(
                attemptedAt: first.acquiredAt,
                outcome: .success,
                schemaVersion: WeatherWidgetStore.attemptSchemaVersion,
                snapshotAcquiredAt: first.acquiredAt,
                snapshotIdentifier: first.snapshotIdentifier
            )
        )
        let replacementSnapshot = try WeatherWidgetSnapshotDecoder().decode(
            fixtureData("stale-old-source")
        )
        let replacement = WeatherWidgetCachedSnapshot(
            acquiredAt: first.acquiredAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: replacementSnapshot
        )
        XCTAssertNotEqual(first.snapshot, replacement.snapshot)
        XCTAssertNotEqual(first.snapshotIdentifier, replacement.snapshotIdentifier)
        // simulate termination after the atomic snapshot write
        try store.saveSnapshot(replacement)

        let restarted = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory)
        )
        let state = await restarted.cachedState()
        XCTAssertEqual(state.cached, replacement)
        XCTAssertEqual(state.attempt?.outcome, .storageError)
        let presentation = WeatherWidgetRenderer().render(
            snapshot: replacement.snapshot,
            acquiredAt: replacement.acquiredAt,
            attempt: state.attempt,
            now: replacement.acquiredAt,
            unit: .fahrenheit
        )
        XCTAssertTrue(presentation.stale)
        XCTAssertTrue(
            presentation.display(
                ageAnchor: replacement.acquiredAt,
                attempt: state.attempt
            ).statusLabel.hasPrefix("Offline")
        )
    }

    // treat missing success metadata as a conservative restart failure
    func testMissingAttemptMetadataIsConservativeAcrossRestart() async throws {
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(fixtureData("adjusted-standard"))
        let cached = WeatherWidgetCachedSnapshot(
            acquiredAt: snapshot.receivedAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: snapshot
        )
        try WeatherWidgetStore(directory: directory).saveSnapshot(cached)
        let restarted = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory)
        )
        let state = await restarted.cachedState()
        XCTAssertEqual(state.cached, cached)
        XCTAssertEqual(state.attempt?.outcome, .storageError)
    }

    // treat corrupt attempt metadata as a conservative restart failure
    func testCorruptAttemptMetadataIsConservativeAcrossRestart() async throws {
        let store = WeatherWidgetStore(directory: directory)
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(fixtureData("adjusted-standard"))
        let cached = WeatherWidgetCachedSnapshot(
            acquiredAt: snapshot.receivedAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: snapshot
        )
        try store.saveSnapshot(cached)
        try Data("not-json".utf8).write(
            to: directory.appending(path: "last-attempt.json"),
            options: .atomic
        )
        XCTAssertNil(store.loadAttempt())
        let restarted = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: WeatherWidgetStore(directory: directory)
        )
        let state = await restarted.cachedState()
        XCTAssertEqual(state.cached, cached)
        XCTAssertEqual(state.attempt?.outcome, .storageError)
    }

    // reject corrupt and oversized snapshot files on read
    func testCorruptAndOversizedSnapshotFilesAreRejected() throws {
        let snapshotURL = directory.appending(path: "last-good.json")
        try Data("not-json".utf8).write(to: snapshotURL)
        XCTAssertNil(WeatherWidgetStore(directory: directory).loadSnapshot())

        let oversized = Data(
            repeating: 0x20,
            count: WeatherWidgetContract.maximumPayloadBytes + 8_193
        )
        try oversized.write(to: snapshotURL)
        XCTAssertNil(WeatherWidgetStore(directory: directory).loadSnapshot())
    }

    // surface metadata write failure instead of reusing older success
    func testAttemptWriteFailureBecomesStorageError() async throws {
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(fixtureData("adjusted-standard"))
        let cached = WeatherWidgetCachedSnapshot(
            acquiredAt: snapshot.receivedAt,
            schemaVersion: WeatherWidgetStore.storageSchemaVersion,
            snapshot: snapshot
        )
        let oldSuccess = WeatherWidgetAttempt(
            attemptedAt: snapshot.receivedAt,
            outcome: .success,
            schemaVersion: WeatherWidgetStore.attemptSchemaVersion,
            snapshotAcquiredAt: cached.acquiredAt,
            snapshotIdentifier: cached.snapshotIdentifier
        )
        let store = FailingAttemptStore(cached: cached, attempt: oldSuccess)
        let controller = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .failure(WeatherWidgetFetchError.offline)),
            store: store,
            clock: { snapshot.receivedAt.addingTimeInterval(60) }
        )
        let state = await controller.refresh()
        XCTAssertEqual(state.cached, cached)
        XCTAssertEqual(state.attempt?.outcome, .storageError)
    }

    // retain newly fetched weather while reporting attempt metadata failure
    func testSuccessfulFetchWithAttemptWriteFailureKeepsNewWeather() async throws {
        let data = try fixtureData("adjusted-standard")
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(data)
        let store = FailingAttemptStore(cached: nil, attempt: nil)
        let controller = WeatherWidgetDataController(
            fetcher: StubFetcher(result: .success(data)),
            store: store,
            clock: { snapshot.receivedAt }
        )
        let state = await controller.refresh()
        XCTAssertEqual(state.cached?.snapshot, snapshot)
        XCTAssertEqual(state.attempt?.outcome, .storageError)
    }

    // coalesce concurrent provider refreshes before persistence commits
    func testConcurrentRefreshesShareOneOrderedFetch() async throws {
        let data = try fixtureData("adjusted-standard")
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(data)
        let fetcher = BlockingFetcher()
        let controller = WeatherWidgetDataController(
            fetcher: fetcher,
            store: WeatherWidgetStore(directory: directory),
            clock: { snapshot.receivedAt }
        )
        let firstNow = snapshot.receivedAt
        let first = Task { await controller.refresh() }
        await fetcher.waitUntilStarted()
        let second = Task {
            await controller.refresh()
        }
        // allow the second caller to observe the in-flight task
        try await Task.sleep(for: .milliseconds(50))
        let callsBeforeCompletion = await fetcher.callCount()
        XCTAssertEqual(callsBeforeCompletion, 1)
        await fetcher.succeed(with: data)
        let firstState = await first.value
        let secondState = await second.value
        XCTAssertEqual(firstState.cached, secondState.cached)
        XCTAssertEqual(firstState.cached?.acquiredAt, firstNow)
        let totalCalls = await fetcher.callCount()
        XCTAssertEqual(totalCalls, 1)
    }

    // acquire only after a response receipt can exist
    func testResponseReceiptBetweenStartAndCompletionRendersFresh() async throws {
        let data = try fixtureData("adjusted-standard")
        let snapshot = try WeatherWidgetSnapshotDecoder().decode(data)
        let completion = snapshot.receivedAt.addingTimeInterval(1)
        let fetcher = BlockingFetcher()
        let controller = WeatherWidgetDataController(
            fetcher: fetcher,
            store: WeatherWidgetStore(directory: directory),
            clock: { completion }
        )
        let refresh = Task { await controller.refresh() }
        await fetcher.waitUntilStarted()
        await fetcher.succeed(with: data)
        let state = await refresh.value
        let cached = try XCTUnwrap(state.cached)
        XCTAssertEqual(cached.acquiredAt, completion)
        let presentation = WeatherWidgetRenderer().render(
            snapshot: cached.snapshot,
            acquiredAt: cached.acquiredAt,
            attempt: state.attempt,
            now: completion,
            unit: .fahrenheit
        )
        XCTAssertFalse(presentation.stale)
    }

    // load one immutable shared snapshot
    private func fixtureData(_ name: String) throws -> Data {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "shared/fixtures/\(name)/snapshot.json")
        return try Data(contentsOf: url)
    }
}

#if DEBUG && WEATHER_V4_PERSISTENCE_PROBE
final class WeatherWidgetPersistenceProbeConcurrencyTests: XCTestCase {
    private var directory: URL!

    // create one isolated extension-store substitute
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
    }

    // remove only this test's temporary store
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // serialize concurrent unit changes into one seed and failure write
    func testConcurrentFahrenheitThenCelsiusTransitionsWriteOnce() async throws {
        let store = WeatherWidgetStore(directory: directory)
        let gate = WeatherWidgetPersistenceProbeTestGate()
        let probe = WeatherWidgetPersistenceProbe(
            store: store,
            onTransitionStart: { unit in
                await gate.transitionStarted(unit: unit)
            },
            onWaiterQueued: { requestedUnit, activeUnit in
                await gate.waiterQueued(requested: requestedUnit, active: activeUnit)
            }
        )

        let firstFahrenheit = Task {
            await probe.load(unit: .fahrenheit)
        }
        await gate.waitUntilFahrenheitStarted()
        let secondFahrenheit = Task {
            await probe.load(unit: .fahrenheit)
        }
        await gate.waitUntilFahrenheitShared()
        let firstCelsius = Task {
            await probe.load(unit: .celsius)
        }
        let secondCelsius = Task {
            await probe.load(unit: .celsius)
        }
        await gate.waitUntilCelsiusQueuedBehindFahrenheit(count: 2)
        let blockedFahrenheitStarts = await probe.startedTransitionCount(unit: .fahrenheit)
        let blockedCelsiusStarts = await probe.startedTransitionCount(unit: .celsius)
        XCTAssertEqual(blockedFahrenheitStarts, 1)
        XCTAssertEqual(blockedCelsiusStarts, 0)
        await gate.releaseFahrenheit()

        let celsiusResolution = await gate.waitUntilCelsiusResolved()
        XCTAssertEqual(celsiusResolution, .sharedTransition)
        let heldFahrenheitStarts = await probe.startedTransitionCount(unit: .fahrenheit)
        let heldCelsiusStarts = await probe.startedTransitionCount(unit: .celsius)
        XCTAssertEqual(heldFahrenheitStarts, 1)
        XCTAssertEqual(heldCelsiusStarts, 1)
        await gate.releaseCelsius()

        let firstFahrenheitResult = await firstFahrenheit.value
        let secondFahrenheitResult = await secondFahrenheit.value
        let firstCelsiusResult = await firstCelsius.value
        let secondCelsiusResult = await secondCelsius.value
        XCTAssertEqual(firstFahrenheitResult.action, "seed-success")
        XCTAssertEqual(secondFahrenheitResult.action, "seed-success")
        let seedCount = await probe.completedTransitionCount(action: "seed-success")
        XCTAssertEqual(seedCount, 1)
        let seeded = try XCTUnwrap(store.loadSnapshot())
        XCTAssertEqual(firstCelsiusResult.action, "write-offline")
        XCTAssertEqual(secondCelsiusResult.action, "write-offline")
        let failureCount = await probe.completedTransitionCount(action: "write-offline")
        XCTAssertEqual(failureCount, 1)
        let fahrenheitStarts = await probe.startedTransitionCount(unit: .fahrenheit)
        let celsiusStarts = await probe.startedTransitionCount(unit: .celsius)
        XCTAssertEqual(fahrenheitStarts, 1)
        XCTAssertEqual(celsiusStarts, 1)
        let failedSnapshot = try XCTUnwrap(store.loadSnapshot())
        let failedAttempt = try XCTUnwrap(store.loadAttempt())
        XCTAssertEqual(failedSnapshot.snapshotIdentifier, seeded.snapshotIdentifier)
        XCTAssertEqual(failedAttempt.outcome, .offline)

        let snapshotURL = directory.appending(path: "last-good.json")
        let attemptURL = directory.appending(path: "last-attempt.json")
        let snapshotBytes = try Data(contentsOf: snapshotURL)
        let attemptBytes = try Data(contentsOf: attemptURL)
        let firstRead = await probe.load(unit: .celsius)
        let secondRead = await probe.load(unit: .celsius)
        XCTAssertEqual(firstRead.action, "read-offline")
        XCTAssertEqual(secondRead.action, "read-offline")
        XCTAssertEqual(try Data(contentsOf: snapshotURL), snapshotBytes)
        XCTAssertEqual(try Data(contentsOf: attemptURL), attemptBytes)
        XCTAssertEqual(firstRead.state?.cached?.snapshotIdentifier, seeded.snapshotIdentifier)
        XCTAssertEqual(firstRead.state?.attempt?.attemptedAt, failedAttempt.attemptedAt)
        XCTAssertEqual(secondRead.state?.attempt?.attemptedAt, failedAttempt.attemptedAt)
        let readCount = await probe.completedTransitionCount(action: "read-offline")
        XCTAssertEqual(readCount, 2)
    }
}

private enum WeatherWidgetPersistenceProbeCelsiusResolution: Equatable {
    case duplicateTransition
    case sharedTransition
}

private actor WeatherWidgetPersistenceProbeTestGate {
    private var celsiusBehindFahrenheitCount = 0
    private var celsiusBehindFahrenheitContinuation: CheckedContinuation<Void, Never>?
    private var celsiusBehindFahrenheitTarget = 0
    private var celsiusReleaseContinuations: [CheckedContinuation<Void, Never>] = []
    private var celsiusReleaseRequested = false
    private var celsiusResolution: WeatherWidgetPersistenceProbeCelsiusResolution?
    private var celsiusResolutionContinuation: CheckedContinuation<
        WeatherWidgetPersistenceProbeCelsiusResolution,
        Never
    >?
    private var celsiusSharedObserved = false
    private var celsiusStartedCount = 0
    private var fahrenheitReleaseContinuation: CheckedContinuation<Void, Never>?
    private var fahrenheitReleaseRequested = false
    private var fahrenheitShared = false
    private var fahrenheitSharedContinuation: CheckedContinuation<Void, Never>?
    private var fahrenheitStarted = false
    private var fahrenheitStartedContinuation: CheckedContinuation<Void, Never>?

    // hold the first physical transition of each unit
    func transitionStarted(unit: TemperatureUnit) async {
        switch unit {
        case .fahrenheit:
            fahrenheitStarted = true
            fahrenheitStartedContinuation?.resume()
            fahrenheitStartedContinuation = nil
            // honor release requested before suspension registration
            if fahrenheitReleaseRequested {
                return
            }
            await withCheckedContinuation { continuation in
                // close the release-registration race
                if fahrenheitReleaseRequested {
                    continuation.resume()
                } else {
                    fahrenheitReleaseContinuation = continuation
                }
            }
        case .celsius:
            celsiusStartedCount += 1
            // let duplicate physical starts fail instead of deadlock
            if celsiusStartedCount > 1 {
                resolveCelsius(.duplicateTransition)
            } else {
                resolveSharedCelsiusIfReady()
            }
            // honor release requested before suspension registration
            if celsiusReleaseRequested {
                return
            }
            await withCheckedContinuation { continuation in
                // release every physical transition after the verdict
                if celsiusReleaseRequested {
                    continuation.resume()
                } else {
                    celsiusReleaseContinuations.append(continuation)
                }
            }
        }
    }

    // observe every requested and active unit pair
    func waiterQueued(requested: TemperatureUnit, active: TemperatureUnit) {
        switch (requested, active) {
        case (.fahrenheit, .fahrenheit):
            fahrenheitShared = true
            fahrenheitSharedContinuation?.resume()
            fahrenheitSharedContinuation = nil
        case (.celsius, .fahrenheit):
            celsiusBehindFahrenheitCount += 1
            // release only after every intended opposite-unit caller queued
            if celsiusBehindFahrenheitCount >= celsiusBehindFahrenheitTarget {
                celsiusBehindFahrenheitContinuation?.resume()
                celsiusBehindFahrenheitContinuation = nil
            }
        case (.celsius, .celsius):
            celsiusSharedObserved = true
            resolveSharedCelsiusIfReady()
        default:
            break
        }
    }

    // wait without inferring scheduling from time
    func waitUntilFahrenheitStarted() async {
        // accept an already observed transition
        if fahrenheitStarted {
            return
        }
        await withCheckedContinuation { continuation in
            fahrenheitStartedContinuation = continuation
        }
    }

    // prove the second Fahrenheit caller shared the held transition
    func waitUntilFahrenheitShared() async {
        // accept an already observed waiter
        if fahrenheitShared {
            return
        }
        await withCheckedContinuation { continuation in
            fahrenheitSharedContinuation = continuation
        }
    }

    // wait for all intended Celsius callers behind Fahrenheit
    func waitUntilCelsiusQueuedBehindFahrenheit(count: Int) async {
        celsiusBehindFahrenheitTarget = count
        // accept callers already queued by the actor
        if celsiusBehindFahrenheitCount >= count {
            return
        }
        await withCheckedContinuation { continuation in
            celsiusBehindFahrenheitContinuation = continuation
        }
    }

    // release only the held Fahrenheit transition
    func releaseFahrenheit() {
        fahrenheitReleaseRequested = true
        fahrenheitReleaseContinuation?.resume()
        fahrenheitReleaseContinuation = nil
    }

    // resolve on sharing or a duplicate physical start
    func waitUntilCelsiusResolved() async -> WeatherWidgetPersistenceProbeCelsiusResolution {
        // accept an already resolved verdict
        if let celsiusResolution {
            return celsiusResolution
        }
        return await withCheckedContinuation { continuation in
            celsiusResolutionContinuation = continuation
        }
    }

    // release every held Celsius transition after the verdict
    func releaseCelsius() {
        celsiusReleaseRequested = true
        let continuations = celsiusReleaseContinuations
        celsiusReleaseContinuations = []
        // resume every physical transition, including a duplicate
        for continuation in continuations {
            continuation.resume()
        }
    }

    // retain only the first deterministic Celsius verdict
    private func resolveCelsius(
        _ resolution: WeatherWidgetPersistenceProbeCelsiusResolution
    ) {
        guard celsiusResolution == nil else {
            return
        }
        celsiusResolution = resolution
        celsiusResolutionContinuation?.resume(returning: resolution)
        celsiusResolutionContinuation = nil
    }

    // require both one physical start and one sharing witness
    private func resolveSharedCelsiusIfReady() {
        guard celsiusStartedCount == 1, celsiusSharedObserved else {
            return
        }
        resolveCelsius(.sharedTransition)
    }
}
#endif

final class WeatherWidgetHTTPClientTests: XCTestCase {
    // reset request interception after every transport test
    override func tearDown() {
        StubURLProtocol.handler = nil
        super.tearDown()
    }

    // reject redirects from the fixed public endpoint
    func testRedirectIsRejected() async throws {
        StubURLProtocol.handler = { request, protocolInstance in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: "HTTP/1.1",
                headerFields: ["Location": "https://example.com/other"]
            )!
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                wasRedirectedTo: URLRequest(url: URL(string: "https://example.com/other")!),
                redirectResponse: response
            )
        }
        do {
            _ = try await client().fetch()
            XCTFail("redirect unexpectedly succeeded")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .invalidResponse)
        }
    }

    // keep overlapping requests isolated on one reusable client value
    func testOverlappingFetchesDoNotOverwriteEachOther() async throws {
        let lock = NSLock()
        var requestCount = 0
        var firstTransport: (URLRequest, StubURLProtocol)?
        let firstStarted = expectation(description: "first transport started")
        let secondStarted = expectation(description: "second transport started")
        StubURLProtocol.handler = { request, protocolInstance in
            lock.lock()
            requestCount += 1
            let index = requestCount
            // retain the first request until overlap is proven
            if index == 1 {
                firstTransport = (request, protocolInstance)
            }
            lock.unlock()

            // expose the held first request to the test
            if index == 1 {
                firstStarted.fulfill()
                return
            }

            secondStarted.fulfill()
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didLoad: Data("response-\(index)".utf8)
            )
            protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
        }
        let client = client()
        let first = Task { try await client.fetch() }
        await fulfillment(of: [firstStarted], timeout: 1)
        let second = Task { try await client.fetch() }
        await fulfillment(of: [secondStarted], timeout: 1)
        let secondValue = try await second.value

        lock.lock()
        let retainedFirstTransport = firstTransport
        let observedRequestCount = requestCount
        lock.unlock()
        let (firstRequest, firstProtocol) = try XCTUnwrap(retainedFirstTransport)
        let firstResponse = HTTPURLResponse(
            url: try XCTUnwrap(firstRequest.url),
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        firstProtocol.client?.urlProtocol(
            firstProtocol,
            didReceive: firstResponse,
            cacheStoragePolicy: .notAllowed
        )
        firstProtocol.client?.urlProtocol(
            firstProtocol,
            didLoad: Data("response-1".utf8)
        )
        firstProtocol.client?.urlProtocolDidFinishLoading(firstProtocol)
        let firstValue = try await first.value

        XCTAssertEqual(observedRequestCount, 2)
        XCTAssertEqual(String(decoding: firstValue, as: UTF8.self), "response-1")
        XCTAssertEqual(String(decoding: secondValue, as: UTF8.self), "response-2")
    }

    // canceling one request cannot finish a later request
    func testCancelledRequestCannotFinishLaterFetch() async throws {
        let lock = NSLock()
        var requestCount = 0
        let firstStarted = expectation(description: "cancelled transport started")
        StubURLProtocol.handler = { request, protocolInstance in
            lock.lock()
            requestCount += 1
            let index = requestCount
            lock.unlock()
            // deliberately leave the cancelled first request pending
            if index == 1 {
                firstStarted.fulfill()
                return
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            protocolInstance.client?.urlProtocol(protocolInstance, didLoad: Data("second".utf8))
            protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
        }
        let client = client()
        let cancelled = Task { try await client.fetch() }
        await fulfillment(of: [firstStarted], timeout: 1)
        cancelled.cancel()
        let second = try await client.fetch()
        XCTAssertEqual(String(decoding: second, as: UTF8.self), "second")
        do {
            _ = try await cancelled.value
            XCTFail("cancelled fetch unexpectedly succeeded")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .cancelled)
        }
    }

    // preserve cancellation delivered before continuation registration
    func testPreRegistrationCancellationNeverStartsTransport() async throws {
        let lock = NSLock()
        var requestCount = 0
        StubURLProtocol.handler = { _, protocolInstance in
            lock.lock()
            requestCount += 1
            lock.unlock()
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didFailWithError: URLError(.cancelled)
            )
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let request = WeatherWidgetBoundedRequest(configuration: configuration)
        request.cancel()
        do {
            _ = try await request.load(url: WeatherWidgetHTTPClient.endpoint)
            XCTFail("pre-cancelled request unexpectedly succeeded")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .cancelled)
        }
        lock.lock()
        let observedRequestCount = requestCount
        lock.unlock()
        XCTAssertEqual(observedRequestCount, 0)
    }

    // enforce the total deadline and ignore a late transport completion
    func testTotalDeadlineWinsOverLateSuccess() async throws {
        XCTAssertEqual(WeatherWidgetHTTPClient.deadline, 8)
        StubURLProtocol.handler = { request, protocolInstance in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!
                protocolInstance.client?.urlProtocol(
                    protocolInstance,
                    didReceive: response,
                    cacheStoragePolicy: .notAllowed
                )
                protocolInstance.client?.urlProtocol(
                    protocolInstance,
                    didLoad: Data("late-success".utf8)
                )
                protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
            }
        }
        do {
            _ = try await client(deadline: 0.02).fetch()
            XCTFail("late response unexpectedly beat the total deadline")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .timeout)
        }
        // let callbacks exercise the finished request guard
        try await Task.sleep(for: .milliseconds(200))
    }

    // reject a declared payload beyond the exact byte cap
    func testDeclaredOversizedPayloadIsRejected() async throws {
        StubURLProtocol.handler = { request, protocolInstance in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Length": "\(WeatherWidgetContract.maximumPayloadBytes + 1)",
                    "Content-Type": "application/json"
                ]
            )!
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
        }
        do {
            _ = try await client().fetch()
            XCTFail("declared oversized response unexpectedly succeeded")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .oversized)
        }
    }

    // reject streamed bytes immediately after the exact byte cap
    func testStreamedOversizedPayloadIsRejected() async throws {
        StubURLProtocol.handler = { request, protocolInstance in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didLoad: Data(repeating: 0x20, count: WeatherWidgetContract.maximumPayloadBytes)
            )
            protocolInstance.client?.urlProtocol(
                protocolInstance,
                didLoad: Data([0x20])
            )
            protocolInstance.client?.urlProtocolDidFinishLoading(protocolInstance)
        }
        do {
            _ = try await client().fetch()
            XCTFail("streamed oversized response unexpectedly succeeded")
        } catch let error as WeatherWidgetFetchError {
            XCTAssertEqual(error, .oversized)
        }
    }

    // build one intercepted ephemeral client
    private func client(deadline: TimeInterval = WeatherWidgetHTTPClient.deadline) -> WeatherWidgetHTTPClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return WeatherWidgetHTTPClient(
            configuration: configuration,
            requestDeadline: deadline
        )
    }
}

private struct StubFetcher: WeatherWidgetFetching {
    let result: Result<Data, Error>

    // return one deterministic transport result
    func fetch() async throws -> Data {
        try result.get()
    }
}

private actor BlockingFetcher: WeatherWidgetFetching {
    private var calls = 0
    private var continuations: [CheckedContinuation<Data, Error>] = []

    // suspend one deterministic in-flight fetch
    func fetch() async throws -> Data {
        calls += 1
        return try await withCheckedThrowingContinuation { continuation in
            continuations.append(continuation)
        }
    }

    // wait until the controller starts transport
    func waitUntilStarted() async {
        // yield until the fetch continuation is installed
        while continuations.isEmpty {
            await Task.yield()
        }
    }

    // return the observed transport count
    func callCount() -> Int {
        calls
    }

    // complete every controlled transport
    func succeed(with data: Data) {
        let pending = continuations
        continuations.removeAll()
        // release every unexpected duplicate so failures cannot hang
        for continuation in pending {
            continuation.resume(returning: data)
        }
    }
}

private final class FailingAttemptStore: WeatherWidgetStoring {
    private let cached: WeatherWidgetCachedSnapshot?
    private let attempt: WeatherWidgetAttempt?

    // retain one deterministic old state
    init(cached: WeatherWidgetCachedSnapshot?, attempt: WeatherWidgetAttempt?) {
        self.cached = cached
        self.attempt = attempt
    }

    // return the prior good snapshot
    func loadSnapshot() -> WeatherWidgetCachedSnapshot? {
        cached
    }

    // return the prior successful attempt
    func loadAttempt() -> WeatherWidgetAttempt? {
        attempt
    }

    // keep snapshot writes unused in this failure test
    func saveSnapshot(_ snapshot: WeatherWidgetCachedSnapshot) throws {}

    // simulate an atomic metadata write failure
    func saveAttempt(_ attempt: WeatherWidgetAttempt) throws {
        throw CocoaError(.fileWriteUnknown)
    }
}

private final class StubURLProtocol: URLProtocol {
    static var handler: ((URLRequest, StubURLProtocol) -> Void)?

    // intercept only this test configuration
    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    // preserve the request unchanged
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    // dispatch one installed deterministic handler
    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        handler(request, self)
    }

    // require no cleanup outside request-local cancellation
    override func stopLoading() {}
}
