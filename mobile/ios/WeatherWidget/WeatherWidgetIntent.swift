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

#if DEBUG
extension WeatherWidgetScenario: AppEnum {
    // identify the internal matrix control
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "M0 fixture")
    // expose only compiled fixture cases
    static var caseDisplayRepresentations: [WeatherWidgetScenario: DisplayRepresentation] = [
        .maximumDensity: "Maximum density M0",
        .nearCutoff: "Near cutoff M0",
        .bedtime: "Bedtime M0"
    ]
}
#endif

struct WeatherWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Weather widget"
    static var description = IntentDescription("Choose the widget temperature unit.")

    @Parameter(title: "Temperature unit", default: .fahrenheit)
    var temperatureUnit: TemperatureUnit

    #if DEBUG
    @Parameter(title: "M0 fixture", default: .maximumDensity)
    var fixtureScenario: WeatherWidgetScenario
    #endif

    // supply the system default
    init() {
        temperatureUnit = .fahrenheit
        #if DEBUG
        fixtureScenario = .maximumDensity
        #endif
    }

    // support deterministic fixtures
    init(temperatureUnit: TemperatureUnit) {
        self.temperatureUnit = temperatureUnit
        #if DEBUG
        fixtureScenario = .maximumDensity
        #endif
    }

    #if DEBUG
    // support explicit host-matrix fixtures
    init(temperatureUnit: TemperatureUnit, fixtureScenario: WeatherWidgetScenario) {
        self.temperatureUnit = temperatureUnit
        self.fixtureScenario = fixtureScenario
    }
    #endif
}
