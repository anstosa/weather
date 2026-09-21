import AppIntents

enum TemperatureUnit: String, AppEnum, Codable, CaseIterable {
    case fahrenheit
    case celsius

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Temperature unit")
    static var caseDisplayRepresentations: [TemperatureUnit: DisplayRepresentation] = [
        .fahrenheit: "Fahrenheit",
        .celsius: "Celsius"
    ]
}

struct WeatherWidgetConfigurationIntent: WidgetConfigurationIntent {
    static let widgetKind = "farm.ballydidean.weather.forecast"
    static var title: LocalizedStringResource = "Weather widget"
    static var description = IntentDescription("Choose the widget temperature unit.")

    @Parameter(title: "Temperature unit", default: .fahrenheit)
    var temperatureUnit: TemperatureUnit

    // let parameter wrappers supply system defaults
    init() {}

    // support explicit unit construction
    init(temperatureUnit: TemperatureUnit) {
        self.temperatureUnit = temperatureUnit
    }
}
