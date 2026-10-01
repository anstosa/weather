import AppIntents

enum TemperatureUnit: String, Codable, CaseIterable, Hashable {
    case fahrenheit
    case celsius
}

struct WeatherWidgetConfigurationIntent: WidgetConfigurationIntent {
    static let widgetKind = "farm.ballydidean.weather.forecast"
    static var title: LocalizedStringResource = "Weather widget"
    static var description = IntentDescription("Choose the widget temperature unit.")

    @Parameter(title: "Use Celsius", default: false)
    var useCelsius: Bool

    // map the system switch to the existing renderer unit
    var temperatureUnit: TemperatureUnit {
        useCelsius ? .celsius : .fahrenheit
    }

    // let parameter wrappers supply system defaults
    init() {}

    // support explicit unit construction
    init(temperatureUnit: TemperatureUnit) {
        self.useCelsius = temperatureUnit == .celsius
    }
}
