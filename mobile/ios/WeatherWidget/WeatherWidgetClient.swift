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
    static let deadline: TimeInterval = 8
    static let endpoint = URL(
        string: "https://weather.ballydidean.farm/api/v1/sites/ballydidean/widget-forecast"
    )!
    private let configuration: URLSessionConfiguration
    private let requestDeadline: TimeInterval

    // configure an ephemeral cookie-free transport
    init(
        configuration: URLSessionConfiguration = .ephemeral,
        requestDeadline: TimeInterval = Self.deadline
    ) {
        let configuration = configuration.copy() as! URLSessionConfiguration
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = requestDeadline
        configuration.timeoutIntervalForResource = requestDeadline
        self.configuration = configuration
        self.requestDeadline = requestDeadline
    }

    // execute one strictly bounded public GET
    func fetch() async throws -> Data {
        let request = WeatherWidgetBoundedRequest(
            configuration: configuration,
            deadline: requestDeadline
        )
        return try await withTaskCancellationHandler {
            try await request.load(url: Self.endpoint)
        } onCancel: {
            request.cancel()
        }
    }
}

final class WeatherWidgetBoundedRequest: NSObject, URLSessionDataDelegate {
    private let configuration: URLSessionConfiguration
    private let deadline: TimeInterval
    private let lock = NSLock()
    private var cancellationRequested = false
    private var continuation: CheckedContinuation<Data, Error>?
    private var finished = false
    private var responseData = Data()
    private var task: URLSessionDataTask?
    private var timeoutTask: Task<Void, Never>?
    private var session: URLSession?

    // retain request-local state for exactly one fetch
    init(configuration: URLSessionConfiguration, deadline: TimeInterval = 8) {
        self.configuration = configuration
        self.deadline = deadline
        super.init()
    }

    // begin one request-local transfer
    func load(url: URL) async throws -> Data {
        // reject cancellation before installing request-local state
        if Task.isCancelled {
            throw WeatherWidgetFetchError.cancelled
        }
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            // honor cancellation delivered before continuation registration
            if cancellationRequested || Task.isCancelled {
                finished = true
                lock.unlock()
                continuation.resume(throwing: WeatherWidgetFetchError.cancelled)
                return
            }
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
                timeoutInterval: deadline
            )
            request.httpMethod = "GET"
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = session.dataTask(with: request)
            self.task = task
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(deadline))
                self?.finish(.failure(WeatherWidgetFetchError.timeout))
            }
            lock.unlock()
            task.resume()
        }
    }

    // cancel only this request instance
    func cancel() {
        lock.lock()
        cancellationRequested = true
        let canFinish = continuation != nil && !finished
        lock.unlock()
        // let registration observe an earlier cancellation
        guard canFinish else {
            return
        }
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
        // ignore callbacks after this request reached a terminal state
        guard !finished else {
            lock.unlock()
            return
        }
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
        guard !finished, let continuation else {
            lock.unlock()
            return
        }
        finished = true
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
    private let clock: @Sendable () -> Date
    private let fetcher: WeatherWidgetFetching
    private let store: WeatherWidgetStoring
    private let decoder: WeatherWidgetSnapshotDecoder
    private var refreshTask: Task<WeatherWidgetLoadState, Never>?

    // compose production fetch, validation, and extension persistence
    init(
        fetcher: WeatherWidgetFetching = WeatherWidgetHTTPClient(),
        store: WeatherWidgetStoring = WeatherWidgetStore(),
        decoder: WeatherWidgetSnapshotDecoder = WeatherWidgetSnapshotDecoder(),
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.clock = clock
        self.fetcher = fetcher
        self.store = store
        self.decoder = decoder
    }

    // refresh once and retain last-good weather on every failure
    func refresh() async -> WeatherWidgetLoadState {
        // share one request while WidgetKit asks for concurrent views
        if let refreshTask {
            return await refreshTask.value
        }
        let task = Task {
            await performRefresh()
        }
        refreshTask = task
        let state = await task.value
        refreshTask = nil
        return state
    }

    // commit one ordered refresh result
    private func performRefresh() async -> WeatherWidgetLoadState {
        do {
            let data = try await fetcher.fetch()
            let snapshot = try decoder.decode(data)
            let completedAt = clock()
            let cached = WeatherWidgetCachedSnapshot(
                acquiredAt: completedAt,
                schemaVersion: WeatherWidgetStore.storageSchemaVersion,
                snapshot: snapshot
            )
            do {
                try store.saveSnapshot(cached)
            } catch {
                let attempt = persistAttempt(outcome: .storageError, at: completedAt)
                return WeatherWidgetLoadState(attempt: attempt, cached: store.loadSnapshot())
            }
            let attempt = persistAttempt(
                outcome: .success,
                at: completedAt,
                snapshotAcquiredAt: cached.acquiredAt,
                snapshotIdentifier: cached.snapshotIdentifier
            )
            return WeatherWidgetLoadState(attempt: attempt, cached: cached)
        } catch {
            let completedAt = clock()
            let outcome = attemptOutcome(for: error)
            let attempt = persistAttempt(outcome: outcome, at: completedAt)
            return WeatherWidgetLoadState(attempt: attempt, cached: store.loadSnapshot())
        }
    }

    // load persisted state without performing network work
    func cachedState() -> WeatherWidgetLoadState {
        let cached = store.loadSnapshot()
        let attempt = store.loadAttempt()
        guard let cached else {
            return WeatherWidgetLoadState(attempt: attempt, cached: nil)
        }
        // reject metadata that cannot prove the cached snapshot completed
        guard let attempt else {
            return conservativeState(for: cached)
        }
        // bind success to the exact persisted cache identity
        if attempt.outcome == .success {
            guard attempt.snapshotAcquiredAt == cached.acquiredAt,
                  attempt.snapshotIdentifier == cached.snapshotIdentifier else {
                return conservativeState(for: cached)
            }
            return WeatherWidgetLoadState(attempt: attempt, cached: cached)
        }
        // preserve only failures observed after the cached success
        guard attempt.attemptedAt >= cached.acquiredAt else {
            return conservativeState(for: cached)
        }
        return WeatherWidgetLoadState(attempt: attempt, cached: cached)
    }

    // persist one sanitized attempt and return only proven metadata
    private func persistAttempt(
        outcome: WeatherWidgetAttemptOutcome,
        at now: Date,
        snapshotAcquiredAt: Date? = nil,
        snapshotIdentifier: UUID? = nil
    ) -> WeatherWidgetAttempt? {
        let attempt = WeatherWidgetAttempt(
            attemptedAt: now,
            outcome: outcome,
            schemaVersion: WeatherWidgetStore.attemptSchemaVersion,
            snapshotAcquiredAt: snapshotAcquiredAt,
            snapshotIdentifier: snapshotIdentifier
        )
        do {
            try store.saveAttempt(attempt)
            return attempt
        } catch {
            // expose metadata persistence failure without clobbering weather
            return WeatherWidgetAttempt(
                attemptedAt: now,
                outcome: .storageError,
                schemaVersion: WeatherWidgetStore.attemptSchemaVersion
            )
        }
    }

    // surface incomplete persistence as a known immediate failure
    private func conservativeState(
        for cached: WeatherWidgetCachedSnapshot
    ) -> WeatherWidgetLoadState {
        WeatherWidgetLoadState(
            attempt: WeatherWidgetAttempt(
                attemptedAt: cached.acquiredAt,
                outcome: .storageError,
                schemaVersion: WeatherWidgetStore.attemptSchemaVersion
            ),
            cached: cached
        )
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
