#if DEBUG && WEATHER_V4_PERSISTENCE_PROBE
import Foundation
import os

struct WeatherWidgetPersistenceProbeResult {
    let action: String
    let renderDate: Date
    let state: WeatherWidgetLoadState?
}

actor WeatherWidgetPersistenceProbe {
    private let logger = Logger(
        subsystem: "farm.ballydidean.weather.widget",
        category: "persistence-probe"
    )
    private let onTransitionStart: @Sendable (TemperatureUnit) async -> Void
    private let onWaiterQueued: @Sendable (TemperatureUnit, TemperatureUnit) async -> Void
    private let store: WeatherWidgetStore
    private var completedActions: [String: Int] = [:]
    private var startedTransitions: [TemperatureUnit: Int] = [:]
    private var transitionTask: Task<WeatherWidgetPersistenceProbeResult, Never>?
    private var transitionToken: UUID?
    private var transitionUnit: TemperatureUnit?

    // use the extension store unless a unit test supplies an isolated directory
    init(
        store: WeatherWidgetStore = WeatherWidgetStore(),
        onTransitionStart: @escaping @Sendable (TemperatureUnit) async -> Void = { _ in },
        onWaiterQueued: @escaping @Sendable (TemperatureUnit, TemperatureUnit) async -> Void = {
            _, _ in
        }
    ) {
        self.store = store
        self.onTransitionStart = onTransitionStart
        self.onWaiterQueued = onWaiterQueued
    }

    // serialize WidgetKit's repeated provider requests
    func load(unit: TemperatureUnit) async -> WeatherWidgetPersistenceProbeResult {
        // recheck actor state after every awaited transition
        while true {
            // share and finalize the exact active transition
            if let task = transitionTask,
               let token = transitionToken,
               let activeUnit = transitionUnit {
                // expose every requested and active unit pairing
                await onWaiterQueued(unit, activeUnit)
                let result = await task.value
                completeTransition(result, unit: activeUnit, token: token)
                // return only a result for the requested configuration
                if activeUnit == unit {
                    return result
                }
                continue
            }

            // install one transition before yielding the actor
            let token = UUID()
            let task = Task {
                await performTransition(unit: unit)
            }
            transitionToken = token
            transitionUnit = unit
            transitionTask = task
            let result = await task.value
            completeTransition(result, unit: unit, token: token)
            return result
        }
    }

    // expose deterministic transition counts to the special-flag unit test
    func completedTransitionCount(action: String) -> Int {
        completedActions[action, default: 0]
    }

    // expose physical transition starts before token finalization
    func startedTransitionCount(unit: TemperatureUnit) -> Int {
        startedTransitions[unit, default: 0]
    }

    // finalize one token exactly once across every waiter
    private func completeTransition(
        _ result: WeatherWidgetPersistenceProbeResult,
        unit: TemperatureUnit,
        token: UUID
    ) {
        // ignore waiters for an already finalized transition
        guard transitionToken == token else {
            return
        }
        transitionTask = nil
        transitionToken = nil
        transitionUnit = nil
        completedActions[result.action, default: 0] += 1
        record(result, unit: unit)
    }

    // perform one idempotent production-store transition
    private func performTransition(
        unit: TemperatureUnit
    ) async -> WeatherWidgetPersistenceProbeResult {
        startedTransitions[unit, default: 0] += 1
        await onTransitionStart(unit)
        let fixture: (snapshot: WeatherWidgetSnapshot, now: Date, unit: TemperatureUnit)
        do {
            fixture = try WeatherWidgetDebugFixtures.fixture(named: "adjusted-standard")
        } catch {
            return invalidResult(renderDate: Date())
        }

        let files = store.persistenceProbeFilePresence()
        let reader = WeatherWidgetDataController(
            fetcher: WeatherWidgetPersistenceProbeFetcher(outcome: .offline),
            store: store,
            clock: { fixture.now }
        )
        let existing = await reader.cachedState()

        // seed exactly one absent extension-owned store
        if unit == .fahrenheit, !files.snapshot, !files.attempt {
            guard let data = try? WeatherWidgetDateCodec.encoder().encode(fixture.snapshot) else {
                return invalidResult(renderDate: fixture.now)
            }
            let controller = WeatherWidgetDataController(
                fetcher: WeatherWidgetPersistenceProbeFetcher(outcome: .data(data)),
                store: store,
                clock: { fixture.snapshot.receivedAt }
            )
            let seeded = await controller.refresh()
            guard isMatchingSuccess(seeded) else {
                return invalidResult(renderDate: fixture.now)
            }
            return WeatherWidgetPersistenceProbeResult(
                action: "seed-success",
                renderDate: fixture.now,
                state: seeded
            )
        }

        // reject missing or corrupt state after initial placement
        guard files.snapshot, files.attempt, let attempt = existing.attempt else {
            return invalidResult(renderDate: fixture.now)
        }

        // reuse only a matching fahrenheit success
        if unit == .fahrenheit, attempt.outcome == .success {
            guard isMatchingSuccess(existing) else {
                return invalidResult(renderDate: fixture.now)
            }
            return WeatherWidgetPersistenceProbeResult(
                action: "read-success",
                renderDate: fixture.now,
                state: existing
            )
        }

        // write one failure only after the matching success is proven
        if attempt.outcome == .success {
            guard isMatchingSuccess(existing) else {
                return invalidResult(renderDate: fixture.now)
            }
            let snapshotIdentifier = existing.cached?.snapshotIdentifier
            let controller = WeatherWidgetDataController(
                fetcher: WeatherWidgetPersistenceProbeFetcher(outcome: .offline),
                store: store,
                clock: { fixture.now }
            )
            let failed = await controller.refresh()
            guard failed.cached?.snapshotIdentifier == snapshotIdentifier,
                  failed.attempt?.outcome == .offline,
                  failed.attempt?.attemptedAt == fixture.now else {
                return invalidResult(renderDate: fixture.now)
            }
            return WeatherWidgetPersistenceProbeResult(
                action: "write-offline",
                renderDate: fixture.now,
                state: failed
            )
        }

        // read the exact persisted failure without another fetch or write
        guard attempt.outcome == .offline,
              existing.cached != nil,
              attempt.attemptedAt == fixture.now else {
            return invalidResult(renderDate: fixture.now)
        }
        return WeatherWidgetPersistenceProbeResult(
            action: "read-offline",
            renderDate: fixture.now,
            state: existing
        )
    }

    // require success metadata bound to the exact cached transaction
    private func isMatchingSuccess(_ state: WeatherWidgetLoadState) -> Bool {
        guard let cached = state.cached, let attempt = state.attempt else {
            return false
        }
        return attempt.outcome == .success &&
            attempt.snapshotAcquiredAt == cached.acquiredAt &&
            attempt.snapshotIdentifier == cached.snapshotIdentifier
    }

    // fail closed without returning cached weather
    private func invalidResult(renderDate: Date) -> WeatherWidgetPersistenceProbeResult {
        WeatherWidgetPersistenceProbeResult(
            action: "invalid-state",
            renderDate: renderDate,
            state: nil
        )
    }

    // emit only bounded persistence identity metadata
    private func record(
        _ result: WeatherWidgetPersistenceProbeResult,
        unit: TemperatureUnit
    ) {
        let snapshotIdentifier = result.state?.cached?.snapshotIdentifier.uuidString.lowercased()
            ?? "missing"
        let attemptedAt = result.state?.attempt.map {
            WeatherWidgetDateCodec.string(from: $0.attemptedAt)
        } ?? "missing"
        let outcome = result.state?.attempt?.outcome.rawValue ?? "missing"
        let processIdentifier = ProcessInfo.processInfo.processIdentifier
        logger.notice(
            "persistence-probe phase=\(unit.rawValue, privacy: .public) action=\(result.action, privacy: .public) pid=\(processIdentifier, privacy: .public) snapshot-id=\(snapshotIdentifier, privacy: .public) attempted-at=\(attemptedAt, privacy: .public) outcome=\(outcome, privacy: .public)"
        )
    }
}

private struct WeatherWidgetPersistenceProbeFetcher: WeatherWidgetFetching {
    enum Outcome {
        case data(Data)
        case offline
    }

    let outcome: Outcome

    // return only embedded data or a sanitized offline result
    func fetch() async throws -> Data {
        switch outcome {
        case .data(let data):
            return data
        case .offline:
            throw WeatherWidgetFetchError.offline
        }
    }
}
#endif
