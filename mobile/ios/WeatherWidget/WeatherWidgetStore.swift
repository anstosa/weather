import Foundation

protocol WeatherWidgetStoring {
    // read and revalidate the last good public snapshot
    func loadSnapshot() -> WeatherWidgetCachedSnapshot?

    // read only bounded attempt metadata
    func loadAttempt() -> WeatherWidgetAttempt?

    // atomically replace the last good public snapshot
    func saveSnapshot(_ snapshot: WeatherWidgetCachedSnapshot) throws

    // atomically replace independent attempt metadata
    func saveAttempt(_ attempt: WeatherWidgetAttempt) throws
}

struct WeatherWidgetStore: WeatherWidgetStoring {
    static let storageSchemaVersion = "weather-widget-cache/v2"
    static let attemptSchemaVersion = "weather-widget-attempt/v2"

    private let directory: URL
    private let fileManager: FileManager
    private let snapshotDecoder = WeatherWidgetSnapshotDecoder()

    // use the extension's own Application Support container
    init(fileManager: FileManager = .default) {
        let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        self.init(
            directory: applicationSupport.appending(path: "WeatherWidget", directoryHint: .isDirectory),
            fileManager: fileManager
        )
    }

    // support isolated persistence tests
    init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
    }

    // decode a bounded and fully revalidated snapshot record
    func loadSnapshot() -> WeatherWidgetCachedSnapshot? {
        guard let data = boundedData(
            at: snapshotURL,
            maximumBytes: WeatherWidgetContract.maximumPayloadBytes + 8_192
        ),
              let record = try? WeatherWidgetDateCodec.decoder().decode(
                  WeatherWidgetCachedSnapshot.self,
                  from: data
              ),
              record.schemaVersion == Self.storageSchemaVersion,
              record.acquiredAt.isFiniteDate,
              (try? snapshotDecoder.validate(record.snapshot)) != nil else {
            return nil
        }
        return record
    }

    // decode bounded failure metadata independently
    func loadAttempt() -> WeatherWidgetAttempt? {
        guard let data = boundedData(at: attemptURL, maximumBytes: 1_024),
              let attempt = try? WeatherWidgetDateCodec.decoder().decode(
                  WeatherWidgetAttempt.self,
                  from: data
              ),
              attempt.schemaVersion == Self.attemptSchemaVersion,
              attempt.attemptedAt.isFiniteDate,
              attempt.snapshotAcquiredAt?.isFiniteDate != false,
              attempt.outcome != .success || (
                  attempt.snapshotAcquiredAt != nil && attempt.snapshotIdentifier != nil
              ) else {
            return nil
        }
        return attempt
    }

    // persist one last-good snapshot without touching attempt metadata
    func saveSnapshot(_ snapshot: WeatherWidgetCachedSnapshot) throws {
        try snapshotDecoder.validate(snapshot.snapshot)
        try requireDirectory()
        let data = try WeatherWidgetDateCodec.encoder().encode(snapshot)
        // preserve the same bounded read envelope
        guard data.count <= WeatherWidgetContract.maximumPayloadBytes + 8_192 else {
            throw WeatherWidgetContractError.oversized
        }
        try data.write(to: snapshotURL, options: [.atomic, .completeFileProtection])
    }

    // persist sanitized outcome metadata without touching weather
    func saveAttempt(_ attempt: WeatherWidgetAttempt) throws {
        // refuse success metadata without its exact cache identity
        guard attempt.outcome != .success || (
            attempt.snapshotAcquiredAt != nil && attempt.snapshotIdentifier != nil
        ) else {
            throw WeatherWidgetContractError.invalid("missing success cache identity")
        }
        try requireDirectory()
        let data = try WeatherWidgetDateCodec.encoder().encode(attempt)
        try data.write(to: attemptURL, options: [.atomic, .completeFileProtection])
    }

    // create only this extension-owned directory
    private func requireDirectory() throws {
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: nil
        )
    }

    // read no more than the validated file boundary
    private func boundedData(at url: URL, maximumBytes: Int) -> Data? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber,
              size.intValue <= maximumBytes,
              let handle = try? FileHandle(forReadingFrom: url) else {
            return nil
        }
        defer {
            try? handle.close()
        }
        guard let data = try? handle.read(upToCount: maximumBytes + 1),
              data.count <= maximumBytes else {
            return nil
        }
        return data
    }

    private var snapshotURL: URL {
        directory.appending(path: "last-good.json", directoryHint: .notDirectory)
    }

    private var attemptURL: URL {
        directory.appending(path: "last-attempt.json", directoryHint: .notDirectory)
    }
}

private extension Date {
    // reject non-finite persistence timestamps
    var isFiniteDate: Bool {
        timeIntervalSinceReferenceDate.isFinite
    }
}
