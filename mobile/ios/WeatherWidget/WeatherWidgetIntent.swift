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
// isolate test-only AppIntent metadata
enum WeatherWidgetFixtureSelection: String, AppEnum, CaseIterable {
    case maximumDensity
    case nearCutoff
    case bedtime

    // identify the internal matrix control
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "M0 fixture")
    // expose only compiled fixture choices
    static var caseDisplayRepresentations: [WeatherWidgetFixtureSelection: DisplayRepresentation] = [
        .maximumDensity: "Maximum density M0",
        .nearCutoff: "Near cutoff M0",
        .bedtime: "Bedtime M0"
    ]

    // map the test-only parameter to fixture data
    var scenario: WeatherWidgetScenario {
        // map every declared selection explicitly
        switch self {
        case .maximumDensity:
            return .maximumDensity
        case .nearCutoff:
            return .nearCutoff
        case .bedtime:
            return .bedtime
        }
    }
}
#endif

struct WeatherWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Weather widget"
    static var description = IntentDescription("Choose the widget temperature unit.")

    @Parameter(title: "Temperature unit", default: .fahrenheit)
    var temperatureUnit: TemperatureUnit

    #if DEBUG
    @Parameter(title: "M0 fixture", default: .maximumDensity)
    var fixtureScenario: WeatherWidgetFixtureSelection
    #endif

    // let parameter wrappers supply system defaults
    init() {}

    // support deterministic fixtures
    init(temperatureUnit: TemperatureUnit) {
        self.temperatureUnit = temperatureUnit
        #if DEBUG
        fixtureScenario = .maximumDensity
        #endif
    }

    #if DEBUG
    // support explicit host-matrix fixtures
    init(temperatureUnit: TemperatureUnit, fixtureScenario: WeatherWidgetFixtureSelection) {
        self.temperatureUnit = temperatureUnit
        self.fixtureScenario = fixtureScenario
    }
    #endif
}
