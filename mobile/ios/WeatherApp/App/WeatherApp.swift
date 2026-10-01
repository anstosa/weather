import os
import SwiftUI
#if DEBUG
import WidgetKit
#endif

@main
struct WeatherApp: App {
    @State private var route: WeatherRoute = .home
    @StateObject private var webViewModel = WeatherWebViewModel()
    #if DEBUG
    @State private var widgetConfigurationDiagnostic = "Widget configuration pending"
    @State private var widgetConfigurationEpoch = 0
    #endif
    private let logger = Logger(subsystem: "farm.ballydidean.weather", category: "route")

    #if DEBUG
    private let usesDeterministicTestDocument = ProcessInfo.processInfo.arguments.contains("-weather-ui-test")
    private let showsWidgetConfigurationDiagnostic = ProcessInfo.processInfo.arguments.contains(
        "-weather-widget-configuration-diagnostic"
    )
    #else
    private let usesDeterministicTestDocument = false
    #endif

    // request only a Debug timeline refresh for host evidence
    init() {
        #if DEBUG
        // snapshot state before logger autoclosure capture
        let deterministicTestDocument = usesDeterministicTestDocument
        // record process-level test mode
        Logger(subsystem: "farm.ballydidean.weather", category: "webview").notice(
            "m0-webview-lifecycle app-init deterministic=\(deterministicTestDocument, privacy: .public)"
        )
        // keep the hook out of production bytes
        if ProcessInfo.processInfo.arguments.contains("-weather-m0-reload-widget") {
            WidgetCenter.shared.reloadTimelines(ofKind: "farm.ballydidean.weather.forecast")
            Logger(subsystem: "farm.ballydidean.weather", category: "widget").notice(
                "widget-reload-requested source=m0-host"
            )
        }
        #endif
    }

    // isolate only deterministic route documents
    private var webViewIdentity: String {
        #if DEBUG
        // recreate WebKit after test-route transitions
        if usesDeterministicTestDocument {
            return route == .forecast ? "test-forecast" : "test-home"
        }
        #endif
        return "hosted"
    }

    // present the hosted Weather experience
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 0) {
                // reserve header space without replacing the hosted WebView
                HStack {
                    // expose safe native history without inventing URLs
                    if webViewModel.canGoBack {
                        Button {
                            webViewModel.goBack()
                        } label: {
                            Image(systemName: "chevron.backward")
                                .frame(width: 44, height: 44)
                                .background(.regularMaterial, in: Circle())
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Back")
                    }
                    Spacer()
                }
                .frame(height: webViewModel.canGoBack ? 52 : 0)
                .padding(.horizontal, 8)
                .background(.regularMaterial)
                ZStack {
                    SecureWeatherWebView(
                        route: route,
                        usesDeterministicTestDocument: usesDeterministicTestDocument,
                        model: webViewModel
                    )
                    // keep retry bound to the last accepted request
                    if let failureMessage = webViewModel.failureMessage {
                        VStack(spacing: 12) {
                            Text(failureMessage)
                            Button("Retry") {
                                webViewModel.retry()
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(uiColor: .systemBackground))
                        .accessibilityIdentifier("weather.load-error")
                    }
                }
            }
            #if DEBUG
            .overlay(alignment: .top) {
                // expose only the supported typed WidgetInfo receipt
                if showsWidgetConfigurationDiagnostic {
                    VStack(spacing: 4) {
                        Text(widgetConfigurationDiagnostic)
                            .accessibilityIdentifier("weather.widget.configuration")
                        Button("Refresh widget configuration") {
                            // issue only an explicit public refresh
                            Task { @MainActor in
                                readWidgetConfigurationDiagnostic()
                            }
                        }
                        .accessibilityIdentifier("weather.widget.configuration.refresh")
                        .accessibilityValue("epoch=\(widgetConfigurationEpoch)")
                    }
                    .padding(8)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
            }
            .task {
                // inspect only when the bounded host test requests it
                if showsWidgetConfigurationDiagnostic {
                    await readWidgetConfigurationDiagnostic()
                }
            }
            #endif
            .id(webViewIdentity)
            .ignoresSafeArea(.container, edges: .bottom)
            .onOpenURL { url in
                // route only the fixed forecast link
                if let requestedRoute = WeatherRoute(deepLink: url) {
                    logger.notice("route=forecast source=deep-link")
                    #if DEBUG
                    logger.notice(
                        "m0-webview-lifecycle deep-link-accepted deterministic=\(usesDeterministicTestDocument, privacy: .public)"
                    )
                    #endif
                    route = requestedRoute
                }
            }
        }
    }

    #if DEBUG
    // read the persisted product unit through WidgetKit's public typed API
    @MainActor
    private func readWidgetConfigurationDiagnostic() {
        widgetConfigurationEpoch += 1
        let epoch = widgetConfigurationEpoch
        let kind = WeatherWidgetConfigurationIntent.widgetKind
        let prefix = "widget-config epoch=\(epoch)"
        widgetConfigurationDiagnostic = "\(prefix) observedAtMs=0 status=pending total=-1 matchCount=-1 kind=\(kind) family=systemMedium entries=none"
        WidgetCenter.shared.getCurrentConfigurations { result in
            let diagnostic: String
            var entries: [String] = []
            switch result {
            case .success(let configurations):
                let weather = configurations.enumerated().filter { _, configuration in
                    configuration.kind == kind && configuration.family == .systemMedium
                }
                var listedUnits: [String] = []
                // preserve bounded observations without inventing placement IDs
                for (index, configuration) in weather.prefix(8) {
                    let unit = configuration.widgetConfigurationIntent(
                        of: WeatherWidgetConfigurationIntent.self
                    )?.temperatureUnit.rawValue ?? "nil"
                    listedUnits.append("\(index):\(unit)")
                    entries.append("widget-config-entry epoch=\(epoch) index=\(index) kind=\(kind) family=systemMedium unit=\(unit)")
                }
                // distinguish complete results from missing, overflow, and untyped
                let status = weather.isEmpty ? "missing" :
                    weather.count > 8 ? "overflow" :
                    listedUnits.contains(where: { $0.hasSuffix(":nil") }) ? "untyped" : "complete"
                let listing = listedUnits.isEmpty ? "none" : listedUnits.joined(separator: ",")
                let observedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                diagnostic = "\(prefix) observedAtMs=\(observedAtMs) status=\(status) total=\(configurations.count) matchCount=\(weather.count) kind=\(kind) family=systemMedium entries=\(listing)"
            case .failure:
                let observedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
                diagnostic = "\(prefix) observedAtMs=\(observedAtMs) status=query-failed total=-1 matchCount=-1 kind=\(kind) family=systemMedium entries=none"
            }
            Task { @MainActor in
                // discard callbacks superseded by a newer public query
                guard epoch == widgetConfigurationEpoch else {
                    logger.notice("widget-info-discarded epoch=\(epoch)")
                    return
                }
                widgetConfigurationDiagnostic = diagnostic
                logger.notice("widget-info \(diagnostic, privacy: .public)")
                // emit only bounded matching entries from the accepted epoch
                for entry in entries {
                    logger.notice("widget-info \(entry, privacy: .public)")
                }
            }
        }
    }
    #endif
}
