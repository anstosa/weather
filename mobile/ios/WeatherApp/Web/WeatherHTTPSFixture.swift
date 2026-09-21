#if DEBUG
import Foundation

struct WeatherHTTPSFixtureConfiguration: Equatable {
    static let launchArgument = "-weather-https-fixture"
    static let pathArgument = "-weather-https-fixture-path"
    static let trustedOriginEnvironment = "WEATHER_HTTPS_FIXTURE_IOS_ORIGIN"
    static let untrustedOriginEnvironment = "WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN"

    let startPath: String
    let trustedOrigin: URL
    let untrustedOrigin: URL

    // identify an explicit fixture launch
    static func isRequested(arguments: [String]) -> Bool {
        arguments.contains(Self.launchArgument)
    }

    // parse only the frozen loopback fixture contract
    static func load(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> WeatherHTTPSFixtureConfiguration? {
        // refuse ambient environment variables without the launch gate
        guard isRequested(arguments: arguments),
              let trustedValue = environment[trustedOriginEnvironment],
              let untrustedValue = environment[untrustedOriginEnvironment],
              let trustedOrigin = exactOrigin(trustedValue, port: 18_443),
              let untrustedOrigin = exactOrigin(untrustedValue, port: 18_444),
              trustedOrigin != untrustedOrigin,
              let startPath = requestedPath(arguments: arguments) else {
            return nil
        }
        return WeatherHTTPSFixtureConfiguration(
            startPath: startPath,
            trustedOrigin: trustedOrigin,
            untrustedOrigin: untrustedOrigin
        )
    }

    // build the allowlisted initial fixture request
    var startURL: URL {
        // preserve the exact origin URL for the fixture root
        if startPath == "/" {
            return trustedOrigin
        }
        return trustedOrigin.appending(path: String(startPath.dropFirst()))
    }

    // build the fixed forecast route inside the fixture
    var forecastURL: URL {
        trustedOrigin.appending(path: "forecast")
    }

    // accept only either frozen fixture origin
    func contains(_ url: URL) -> Bool {
        matches(url, origin: trustedOrigin) || matches(url, origin: untrustedOrigin)
    }

    // compare scheme, host, and explicit port without path influence
    private func matches(_ url: URL, origin: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme &&
            url.host?.lowercased() == origin.host &&
            url.port == origin.port &&
            url.user == nil &&
            url.password == nil
    }

    // validate one exact https loopback origin
    private static func exactOrigin(_ value: String, port: Int) -> URL? {
        guard let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.host == "127.0.0.1",
              url.port == port,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            return nil
        }
        return url
    }

    // accept only fixture routes with frozen deterministic behavior
    private static func requestedPath(arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: pathArgument) else {
            return "/admin"
        }
        let valueIndex = arguments.index(after: index)
        guard arguments.indices.contains(valueIndex) else {
            return nil
        }
        let path = arguments[valueIndex]
        let allowed = ["/", "/admin", "/forecast", "/logs", "/map", "/policy", "/settings", "/trends"]
        return allowed.contains(path) ? path : nil
    }
}
#endif
