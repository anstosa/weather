import Foundation

enum WeatherWidgetStatus: String, Codable, CaseIterable {
    case adjusted
    case mixed
    case raw
    case unavailable
}

enum WeatherWidgetValueMode: String, Codable, CaseIterable {
    case adjusted
    case raw
    case unavailable
}

enum WeatherWidgetValueReason: String, Codable, CaseIterable {
    case deadlineExpired = "deadline_expired"
    case deadlineUnavailable = "deadline_unavailable"
    case genericAdjustment = "generic_adjustment"
    case independentAdjustment = "independent_adjustment"
    case missing
    case rainAdjustment = "rain_adjustment"
    case rawForecast = "raw_forecast"
}

struct WeatherWidgetSource: Codable, Equatable {
    let receivedAt: Date
    let runAt: Date?
}

struct WeatherWidgetValue: Codable, Equatable {
    let mode: WeatherWidgetValueMode
    let raw: Double?
    let rawSource: WeatherWidgetSource?
    let reason: WeatherWidgetValueReason
    let selected: Double?
    let selectedSource: WeatherWidgetSource?
    let selectedUntil: Date?
}

struct WeatherWidgetHour: Codable, Equatable {
    let end: Date
    let rainMmPerHour: WeatherWidgetValue
    let start: Date
    let temperatureC: WeatherWidgetValue
}

struct WeatherWidgetAttribution: Codable, Equatable {
    let label: String
    let licenseUrl: URL
    let providerUrl: URL
}

struct WeatherWidgetCalendar: Codable, Equatable {
    let cutoff: Date
    let date: String
    let dayEnd: Date
    let dayStart: Date
    let sunset: Date?
}

struct WeatherWidgetSite: Codable, Equatable {
    let latitude: Double
    let longitude: Double
    let name: String
    let slug: String
    let timezone: String
}

struct WeatherWidgetSnapshot: Codable, Equatable {
    let attribution: WeatherWidgetAttribution
    let calendar: WeatherWidgetCalendar
    let generatedAt: Date
    let hours: [WeatherWidgetHour]
    let receivedAt: Date
    let schemaVersion: String
    let site: WeatherWidgetSite
    let status: WeatherWidgetStatus
}

enum WeatherWidgetContract {
    static let schemaVersion = "weather-widget/v1"
    static let semanticSchemaVersion = "weather-widget-semantic/v1"
    static let attributionLabel = "Open-Meteo · CC BY 4.0"
    static let providerURL = URL(string: "https://open-meteo.com/")!
    static let licenseURL = URL(string: "https://creativecommons.org/licenses/by/4.0/")!
    static let siteName = "Ballydidean"
    static let siteSlug = "ballydidean"
    static let siteTimezone = "America/Los_Angeles"
    static let siteLatitude = 47.950429954185445
    static let siteLongitude = -122.42797012608193
    static let maximumPayloadBytes = 128 * 1_024
    static let widgetVisualFontSize: Double = 12
}

enum WeatherWidgetContractError: Error, Equatable {
    case invalid(String)
    case oversized
}

enum WeatherWidgetDateCodec {
    private static let pattern = try! NSRegularExpression(
        pattern: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"#
    )

    // parse only the contract's millisecond UTC shape
    static func date(from value: String) -> Date? {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        // reject timestamps outside the frozen wire format
        guard pattern.firstMatch(in: value, range: range) != nil else {
            return nil
        }
        return formatter.date(from: value)
    }

    // format stable wire timestamps
    static func string(from date: Date) -> String {
        formatter.string(from: date)
    }

    // construct one strict JSON decoder
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            // reject relaxed Foundation timestamp parsing
            guard let date = date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "invalid widget instant"
                )
            }
            return date
        }
        return decoder
    }

    // construct one stable JSON encoder
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(string(from: date))
        }
        return encoder
    }

    private static let formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()
}

struct WeatherWidgetSnapshotDecoder {
    // decode and validate one public snapshot
    func decode(_ data: Data) throws -> WeatherWidgetSnapshot {
        // enforce the native payload boundary before allocation-heavy decoding
        guard data.count <= WeatherWidgetContract.maximumPayloadBytes else {
            throw WeatherWidgetContractError.oversized
        }
        try validateObjectShape(data)
        let snapshot: WeatherWidgetSnapshot
        do {
            snapshot = try WeatherWidgetDateCodec.decoder().decode(
                WeatherWidgetSnapshot.self,
                from: data
            )
        } catch {
            throw WeatherWidgetContractError.invalid("decode")
        }
        try validate(snapshot)
        return snapshot
    }

    // validate decoded semantic invariants
    func validate(_ snapshot: WeatherWidgetSnapshot) throws {
        try require(snapshot.schemaVersion == WeatherWidgetContract.schemaVersion, "schema")
        try validateAttribution(snapshot.attribution)
        try validateSite(snapshot.site)
        try validateCalendar(snapshot)
        try validateHours(snapshot)
        try validateStatus(snapshot)
    }

    // reject unknown and missing object keys
    private func validateObjectShape(_ data: Data) throws {
        let payload: Any
        do {
            payload = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw WeatherWidgetContractError.invalid("json")
        }
        let root = try object(payload, keys: [
            "attribution", "calendar", "generatedAt", "hours", "receivedAt",
            "schemaVersion", "site", "status"
        ], label: "root")
        _ = try object(root["attribution"], keys: [
            "label", "licenseUrl", "providerUrl"
        ], label: "attribution")
        _ = try object(root["calendar"], keys: [
            "cutoff", "date", "dayEnd", "dayStart", "sunset"
        ], label: "calendar")
        _ = try object(root["site"], keys: [
            "latitude", "longitude", "name", "slug", "timezone"
        ], label: "site")
        guard let hours = root["hours"] as? [Any] else {
            throw WeatherWidgetContractError.invalid("hours")
        }
        // validate every fixed hour object
        for (index, payload) in hours.enumerated() {
            let hour = try object(payload, keys: [
                "end", "rainMmPerHour", "start", "temperatureC"
            ], label: "hour-\(index)")
            try validateValueShape(hour["temperatureC"], label: "temperature-\(index)")
            try validateValueShape(hour["rainMmPerHour"], label: "rain-\(index)")
        }
    }

    // validate one value object's nested keys
    private func validateValueShape(_ payload: Any?, label: String) throws {
        let value = try object(payload, keys: [
            "mode", "raw", "rawSource", "reason", "selected", "selectedSource",
            "selectedUntil"
        ], label: label)
        // validate each optional source object when present
        for key in ["rawSource", "selectedSource"] {
            // skip explicit JSON nulls
            if let source = value[key], !(source is NSNull) {
                _ = try object(source, keys: ["receivedAt", "runAt"], label: "\(label)-\(key)")
            }
        }
    }

    // require an exact object-key set
    private func object(_ value: Any?, keys: Set<String>, label: String) throws -> [String: Any] {
        guard let object = value as? [String: Any], Set(object.keys) == keys else {
            throw WeatherWidgetContractError.invalid(label)
        }
        return object
    }

    // validate fixed attribution values
    private func validateAttribution(_ attribution: WeatherWidgetAttribution) throws {
        try require(attribution.label == WeatherWidgetContract.attributionLabel, "attribution-label")
        try require(attribution.providerUrl == WeatherWidgetContract.providerURL, "provider-url")
        try require(attribution.licenseUrl == WeatherWidgetContract.licenseURL, "license-url")
    }

    // validate the single supported public site
    private func validateSite(_ site: WeatherWidgetSite) throws {
        try require(site.slug == WeatherWidgetContract.siteSlug, "site-slug")
        try require(site.name == WeatherWidgetContract.siteName, "site-name")
        try require(site.timezone == WeatherWidgetContract.siteTimezone, "site-timezone")
        try require(site.latitude == WeatherWidgetContract.siteLatitude, "site-latitude")
        try require(site.longitude == WeatherWidgetContract.siteLongitude, "site-longitude")
    }

    // validate the generated-at-anchored site calendar
    private func validateCalendar(_ snapshot: WeatherWidgetSnapshot) throws {
        guard let timezone = TimeZone(identifier: WeatherWidgetContract.siteTimezone) else {
            throw WeatherWidgetContractError.invalid("timezone")
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timezone
        let generatedComponents = calendar.dateComponents(
            [.year, .month, .day],
            from: snapshot.generatedAt
        )
        guard let year = generatedComponents.year,
              let month = generatedComponents.month,
              let day = generatedComponents.day else {
            throw WeatherWidgetContractError.invalid("calendar-components")
        }
        let dateLabel = String(format: "%04d-%02d-%02d", year, month, day)
        let expectedStart = calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: 0)
        )
        let expectedCutoff = calendar.date(
            from: DateComponents(year: year, month: month, day: day, hour: 20)
        )
        let expectedEnd = expectedStart.flatMap {
            calendar.date(byAdding: .day, value: 1, to: $0)
        }
        try require(snapshot.calendar.date == dateLabel, "calendar-date")
        try require(snapshot.calendar.dayStart == expectedStart, "calendar-start")
        try require(snapshot.calendar.cutoff == expectedCutoff, "calendar-cutoff")
        try require(snapshot.calendar.dayEnd == expectedEnd, "calendar-end")
        try require(snapshot.generatedAt <= snapshot.receivedAt, "receipt-order")
        try require(
            snapshot.generatedAt >= snapshot.calendar.dayStart &&
                snapshot.generatedAt < snapshot.calendar.dayEnd,
            "generated-at-day"
        )
        // keep sunset attached only to its anchored day
        if let sunset = snapshot.calendar.sunset {
            try require(
                sunset >= snapshot.calendar.dayStart && sunset < snapshot.calendar.dayEnd,
                "sunset-day"
            )
        }
    }

    // validate the complete 23/24/25-hour grid
    private func validateHours(_ snapshot: WeatherWidgetSnapshot) throws {
        let expectedCount = Int(
            snapshot.calendar.dayEnd.timeIntervalSince(snapshot.calendar.dayStart) / 3_600
        )
        try require((23...25).contains(expectedCount), "day-length")
        try require(snapshot.hours.count == expectedCount, "hour-count")
        var expectedStart = snapshot.calendar.dayStart
        // validate each contiguous physical hour
        for (index, hour) in snapshot.hours.enumerated() {
            try require(hour.start == expectedStart, "hour-start-\(index)")
            try require(hour.end.timeIntervalSince(hour.start) == 3_600, "hour-width-\(index)")
            try validateValue(
                hour.temperatureC,
                bounds: -100...70,
                field: .temperature,
                generatedAt: snapshot.generatedAt,
                envelopeReceivedAt: snapshot.receivedAt,
                label: "temperature-\(index)"
            )
            try validateValue(
                hour.rainMmPerHour,
                bounds: 0...2_000,
                field: .rain,
                generatedAt: snapshot.generatedAt,
                envelopeReceivedAt: snapshot.receivedAt,
                label: "rain-\(index)"
            )
            expectedStart = hour.end
        }
        try require(expectedStart == snapshot.calendar.dayEnd, "grid-end")
    }

    private enum FieldKind {
        case rain
        case temperature
    }

    // validate one field's mode and source clocks
    private func validateValue(
        _ value: WeatherWidgetValue,
        bounds: ClosedRange<Double>,
        field: FieldKind,
        generatedAt: Date,
        envelopeReceivedAt: Date,
        label: String
    ) throws {
        try validateNumber(value.raw, bounds: bounds, label: "\(label)-raw")
        try validateNumber(value.selected, bounds: bounds, label: "\(label)-selected")
        try validateSource(
            value.rawSource,
            generatedAt: generatedAt,
            envelopeReceivedAt: envelopeReceivedAt,
            label: "\(label)-raw-source"
        )
        try validateSource(
            value.selectedSource,
            generatedAt: generatedAt,
            envelopeReceivedAt: envelopeReceivedAt,
            label: "\(label)-selected-source"
        )

        switch value.mode {
        case .adjusted:
            let allowedReasons: Set<WeatherWidgetValueReason> = field == .temperature
                ? [.genericAdjustment, .independentAdjustment]
                : [.genericAdjustment, .rainAdjustment]
            try require(value.selected != nil, "\(label)-adjusted-selected")
            try require(value.selectedSource != nil, "\(label)-adjusted-source")
            try require(value.selectedUntil != nil, "\(label)-adjusted-until")
            try require(
                value.selectedUntil.map {
                    $0 > generatedAt && $0 <= generatedAt.addingTimeInterval(90 * 60)
                } == true,
                "\(label)-adjusted-deadline"
            )
            try require((value.raw == nil) == (value.rawSource == nil), "\(label)-raw-pair")
            try require(allowedReasons.contains(value.reason), "\(label)-adjusted-reason")
        case .raw:
            try require(value.raw != nil && value.selected == value.raw, "\(label)-raw-value")
            try require(value.rawSource != nil, "\(label)-raw-source")
            try require(value.selectedSource == nil, "\(label)-raw-selected-source")
            try require(value.selectedUntil == nil, "\(label)-raw-until")
            try require(
                [.deadlineExpired, .deadlineUnavailable, .rawForecast].contains(value.reason),
                "\(label)-raw-reason"
            )
        case .unavailable:
            try require(value.raw == nil && value.selected == nil, "\(label)-unavailable-value")
            try require(value.rawSource == nil && value.selectedSource == nil, "\(label)-unavailable-source")
            try require(value.selectedUntil == nil, "\(label)-unavailable-until")
            try require(value.reason == .missing, "\(label)-unavailable-reason")
        }
    }

    // validate a finite field-specific number
    private func validateNumber(
        _ number: Double?,
        bounds: ClosedRange<Double>,
        label: String
    ) throws {
        // allow the contract's explicit unavailable null
        guard let number else {
            return
        }
        try require(number.isFinite && bounds.contains(number), label)
    }

    // validate source ordering and envelope containment
    private func validateSource(
        _ source: WeatherWidgetSource?,
        generatedAt: Date,
        envelopeReceivedAt: Date,
        label: String
    ) throws {
        // allow the contract's explicit unavailable source
        guard let source else {
            return
        }
        try require(
            source.receivedAt <= generatedAt && generatedAt <= envelopeReceivedAt,
            "\(label)-receipt"
        )
        // keep product runs no later than their receipt
        if let runAt = source.runAt {
            try require(runAt <= source.receivedAt, "\(label)-run")
        }
    }

    // validate authoritative aggregate status
    private func validateStatus(_ snapshot: WeatherWidgetSnapshot) throws {
        let modes = snapshot.hours.flatMap { hour in
            [hour.temperatureC.mode, hour.rainMmPerHour.mode]
        }
        let expected: WeatherWidgetStatus
        // reduce the mode set to the public aggregate status
        if modes.allSatisfy({ $0 == .adjusted }) {
            expected = .adjusted
        } else if modes.allSatisfy({ $0 == .raw }) {
            expected = .raw
        } else if modes.allSatisfy({ $0 == .unavailable }) {
            expected = .unavailable
        } else {
            expected = .mixed
        }
        try require(snapshot.status == expected, "status")
    }

    // throw one bounded validation category
    private func require(_ condition: @autoclosure () -> Bool, _ label: String) throws {
        // reject the named invariant without exposing payload bytes
        guard condition() else {
            throw WeatherWidgetContractError.invalid(label)
        }
    }
}
