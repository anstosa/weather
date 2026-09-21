import AppIntents
import Foundation
import os
import SwiftUI
import WidgetKit

struct WeatherWidgetProvider: AppIntentTimelineProvider {
    private static let controller = WeatherWidgetDataController()
    #if DEBUG && WEATHER_V4_PERSISTENCE_PROBE
    private static let persistenceProbe = WeatherWidgetPersistenceProbe()
    #endif
    private let renderer = WeatherWidgetRenderer()
    private let logger = Logger(subsystem: "farm.ballydidean.weather.widget", category: "timeline")

    #if DEBUG
    // bind one whole Debug artifact to one deterministic fixture
    private var compiledFixtureSelection: (selector: String, scenario: WeatherWidgetScenario)? {
        #if WEATHER_M0_FIXTURE_NEAR_CUTOFF
        return ("WEATHER_M0_FIXTURE_NEAR_CUTOFF", .nearCutoff)
        #elseif WEATHER_M0_FIXTURE_BEDTIME
        return ("WEATHER_M0_FIXTURE_BEDTIME", .bedtime)
        #elseif WEATHER_M0_FIXTURE_MAXIMUM
        return ("WEATHER_M0_FIXTURE_MAXIMUM", .maximumDensity)
        #else
        return nil
        #endif
    }

    // bind one whole Debug artifact to one frozen semantic fixture
    private var compiledSemanticFixtureName: String? {
        #if WEATHER_V4_FIXTURE_ADJUSTED
        return "adjusted-standard"
        #elseif WEATHER_V4_FIXTURE_FALL_BACK
        return "fall-back-25"
        #elseif WEATHER_V4_FIXTURE_MIDNIGHT
        return "midnight-race"
        #elseif WEATHER_V4_FIXTURE_MIXED
        return "missing-raw-at-expiry"
        #elseif WEATHER_V4_FIXTURE_SPRING
        return "spring-forward-23"
        #elseif WEATHER_V4_FIXTURE_STALE
        return "stale-old-source"
        #else
        return nil
        #endif
    }
    #endif

    // provide a redacted placeholder
    func placeholder(in context: Context) -> WeatherWidgetEntry {
        #if DEBUG
        // retain only explicitly compiled host-fixture artifacts
        if let selection = compiledFixtureSelection {
            return fixtureEntry(
                configuration: WeatherWidgetConfigurationIntent(),
                selection: selection
            )
        }
        // retain only explicitly compiled semantic-host artifacts
        if let name = compiledSemanticFixtureName,
           let entry = semanticFixtureEntry(named: name) {
            return entry
        }
        #endif
        return WeatherWidgetEntry(
            date: Date(),
            display: .placeholder
        )
    }

    // provide the selected fixture snapshot
    func snapshot(
        for configuration: WeatherWidgetConfigurationIntent,
        in context: Context
    ) async -> WeatherWidgetEntry {
        #if DEBUG && WEATHER_V4_PERSISTENCE_PROBE
        // exercise the real extension store without production traffic
        return await persistenceProbeEntry(configuration: configuration)
        #endif
        #if DEBUG
        // retain only explicitly compiled host-fixture artifacts
        if let selection = compiledFixtureSelection {
            return fixtureEntry(configuration: configuration, selection: selection)
        }
        // retain only explicitly compiled semantic-host artifacts
        if let name = compiledSemanticFixtureName,
           let entry = semanticFixtureEntry(named: name) {
            return entry
        }
        #endif
        // avoid network work in Xcode previews
        if context.isPreview {
            return WeatherWidgetEntry(date: Date(), display: .placeholder)
        }
        let state = await Self.controller.refresh()
        let now = Date()
        return entry(configuration: configuration, state: state, at: now)
    }

    // provide a bounded fixture timeline
    func timeline(
        for configuration: WeatherWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<WeatherWidgetEntry> {
        #if DEBUG && WEATHER_V4_PERSISTENCE_PROBE
        // exercise the same persisted transition for timeline requests
        let currentEntry = await persistenceProbeEntry(configuration: configuration)
        return Timeline(
            entries: [currentEntry],
            policy: .after(Date().addingTimeInterval(30 * 60))
        )
        #endif
        #if DEBUG
        // retain only explicitly compiled host-fixture artifacts
        if let selection = compiledFixtureSelection {
            let currentEntry = fixtureEntry(configuration: configuration, selection: selection)
            return Timeline(
                entries: [currentEntry],
                policy: .after(Date().addingTimeInterval(30 * 60))
            )
        }
        // retain only explicitly compiled semantic-host artifacts
        if let name = compiledSemanticFixtureName,
           let entry = semanticFixtureEntry(named: name) {
            return Timeline(
                entries: [entry],
                policy: .after(Date().addingTimeInterval(30 * 60))
            )
        }
        #endif
        let state = await Self.controller.refresh()
        let now = Date()
        var entries = [entry(configuration: configuration, state: state, at: now)]
        // precompute deterministic cached boundary rerenders
        if let cached = state.cached {
            let dates = renderer.transitionDates(
                snapshot: cached.snapshot,
                acquiredAt: cached.acquiredAt,
                after: now
            )
            entries.append(contentsOf: dates.map { boundary in
                entry(configuration: configuration, state: state, at: boundary)
            })
        }
        return Timeline(
            entries: entries,
            policy: .after(now.addingTimeInterval(30 * 60))
        )
    }

    // render persisted public data with the configured unit
    private func entry(
        configuration: WeatherWidgetConfigurationIntent,
        state: WeatherWidgetLoadState,
        at now: Date
    ) -> WeatherWidgetEntry {
        logger.notice(
            "configuration-unit unit=\(configuration.temperatureUnit.rawValue, privacy: .public)"
        )
        // render an honest unavailable state without a last-good snapshot
        guard let cached = state.cached else {
            return WeatherWidgetEntry(date: now, display: .unavailable)
        }
        let presentation = renderer.render(
            snapshot: cached.snapshot,
            acquiredAt: cached.acquiredAt,
            attempt: state.attempt,
            now: now,
            unit: configuration.temperatureUnit
        )
        return WeatherWidgetEntry(
            date: now,
            display: presentation.display(
                ageAnchor: min(cached.acquiredAt, cached.snapshot.receivedAt),
                attempt: state.attempt
            )
        )
    }

    #if DEBUG
    #if WEATHER_V4_PERSISTENCE_PROBE
    // render one probe state through the production presentation path
    private func persistenceProbeEntry(
        configuration: WeatherWidgetConfigurationIntent
    ) async -> WeatherWidgetEntry {
        let result = await Self.persistenceProbe.load(unit: configuration.temperatureUnit)
        guard let state = result.state else {
            return WeatherWidgetEntry(date: Date(), display: .unavailable)
        }
        let rendered = entry(
            configuration: configuration,
            state: state,
            at: result.renderDate
        )
        return WeatherWidgetEntry(date: Date(), display: rendered.display)
    }
    #endif

    // bind one explicit compiled artifact to deterministic host content
    private func fixtureEntry(
        configuration: WeatherWidgetConfigurationIntent,
        selection: (selector: String, scenario: WeatherWidgetScenario)
    ) -> WeatherWidgetEntry {
        logger.notice(
            "configuration-unit unit=\(configuration.temperatureUnit.rawValue, privacy: .public)"
        )
        let fixture = WeatherWidgetFixtures.fixture(for: selection.scenario)
        logger.notice(
            "m0-compiled-fixture selector=\(selection.selector, privacy: .public) resolved=\(fixture.scenario.rawValue, privacy: .public) groups=\(fixture.groups.count, privacy: .public) intervals=\(fixture.intervalCount, privacy: .public)"
        )
        return WeatherWidgetEntry(
            date: Date(),
            display: fixture.display(unit: configuration.temperatureUnit)
        )
    }

    // decode and render one embedded shared semantic fixture
    private func semanticFixtureEntry(named name: String) -> WeatherWidgetEntry? {
        guard let fixture = try? WeatherWidgetDebugFixtures.fixture(named: name) else {
            logger.error("v4-decoded-fixture invalid name=\(name, privacy: .public)")
            return nil
        }
        let attempt = WeatherWidgetAttempt(
            attemptedAt: fixture.snapshot.receivedAt,
            outcome: .success,
            schemaVersion: WeatherWidgetStore.attemptSchemaVersion
        )
        let presentation = renderer.render(
            snapshot: fixture.snapshot,
            acquiredAt: fixture.snapshot.receivedAt,
            attempt: attempt,
            now: fixture.now,
            unit: fixture.unit
        )
        logger.notice(
            "v4-decoded-fixture name=\(name, privacy: .public) schema=\(fixture.snapshot.schemaVersion, privacy: .public) groups=\(presentation.groups.count, privacy: .public) status=\(presentation.status.rawValue, privacy: .public) stale=\(presentation.stale, privacy: .public) unit=\(fixture.unit.rawValue, privacy: .public)"
        )
        return WeatherWidgetEntry(
            date: fixture.now,
            display: presentation.display(
                ageAnchor: fixture.snapshot.receivedAt,
                attempt: attempt
            )
        )
    }
    #endif
}

struct WeatherForecastWidget: Widget {
    static let kind = WeatherWidgetConfigurationIntent.widgetKind

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
