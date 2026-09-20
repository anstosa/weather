import Foundation

enum WeatherRoute: Equatable {
    case home
    case forecast

    static let productionOrigin = URL(string: "https://weather.ballydidean.farm")!

    // resolve the fixed hosted route
    var url: URL {
        switch self {
        case .home:
            return Self.productionOrigin
        case .forecast:
            return Self.productionOrigin.appending(path: "forecast")
        }
    }

    // accept only the compiled deep link
    init?(deepLink: URL) {
        guard deepLink.scheme?.lowercased() == "ballydidean-weather",
              deepLink.host?.lowercased() == "forecast",
              deepLink.user == nil,
              deepLink.password == nil,
              deepLink.port == nil,
              deepLink.path.isEmpty,
              deepLink.query == nil,
              deepLink.fragment == nil else {
            return nil
        }
        self = .forecast
    }
}

enum WeatherNavigationDecision: Equatable {
    case hosted
    case external(URL)
    case rejected
}

enum WeatherNavigationPolicy {
    // classify before WebKit acts
    static func decision(for url: URL) -> WeatherNavigationDecision {
        guard url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased() else {
            return .rejected
        }

        // keep Weather inside its trusted origin
        if host == WeatherRoute.productionOrigin.host {
            return .hosted
        }

        // hand safe external web links to the system
        return .external(url)
    }
}
