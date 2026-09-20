import AppIntents

enum TemperatureUnit: String, AppEnum, CaseIterable {
    case fahrenheit
    case celsius

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Temperature unit")
    static var caseDisplayRepresentations: [TemperatureUnit: DisplayRepresentation] = [
        .fahrenheit: "Fahrenheit",
        .celsius: "Celsius"
    ]
}

struct WeatherWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Weather widget"
    static var description = IntentDescription("Choose the widget temperature unit.")

    @Parameter(title: "Temperature unit", default: .fahrenheit)
    var temperatureUnit: TemperatureUnit

    // supply the system default
    init() {
        temperatureUnit = .fahrenheit
    }

    // support deterministic fixtures
    init(temperatureUnit: TemperatureUnit) {
        self.temperatureUnit = temperatureUnit
    }
}
