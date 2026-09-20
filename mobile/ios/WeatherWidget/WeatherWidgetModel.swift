import Foundation

enum WeatherCondition: Int, CaseIterable, Comparable {
    case dry = 0
    case sprinkle = 1
    case rain = 2

    // choose the wettest hour
    static func < (lhs: WeatherCondition, rhs: WeatherCondition) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    // map the display symbol
    var symbolName: String {
        switch self {
        case .dry:
            return "sun.max.fill"
        case .sprinkle:
            return "cloud.drizzle.fill"
        case .rain:
            return "cloud.rain.fill"
        }
    }

    // name the accessible condition
    var accessibilityName: String {
        switch self {
        case .dry:
            return "dry"
        case .sprinkle:
            return "sprinkle"
        case .rain:
            return "rain"
        }
    }
}

struct WeatherHourGroup: Identifiable, Equatable {
    let id: Int
    let intervalIndexes: [Int]
    let timeLabel: String
    let accessibilityTimeLabel: String
    let minimumTemperatureCelsius: Double
    let maximumTemperatureCelsius: Double
    let condition: WeatherCondition

    // format an adjusted-air range
    func temperatureLabel(unit: TemperatureUnit) -> String {
        let minimum = roundedTemperature(minimumTemperatureCelsius, unit: unit)
        let maximum = roundedTemperature(maximumTemperatureCelsius, unit: unit)
        let suffix = unit == .fahrenheit ? "°F" : "°C"

        // avoid duplicate range endpoints
        if minimum == maximum {
            return "\(minimum)\(suffix)"
        }
        return "\(minimum)–\(maximum)\(suffix)"
    }

    // describe the complete group
    func accessibilityLabel(unit: TemperatureUnit) -> String {
        "\(accessibilityTimeLabel), adjusted air temperature \(temperatureLabel(unit: unit)), \(condition.accessibilityName)"
    }

    // convert and round for compact display
    private func roundedTemperature(_ celsius: Double, unit: TemperatureUnit) -> Int {
        switch unit {
        case .fahrenheit:
            return Int((celsius * 9 / 5 + 32).rounded())
        case .celsius:
            return Int(celsius.rounded())
        }
    }
}

enum WeatherWidgetScenario: String, CaseIterable {
    case maximumDensity
    case nearCutoff
    case bedtime
}

struct WeatherWidgetFixture: Equatable {
    static let slotCapacity = 7
    // preserve the verified dense presentation
    static let widgetVisualFontSize: Double = 12

    let scenario: WeatherWidgetScenario
    let generatedAt: Date
    let groups: [WeatherHourGroup]
    let sunsetLabel: String
    let statusLabel: String
    let bedtimeMessage: String?

    // expose whether attribution is required
    var showsWeather: Bool {
        !groups.isEmpty
    }

    // count real forecast intervals
    var intervalCount: Int {
        groups.reduce(0) { count, group in
            count + group.intervalIndexes.count
        }
    }

    // build one combined accessible summary
    func accessibilitySummary(unit: TemperatureUnit) -> String {
        var parts = ["\(intervalCount) forecast intervals in \(groups.count) groups"]
        parts.append(contentsOf: groups.map { group in
            group.accessibilityLabel(unit: unit)
        })
        parts.append(sunsetLabel)
        parts.append(statusLabel)

        // announce the exact bedtime state
        if let bedtimeMessage {
            parts.append(bedtimeMessage)
        }

        // announce visible data credit
        if showsWeather {
            parts.append("Weather data by Open-Meteo under CC BY 4.0")
        }
        return parts.joined(separator: ". ")
    }
}
