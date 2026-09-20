import os
import SwiftUI

@main
struct WeatherApp: App {
    @State private var route: WeatherRoute = .home
    private let logger = Logger(subsystem: "farm.ballydidean.weather", category: "route")

    #if DEBUG
    private let usesDeterministicTestDocument = ProcessInfo.processInfo.arguments.contains("-weather-ui-test")
    #else
    private let usesDeterministicTestDocument = false
    #endif

    // present the hosted Weather experience
    var body: some Scene {
        WindowGroup {
            SecureWeatherWebView(
                route: route,
                usesDeterministicTestDocument: usesDeterministicTestDocument
            )
            .ignoresSafeArea(.container, edges: .bottom)
            .onOpenURL { url in
                // route only the fixed forecast link
                if let requestedRoute = WeatherRoute(deepLink: url) {
                    logger.notice("route=forecast source=deep-link")
                    route = requestedRoute
                }
            }
        }
    }
}
