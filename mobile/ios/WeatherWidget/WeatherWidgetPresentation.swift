import Foundation

enum WeatherWidgetPresentationKind: String, Codable {
    case bedtime
    case unavailable
    case weather
}

struct WeatherWidgetTemperatureRange: Codable, Equatable {
    let label: String
    let maximum: Int
    let minimum: Int
}

struct WeatherWidgetSemanticGroup: Codable, Equatable, Identifiable {
    var id: Date { start }

    let condition: WeatherCondition
    let end: Date
    let hourCount: Int
    let isNow: Bool
    let start: Date
    let status: WeatherWidgetStatus
    let temperature: WeatherWidgetTemperatureRange?
}

struct WeatherWidgetFooter: Codable, Equatable {
    let attribution: String
    let generatedAt: Date
    let status: WeatherWidgetStatus
    let sunset: Date?
}

struct WeatherWidgetPresentation: Codable, Equatable {
    let bedtime: Bool
    let date: String
    let footer: WeatherWidgetFooter
    let groups: [WeatherWidgetSemanticGroup]
    let hardExpired: Bool
    let now: Date
    let presentation: WeatherWidgetPresentationKind
    let schemaVersion: String
    let stale: Bool
    let status: WeatherWidgetStatus
    let unit: TemperatureUnit
}

struct WeatherWidgetDisplayGroup: Identifiable, Equatable {
    let id: Int
    let accessibilityLabel: String
    let condition: WeatherCondition
    let temperatureLabel: String
    let timeLabel: String
}

struct WeatherWidgetDisplay: Equatable {
    let accessibilitySummary: String
    let attributionLabel: String?
    let bedtimeMessage: String?
    let groups: [WeatherWidgetDisplayGroup]
    let statusLabel: String
    let sunsetLabel: String?
    let unavailableMessage: String?

    // expose whether licensed weather is visible
    var showsWeather: Bool {
        !groups.isEmpty
    }

    // provide a redacted gallery placeholder
    static let placeholder = WeatherWidgetDisplay(
        accessibilitySummary: "Weather forecast loading",
        attributionLabel: nil,
        bedtimeMessage: nil,
        groups: [],
        statusLabel: "Loading",
        sunsetLabel: nil,
        unavailableMessage: "weather loading"
    )

    // provide an honest no-cache result
    static let unavailable = WeatherWidgetDisplay(
        accessibilitySummary: "Weather unavailable",
        attributionLabel: nil,
        bedtimeMessage: nil,
        groups: [],
        statusLabel: "Unavailable",
        sunsetLabel: nil,
        unavailableMessage: "weather unavailable"
    )
}

enum WeatherWidgetAttemptOutcome: String, Codable, CaseIterable {
    case invalidResponse = "invalid_response"
    case offline
    case serverError = "server_error"
    case storageError = "storage_error"
    case success
    case timeout

    // identify a known failed refresh
    var isFailure: Bool {
        self != .success
    }
}

struct WeatherWidgetAttempt: Codable, Equatable {
    let attemptedAt: Date
    let outcome: WeatherWidgetAttemptOutcome
    let schemaVersion: String
    let snapshotAcquiredAt: Date?
    let snapshotIdentifier: UUID?

    // bind successful metadata to one exact cached record
    init(
        attemptedAt: Date,
        outcome: WeatherWidgetAttemptOutcome,
        schemaVersion: String,
        snapshotAcquiredAt: Date? = nil,
        snapshotIdentifier: UUID? = nil
    ) {
        self.attemptedAt = attemptedAt
        self.outcome = outcome
        self.schemaVersion = schemaVersion
        self.snapshotAcquiredAt = snapshotAcquiredAt
        self.snapshotIdentifier = snapshotIdentifier
    }
}

struct WeatherWidgetCachedSnapshot: Codable, Equatable {
    let acquiredAt: Date
    let schemaVersion: String
    let snapshot: WeatherWidgetSnapshot
    let snapshotIdentifier: UUID

    // assign one collision-resistant persistence transaction identity
    init(
        acquiredAt: Date,
        schemaVersion: String,
        snapshot: WeatherWidgetSnapshot,
        snapshotIdentifier: UUID = UUID()
    ) {
        self.acquiredAt = acquiredAt
        self.schemaVersion = schemaVersion
        self.snapshot = snapshot
        self.snapshotIdentifier = snapshotIdentifier
    }
}

struct WeatherWidgetResolvedValue {
    let mode: WeatherWidgetValueMode
    let sourceClock: Date?
    let value: Double?
}

struct WeatherWidgetRenderer {
    private static let slotCapacity = 7
    private static let staleAcquisitionAge: TimeInterval = 90 * 60
    private static let staleSourceAge: TimeInterval = 12 * 60 * 60
    private static let maximumAcquisitionAge: TimeInterval = 24 * 60 * 60

    // derive all visible semantics from one injected clock
    func render(
        snapshot: WeatherWidgetSnapshot,
        acquiredAt: Date,
        attempt: WeatherWidgetAttempt?,
        now: Date,
        unit: TemperatureUnit
    ) -> WeatherWidgetPresentation {
        let receiptExpiry = snapshot.receivedAt.addingTimeInterval(Self.maximumAcquisitionAge)
        let acquisitionExpiry = acquiredAt.addingTimeInterval(Self.maximumAcquisitionAge)
        let hardExpiry = min(snapshot.calendar.dayEnd, min(receiptExpiry, acquisitionExpiry))
        let hardExpired = now >= hardExpiry

        // never resurrect numeric or solar data at hard expiry
        if hardExpired {
            return unavailablePresentation(snapshot: snapshot, now: now, unit: unit)
        }

        let hours = snapshot.hours.filter { hour in
            hour.end > now && hour.start < snapshot.calendar.cutoff
        }
        let width = min(3, max(1, Int(ceil(Double(hours.count) / Double(Self.slotCapacity)))))
        var groups: [WeatherWidgetSemanticGroup] = []

        // group every remaining physical hour exactly once
        for startIndex in stride(from: 0, to: hours.count, by: width) {
            let endIndex = min(startIndex + width, hours.count)
            let slice = Array(hours[startIndex..<endIndex])
            groups.append(group(hours: slice, now: now, unit: unit))
        }

        let allResolved = hours.flatMap { hour in
            [resolve(hour.temperatureC, now: now), resolve(hour.rainMmPerHour, now: now)]
        }
        let status = hours.isEmpty
            ? snapshot.status
            : aggregateStatus(allResolved.map(\.mode))
        let sourceClocks = allResolved.compactMap(\.sourceClock)
        let failedAttempt = attempt.map { candidate in
            candidate.outcome.isFailure && candidate.attemptedAt >= acquiredAt
        } ?? false
        let stale = clockIsStale(acquiredAt, now: now, limit: Self.staleAcquisitionAge) ||
            clockIsStale(snapshot.receivedAt, now: now, limit: Self.staleAcquisitionAge) ||
            sourceClocks.contains { clockIsStale($0, now: now, limit: Self.staleSourceAge) } ||
            failedAttempt

        return WeatherWidgetPresentation(
            bedtime: groups.count < Self.slotCapacity,
            date: snapshot.calendar.date,
            footer: WeatherWidgetFooter(
                attribution: snapshot.attribution.label,
                generatedAt: snapshot.generatedAt,
                status: status,
                sunset: snapshot.calendar.sunset
            ),
            groups: groups,
            hardExpired: false,
            now: now,
            presentation: groups.isEmpty ? .bedtime : .weather,
            schemaVersion: WeatherWidgetContract.semanticSchemaVersion,
            stale: stale,
            status: status,
            unit: unit
        )
    }

    // resolve one value at its exact correction boundary
    func resolve(_ value: WeatherWidgetValue, now: Date) -> WeatherWidgetResolvedValue {
        // retain an adjustment only strictly before its deadline
        if value.mode == .adjusted,
           let selectedUntil = value.selectedUntil,
           now < selectedUntil {
            return WeatherWidgetResolvedValue(
                mode: .adjusted,
                sourceClock: sourceClock(value.selectedSource),
                value: value.selected
            )
        }
        // demote adjusted data to its captured raw counterpart at equality
        if value.mode == .adjusted {
            return WeatherWidgetResolvedValue(
                mode: value.raw == nil ? .unavailable : .raw,
                sourceClock: sourceClock(value.rawSource),
                value: value.raw
            )
        }
        return WeatherWidgetResolvedValue(
            mode: value.mode,
            sourceClock: sourceClock(value.rawSource),
            value: value.selected
        )
    }

    // expose deterministic timeline transition dates
    func transitionDates(snapshot: WeatherWidgetSnapshot, acquiredAt: Date, after now: Date) -> [Date] {
        var dates = snapshot.hours.flatMap { hour in
            [hour.start, hour.end]
        }
        dates.append(contentsOf: snapshot.hours.flatMap { hour in
            [hour.temperatureC.selectedUntil, hour.rainMmPerHour.selectedUntil].compactMap { $0 }
        })
        dates.append(snapshot.calendar.cutoff)
        dates.append(snapshot.calendar.dayEnd)
        dates.append(snapshot.receivedAt.addingTimeInterval(Self.maximumAcquisitionAge))
        dates.append(acquiredAt.addingTimeInterval(Self.maximumAcquisitionAge))
        dates.append(snapshot.receivedAt.addingTimeInterval(Self.staleAcquisitionAge + 0.001))
        dates.append(acquiredAt.addingTimeInterval(Self.staleAcquisitionAge + 0.001))
        let sourceClocks = snapshot.hours.flatMap { hour in
            [
                hour.temperatureC.rawSource,
                hour.temperatureC.selectedSource,
                hour.rainMmPerHour.rawSource,
                hour.rainMmPerHour.selectedSource
            ].compactMap { sourceClock($0) }
        }
        dates.append(contentsOf: sourceClocks.map {
            $0.addingTimeInterval(Self.staleSourceAge + 0.001)
        })
        return Array(Set(dates.filter { $0 > now })).sorted()
    }

    // build one semantic group
    private func group(
        hours: [WeatherWidgetHour],
        now: Date,
        unit: TemperatureUnit
    ) -> WeatherWidgetSemanticGroup {
        let temperatures = hours.map { resolve($0.temperatureC, now: now) }
        let rain = hours.map { resolve($0.rainMmPerHour, now: now) }
        let temperatureValues = temperatures.compactMap(\.value).map {
            roundedTemperature($0, unit: unit)
        }
        let rainValues = rain.compactMap(\.value)
        let temperature: WeatherWidgetTemperatureRange?
        // retain an explicit unavailable temperature group
        if temperatureValues.count == temperatures.count,
           let minimum = temperatureValues.min(),
           let maximum = temperatureValues.max() {
            temperature = WeatherWidgetTemperatureRange(
                label: minimum == maximum ? "\(minimum)" : "\(minimum)–\(maximum)",
                maximum: maximum,
                minimum: minimum
            )
        } else {
            temperature = nil
        }
        return WeatherWidgetSemanticGroup(
            condition: rainValues.count == rain.count ? condition(for: rainValues) : .unavailable,
            end: hours.last!.end,
            hourCount: hours.count,
            isNow: hours.first!.start <= now && now < hours.first!.end,
            start: hours.first!.start,
            status: aggregateStatus((temperatures + rain).map(\.mode)),
            temperature: temperature
        )
    }

    // match the wettest single-hour rain threshold
    private func condition(for rain: [Double]) -> WeatherCondition {
        guard let wettest = rain.max() else {
            return .unavailable
        }
        // keep the inclusive sprinkle boundary
        if wettest > 2.5 {
            return .rain
        }
        // keep positive trace rain distinct from dry
        if wettest > 0 {
            return .sprinkle
        }
        return .dry
    }

    // aggregate adjusted, raw, and unavailable values
    private func aggregateStatus(_ modes: [WeatherWidgetValueMode]) -> WeatherWidgetStatus {
        // retain a fully unavailable state
        guard !modes.isEmpty else {
            return .unavailable
        }
        // identify homogeneous modes before mixed
        if modes.allSatisfy({ $0 == .adjusted }) {
            return .adjusted
        }
        if modes.allSatisfy({ $0 == .raw }) {
            return .raw
        }
        if modes.allSatisfy({ $0 == .unavailable }) {
            return .unavailable
        }
        return .mixed
    }

    // use product-run time and fall back to receipt time
    private func sourceClock(_ source: WeatherWidgetSource?) -> Date? {
        source.map { $0.runAt ?? $0.receivedAt }
    }

    // treat rollback/future clocks as stale rather than fresh
    private func clockIsStale(_ clock: Date, now: Date, limit: TimeInterval) -> Bool {
        let age = now.timeIntervalSince(clock)
        return age < 0 || age > limit
    }

    // round midpoint ties away from zero
    private func roundedTemperature(_ celsius: Double, unit: TemperatureUnit) -> Int {
        let value = unit == .fahrenheit ? celsius * 9 / 5 + 32 : celsius
        let magnitude = floor(abs(value) + 0.5)
        return Int(value < 0 ? -magnitude : magnitude)
    }

    // emit the hard-expired state without old sunset or bedtime data
    private func unavailablePresentation(
        snapshot: WeatherWidgetSnapshot,
        now: Date,
        unit: TemperatureUnit
    ) -> WeatherWidgetPresentation {
        WeatherWidgetPresentation(
            bedtime: false,
            date: snapshot.calendar.date,
            footer: WeatherWidgetFooter(
                attribution: snapshot.attribution.label,
                generatedAt: snapshot.generatedAt,
                status: .unavailable,
                sunset: nil
            ),
            groups: [],
            hardExpired: true,
            now: now,
            presentation: .unavailable,
            schemaVersion: WeatherWidgetContract.semanticSchemaVersion,
            stale: false,
            status: .unavailable,
            unit: unit
        )
    }
}

extension WeatherWidgetPresentation {
    // format deterministic semantics for the compact widget surface
    func display(ageAnchor: Date, attempt: WeatherWidgetAttempt?) -> WeatherWidgetDisplay {
        let timezone = TimeZone(identifier: WeatherWidgetContract.siteTimezone)!
        let suffix = unit == .fahrenheit ? "°F" : "°C"
        let displayGroups = groups.enumerated().map { index, group in
            let temperature = group.temperature.map { "\($0.label)\(suffix)" } ?? "unavailable"
            let time = timeLabel(for: group, timezone: timezone)
            return WeatherWidgetDisplayGroup(
                id: index,
                accessibilityLabel: "\(accessibilityTimeLabel(for: group, timezone: timezone)), air temperature \(temperature), \(group.condition.accessibilityName)",
                condition: group.condition,
                temperatureLabel: temperature,
                timeLabel: time
            )
        }
        let ageMinutes = max(0, Int(floor(now.timeIntervalSince(ageAnchor) / 60)))
        let knownFailure = attempt?.outcome.isFailure == true &&
            (attempt?.attemptedAt ?? .distantPast) >= ageAnchor
        let stateLabel: String
        // surface a known failure immediately
        if knownFailure {
            stateLabel = "Offline"
        } else if stale {
            stateLabel = "Stale"
        } else {
            stateLabel = "Updated"
        }
        let sunset = footer.sunset.map {
            "Sunset \(hourFormatter(timezone: timezone).string(from: $0))"
        }
        let bedtimeMessage = bedtime ? "go to bed" : nil
        let unavailableMessage = presentation == .unavailable ? "weather unavailable" : nil
        var accessibility = displayGroups.map(\.accessibilityLabel)
        accessibility.append("\(stateLabel), \(status.rawValue), \(ageMinutes) minutes old")
        // retain sunset only before hard expiry
        if let sunset {
            accessibility.append(sunset)
        }
        // announce the exact spare or cutoff message
        if let bedtimeMessage {
            accessibility.append(bedtimeMessage)
        }
        // announce the hard unavailable state
        if let unavailableMessage {
            accessibility.append(unavailableMessage)
        }
        // announce credit whenever numeric weather is present
        if !displayGroups.isEmpty {
            accessibility.append("Weather data by Open-Meteo under CC BY 4.0")
        }
        return WeatherWidgetDisplay(
            accessibilitySummary: accessibility.joined(separator: ". "),
            attributionLabel: displayGroups.isEmpty ? nil : footer.attribution,
            bedtimeMessage: bedtimeMessage,
            groups: displayGroups,
            statusLabel: "\(stateLabel) · \(status.rawValue) · \(ageMinutes)m",
            sunsetLabel: sunset,
            unavailableMessage: unavailableMessage
        )
    }

    // format one compact group range
    private func timeLabel(
        for group: WeatherWidgetSemanticGroup,
        timezone: TimeZone
    ) -> String {
        let formatter = hourFormatter(timezone: timezone)
        let finalHour = group.end.addingTimeInterval(-1)
        let ending = formatter.string(from: finalHour)
        // identify the current interval explicitly
        if group.isNow {
            return group.hourCount == 1 ? "Now" : "Now–\(ending)"
        }
        let starting = formatter.string(from: group.start)
        return group.hourCount == 1 ? starting : "\(starting)–\(ending)"
    }

    // format the complete repeated-hour VoiceOver range
    private func accessibilityTimeLabel(
        for group: WeatherWidgetSemanticGroup,
        timezone: TimeZone
    ) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timezone
        formatter.dateFormat = "h a z"
        let finalHour = group.end.addingTimeInterval(-1)
        let prefix = group.isNow ? "Now, " : ""
        return "\(prefix)\(formatter.string(from: group.start)) through \(formatter.string(from: finalHour))"
    }

    // create one site-local compact hour formatter
    private func hourFormatter(timezone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timezone
        formatter.dateFormat = "ha"
        formatter.amSymbol = "a"
        formatter.pmSymbol = "p"
        return formatter
    }
}

#if DEBUG
extension WeatherWidgetFixture {
    // adapt retained compile-time host fixtures to the production view model
    func display(unit: TemperatureUnit) -> WeatherWidgetDisplay {
        let displayGroups = groups.map { group in
            WeatherWidgetDisplayGroup(
                id: group.id,
                accessibilityLabel: group.accessibilityLabel(unit: unit),
                condition: group.condition,
                temperatureLabel: group.temperatureLabel(unit: unit),
                timeLabel: group.timeLabel
            )
        }
        return WeatherWidgetDisplay(
            accessibilitySummary: accessibilitySummary(unit: unit),
            attributionLabel: showsWeather ? WeatherWidgetContract.attributionLabel : nil,
            bedtimeMessage: bedtimeMessage,
            groups: displayGroups,
            statusLabel: statusLabel,
            sunsetLabel: sunsetLabel,
            unavailableMessage: nil
        )
    }
}
#endif
