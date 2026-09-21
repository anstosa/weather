import AppIntents
import Foundation
import os
import SwiftUI
import WidgetKit

struct WeatherWidgetProvider: AppIntentTimelineProvider {
    private let logger = Logger(subsystem: "farm.ballydidean.weather.widget", category: "timeline")

    #if DEBUG
    // bind one whole Debug artifact to one deterministic fixture
    private var compiledFixtureSelection: (selector: String, scenario: WeatherWidgetScenario) {
        #if WEATHER_M0_FIXTURE_NEAR_CUTOFF
        return ("WEATHER_M0_FIXTURE_NEAR_CUTOFF", .nearCutoff)
        #elseif WEATHER_M0_FIXTURE_BEDTIME
        return ("WEATHER_M0_FIXTURE_BEDTIME", .bedtime)
        #elseif WEATHER_M0_FIXTURE_MAXIMUM
        return ("WEATHER_M0_FIXTURE_MAXIMUM", .maximumDensity)
        #else
        return ("WEATHER_M0_FIXTURE_DEBUG_DEFAULT", .maximumDensity)
        #endif
    }
    #endif

    // provide a redacted placeholder
    func placeholder(in context: Context) -> WeatherWidgetEntry {
        entry(configuration: WeatherWidgetConfigurationIntent())
    }

    // provide the selected fixture snapshot
    func snapshot(
        for configuration: WeatherWidgetConfigurationIntent,
        in context: Context
    ) async -> WeatherWidgetEntry {
        entry(configuration: configuration)
    }

    // provide a bounded fixture timeline
    func timeline(
        for configuration: WeatherWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<WeatherWidgetEntry> {
        let currentEntry = entry(configuration: configuration)
        logger.notice(
            "fixture=\(currentEntry.fixture.scenario.rawValue, privacy: .public) groups=\(currentEntry.fixture.groups.count, privacy: .public) intervals=\(currentEntry.fixture.intervalCount, privacy: .public)"
        )
        return Timeline(
            entries: [currentEntry],
            policy: .after(Date().addingTimeInterval(30 * 60))
        )
    }

    // bind configuration to fixture content
    private func entry(configuration: WeatherWidgetConfigurationIntent) -> WeatherWidgetEntry {
        #if DEBUG
        let selection = compiledFixtureSelection
        let fixture = WeatherWidgetFixtures.fixture(for: selection.scenario)
        logger.notice(
            "m0-compiled-fixture selector=\(selection.selector, privacy: .public) resolved=\(fixture.scenario.rawValue, privacy: .public) groups=\(fixture.groups.count, privacy: .public) intervals=\(fixture.intervalCount, privacy: .public)"
        )
        #else
        let fixture = WeatherWidgetFixtures.fixture(for: .maximumDensity)
        #endif
        return WeatherWidgetEntry(
            date: Date(),
            configuration: configuration,
            fixture: fixture
        )
    }
}

struct WeatherForecastWidget: Widget {
    static let kind = "farm.ballydidean.weather.forecast"

    // configure one medium widget type
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: Self.kind,
            intent: WeatherWidgetConfigurationIntent.self,
            provider: WeatherWidgetProvider()
        ) { entry in
            WeatherWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Weather until 8 p.m.")
        .description("Adjusted air temperatures, rain, and sunset for Ballydidean.")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}

@main
struct WeatherWidgetBundle: WidgetBundle {
    // expose the forecast widget
    var body: some Widget {
        WeatherForecastWidget()
    }
}
