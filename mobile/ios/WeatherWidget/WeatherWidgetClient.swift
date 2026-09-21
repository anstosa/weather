import Foundation

enum WeatherWidgetFetchError: Error, Equatable {
    case cancelled
    case invalidResponse
    case offline
    case oversized
    case serverError
    case timeout
}

protocol WeatherWidgetFetching {
    // fetch exact public bytes without cookies or HTTP cache
    func fetch() async throws -> Data
}

struct WeatherWidgetHTTPClient: WeatherWidgetFetching {
    static let endpoint = URL(
        string: "https://weather.ballydidean.farm/api/v1/sites/ballydidean/widget-forecast"
    )!
    private let configuration: URLSessionConfiguration

    // configure an ephemeral cookie-free transport
    init(configuration: URLSessionConfiguration = .ephemeral) {
        let configuration = configuration.copy() as! URLSessionConfiguration
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 8
        self.configuration = configuration
    }

    // execute one strictly bounded public GET
    func fetch() async throws -> Data {
        let request = WeatherWidgetBoundedRequest(configuration: configuration)
        return try await withTaskCancellationHandler {
            try await request.load(url: Self.endpoint)
        } onCancel: {
            request.cancel()
        }
    }
}

private final class WeatherWidgetBoundedRequest: NSObject, URLSessionDataDelegate {
    private static let deadline: TimeInterval = 8

    private let configuration: URLSessionConfiguration
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Data, Error>?
    private var responseData = Data()
    private var task: URLSessionDataTask?
    private var timeoutTask: Task<Void, Never>?
    private var session: URLSession?

    // retain request-local state for exactly one fetch
    init(configuration: URLSessionConfiguration) {
        self.configuration = configuration
        super.init()
    }

    // begin one request-local transfer
    func load(url: URL) async throws -> Data {
        // reject cancellation before installing request-local state
        if Task.isCancelled {
            throw WeatherWidgetFetchError.cancelled
        }
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            self.continuation = continuation
            let session = URLSession(
                configuration: configuration,
                delegate: self,
                delegateQueue: nil
            )
            self.session = session
            var request = URLRequest(
                url: url,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: Self.deadline
            )
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = session.dataTask(with: request)
            self.task = task
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.deadline))
                self?.finish(.failure(WeatherWidgetFetchError.timeout))
            }
            lock.unlock()
            task.resume()
        }
    }

    // cancel only this request instance
    func cancel() {
        finish(.failure(WeatherWidgetFetchError.cancelled))
    }

    // reject every HTTP redirect from the fixed endpoint
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
        finish(.failure(WeatherWidgetFetchError.invalidResponse))
    }

    // reject status and declared oversize before body transfer
    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let response = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            finish(.failure(WeatherWidgetFetchError.invalidResponse))
            return
        }
        // require the exact successful HTTP result
        guard response.statusCode == 200 else {
            completionHandler(.cancel)
            finish(.failure(WeatherWidgetFetchError.serverError))
            return
        }
        // reject a declared response beyond the native cap
        if response.expectedContentLength > WeatherWidgetContract.maximumPayloadBytes {
            completionHandler(.cancel)
            finish(.failure(WeatherWidgetFetchError.oversized))
            return
        }
        completionHandler(.allow)
    }

    // accumulate only through the exact byte cap
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        let exceedsLimit = responseData.count + data.count > WeatherWidgetContract.maximumPayloadBytes
        // append only an accepted bounded chunk
        if !exceedsLimit {
            responseData.append(data)
        }
        lock.unlock()
        // stop transfer immediately after the cap
        if exceedsLimit {
            finish(.failure(WeatherWidgetFetchError.oversized))
        }
    }

    // complete from the transport callback
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        // map only sanitized transport categories
        if let error = error as? URLError {
            let outcome: WeatherWidgetFetchError = error.code == .timedOut ? .timeout : .offline
            finish(.failure(outcome))
            return
        }
        // preserve any non-URL transport failure as offline
        if error != nil {
            finish(.failure(WeatherWidgetFetchError.offline))
            return
        }
        lock.lock()
        let data = responseData
        lock.unlock()
        finish(.success(data))
    }

    // resume exactly one continuation
    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        guard let continuation else {
            lock.unlock()
            return
        }
        self.continuation = nil
        let task = self.task
        self.task = nil
        let timeoutTask = self.timeoutTask
        self.timeoutTask = nil
        let session = self.session
        self.session = nil
        lock.unlock()

        timeoutTask?.cancel()
        task?.cancel()
        session?.invalidateAndCancel()
        continuation.resume(with: result)
    }
}

struct WeatherWidgetLoadState {
    let attempt: WeatherWidgetAttempt?
    let cached: WeatherWidgetCachedSnapshot?
}

actor WeatherWidgetDataController {
    private let fetcher: WeatherWidgetFetching
    private let store: WeatherWidgetStoring
    private let decoder: WeatherWidgetSnapshotDecoder

    // compose production fetch, validation, and extension persistence
    init(
        fetcher: WeatherWidgetFetching = WeatherWidgetHTTPClient(),
        store: WeatherWidgetStoring = WeatherWidgetStore(),
        decoder: WeatherWidgetSnapshotDecoder = WeatherWidgetSnapshotDecoder()
    ) {
        self.fetcher = fetcher
        self.store = store
        self.decoder = decoder
    }

    // refresh once and retain last-good weather on every failure
    func refresh(now: Date) async -> WeatherWidgetLoadState {
        do {
            let data = try await fetcher.fetch()
            let snapshot = try decoder.decode(data)
            let cached = WeatherWidgetCachedSnapshot(
                acquiredAt: now,
                schemaVersion: WeatherWidgetStore.storageSchemaVersion,
                snapshot: snapshot
            )
            do {
                try store.saveSnapshot(cached)
            } catch {
                let attempt = persistAttempt(outcome: .storageError, at: now)
                return WeatherWidgetLoadState(attempt: attempt, cached: store.loadSnapshot())
            }
            let attempt = persistAttempt(outcome: .success, at: now)
            return WeatherWidgetLoadState(attempt: attempt, cached: cached)
        } catch {
            let outcome = attemptOutcome(for: error)
            let attempt = persistAttempt(outcome: outcome, at: now)
            return WeatherWidgetLoadState(attempt: attempt, cached: store.loadSnapshot())
        }
    }

    // load persisted state without performing network work
    func cachedState() -> WeatherWidgetLoadState {
        WeatherWidgetLoadState(
            attempt: store.loadAttempt(),
            cached: store.loadSnapshot()
        )
    }

    // persist one sanitized attempt and return only proven metadata
    private func persistAttempt(
        outcome: WeatherWidgetAttemptOutcome,
        at now: Date
    ) -> WeatherWidgetAttempt? {
        let attempt = WeatherWidgetAttempt(
            attemptedAt: now,
            outcome: outcome,
            schemaVersion: WeatherWidgetStore.attemptSchemaVersion
        )
        // return conservative in-memory state even when persistence fails
        try? store.saveAttempt(attempt)
        return attempt
    }

    // collapse transport and contract errors to bounded categories
    private func attemptOutcome(for error: Error) -> WeatherWidgetAttemptOutcome {
        // preserve exact transport categories without error text
        if let error = error as? WeatherWidgetFetchError {
            switch error {
            case .timeout:
                return .timeout
            case .serverError:
                return .serverError
            case .cancelled, .offline:
                return .offline
            case .invalidResponse, .oversized:
                return .invalidResponse
            }
        }
        return .invalidResponse
    }
}
