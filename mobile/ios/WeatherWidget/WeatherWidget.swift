import AppIntents
import Foundation
import os
import SwiftUI
import WidgetKit

struct WeatherWidgetProvider: AppIntentTimelineProvider {
    private let logger = Logger(subsystem: "farm.ballydidean.weather.widget", category: "timeline")

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
        let overrideValue = ProcessInfo.processInfo.environment["WEATHER_WIDGET_FIXTURE"]
        // parse only known fixture cases
        let overrideScenario = overrideValue.flatMap { WeatherWidgetScenario(rawValue: $0) }
        let overrideReceipt: String
        // classify only the dedicated fixture override
        switch (overrideValue, overrideScenario) {
        case (nil, _):
            overrideReceipt = "absent"
        case (_, nil):
            overrideReceipt = "invalid"
        case (_, let scenario?):
            overrideReceipt = scenario.rawValue
        }
        let fixture = WeatherWidgetFixtures.configured(configuration.fixtureScenario.scenario)
        logger.notice(
            "m0-fixture-resolution input=\(configuration.fixtureScenario.rawValue, privacy: .public) override=\(overrideReceipt, privacy: .public) resolved=\(fixture.scenario.rawValue, privacy: .public)"
        )
        #else
        let fixture = WeatherWidgetFixtures.active
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
