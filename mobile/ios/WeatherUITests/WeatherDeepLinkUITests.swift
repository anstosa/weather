import XCTest

// parse only the complete current public configuration summary
private struct WidgetConfigurationReceipt {
    let epoch: Int
    let observedAtMs: Int64
    let status: String
    let total: Int
    let matchCount: Int
    let kind: String
    let family: String
    let unit: String

    // reject partial or appended ambiguity details
    init?(_ text: String) {
        let parts = text.split(separator: " ").map(String.init)
        guard parts.count == 9, parts[0] == "widget-config" else {
            return nil
        }
        let keys = ["epoch", "observedAtMs", "status", "total", "matchCount", "kind", "family", "unit"]
        let values = zip(keys, parts.dropFirst()).map { key, part -> String? in
            let prefix = "\(key)="
            return part.hasPrefix(prefix) ? String(part.dropFirst(prefix.count)) : nil
        }
        guard values.allSatisfy({ $0 != nil }),
              let epoch = Int(values[0]!),
              let observedAtMs = Int64(values[1]!),
              let total = Int(values[3]!),
              let matchCount = Int(values[4]!) else {
            return nil
        }
        self.epoch = epoch
        self.observedAtMs = observedAtMs
        status = values[2]!
        self.total = total
        self.matchCount = matchCount
        kind = values[5]!
        family = values[6]!
        unit = values[7]!
    }

    // require the requested epoch and exact unique typed value
    func accepts(epoch expectedEpoch: Int, unit expectedUnit: String) -> Bool {
        epoch == expectedEpoch && observedAtMs > 0 && status == "unique" &&
            total >= 1 && matchCount == 1 &&
            kind == "farm.ballydidean.weather.forecast" &&
            family == "systemMedium" && unit == expectedUnit
    }
}

@MainActor
final class WeatherDeepLinkUITests: XCTestCase {
    // preserve an actual loaded WebKit failure state
    private func attachFailureState(
        _ app: XCUIApplication,
        webView: XCUIElement,
        name: String = "deep-link"
    ) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "\(name)-loaded-document-failure"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-app-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)

        let webViewState = XCTAttachment(string: webView.debugDescription)
        webViewState.name = "\(name)-webview-hierarchy"
        webViewState.lifetime = .keepAlways
        add(webViewState)
    }

    // retain one named real HTTPS journey state
    private func attachHTTPSFixtureState(
        _ name: String,
        app: XCUIApplication,
        webView: XCUIElement
    ) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "\(name)-screenshot"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-app-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)

        let webViewState = XCTAttachment(string: webView.debugDescription)
        webViewState.name = "\(name)-webview-hierarchy"
        webViewState.lifetime = .keepAlways
        add(webViewState)
    }

    // count the identified native host, not nested WebKit accessibility wrappers
    private func assertOneHostedWebView(
        _ name: String,
        app: XCUIApplication,
        webView: XCUIElement
    ) {
        let hostCount = app.webViews.matching(identifier: "weather.webview").count
        // retain identified-host evidence on failure
        if hostCount != 1 {
            attachHTTPSFixtureState("\(name)-host-identity-failure", app: app, webView: webView)
            XCTFail("expected one identified Weather WebView host, found \(hostCount)")
        }
    }

    // open the same fixed route used by the widget
    func testForecastDeepLinkOpensContainingApp() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test"]
        app.launch()

        let webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.waitForExistence(timeout: 15))
        // retain the exact initial document proof and failed state
        if !webView.staticTexts["Weather route /"].waitForExistence(timeout: 5) {
            attachFailureState(app, webView: webView, name: "initial-home")
            XCTFail("initial home route did not render the deterministic WebKit document")
        }

        let forecastURL = try XCTUnwrap(URL(string: "ballydidean-weather://forecast"))
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))
        app.open(forecastURL)

        XCTAssertEqual(app.state, .runningForeground)
        let loadedForecast = webView.staticTexts["Weather route /forecast"]
        // require the rendered fixture document
        if !loadedForecast.waitForExistence(timeout: 5) {
            attachFailureState(app, webView: webView)
            XCTFail("forecast deep link did not render the deterministic WebKit document")
        }
    }

    // launch one exact real HTTPS fixture path
    private func fixtureApp(path: String) throws -> XCUIApplication {
        let environment = ProcessInfo.processInfo.environment
        let requiredKeys = [
            "WEATHER_HTTPS_FIXTURE_IOS_ORIGIN",
            "WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN",
            "WEATHER_HTTPS_FIXTURE_USERNAME",
            "WEATHER_HTTPS_FIXTURE_PASSWORD"
        ]
        let app = XCUIApplication()
        app.launchArguments = [
            "-weather-https-fixture",
            "-weather-https-fixture-path",
            path
        ]
        // pass only the wrapper's four explicit fixture values
        for key in requiredKeys {
            app.launchEnvironment[key] = try XCTUnwrap(environment[key], key)
        }
        return app
    }

    // choose one HTML select option through the native WebKit picker
    private func chooseServerUnit(
        _ unit: String,
        app: XCUIApplication,
        webView: XCUIElement
    ) throws {
        let selectControls = webView.otherElements.matching(
            NSPredicate(
                format: "label == %@ AND value == %@",
                "Fixture server unit",
                "Fahrenheit"
            )
        )
        let selector = selectControls.firstMatch
        // require the actual select, not its separate same-label text
        guard selector.waitForExistence(timeout: 5), selectControls.count == 1 else {
            attachHTTPSFixtureState("https-fixture-server-unit-before-select-failure", app: app, webView: webView)
            XCTFail("fixture server unit select is missing or ambiguous")
            return
        }
        selector.tap()
        let picker = app.pickerWheels.firstMatch
        // use the standard iOS select picker when exposed
        if picker.waitForExistence(timeout: 3) {
            picker.adjust(toPickerWheelValue: unit)
            let done = app.toolbars.buttons["Done"]
            // require native picker confirmation before server submission
            guard done.waitForExistence(timeout: 3) else {
                attachHTTPSFixtureState("https-fixture-server-unit-picker-done-failure", app: app, webView: webView)
                XCTFail("fixture server unit picker confirmation is missing")
                return
            }
            done.tap()
        } else {
            let option = app.descendants(matching: .any).matching(
                NSPredicate(format: "label == %@", unit)
            ).firstMatch
            // expose the unknown native picker if no matching option appears
            guard option.waitForExistence(timeout: 3) else {
                attachHTTPSFixtureState("https-fixture-server-unit-picker-failure", app: app, webView: webView)
                XCTFail("fixture server unit native option is missing")
                return
            }
            option.tap()
        }
        let selectedControls = webView.otherElements.matching(
            NSPredicate(format: "label == %@ AND value == %@", "Fixture server unit", unit)
        )
        // prove the HTML select changed before asking the server to save
        guard selectedControls.firstMatch.waitForExistence(timeout: 5), selectedControls.count == 1 else {
            attachHTTPSFixtureState("https-fixture-server-unit-selection-failure", app: app, webView: webView)
            XCTFail("fixture server unit selection did not change")
            return
        }
    }

    // prove real TLS, cookie, settings, navigation, and denial journeys
    func testHTTPSFixtureJourneys() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["WEATHER_RUN_HTTPS_FIXTURE_TEST"] == "1",
            "real HTTPS journeys run only inside the bounded fixture probe"
        )
        var app = try fixtureApp(path: "/admin")
        app.launch()
        var webView = app.webViews["weather.webview"]
        // retain the exact cold-load state without extending readiness time
        guard webView.staticTexts["Fixture sign in"].waitForExistence(timeout: 15) else {
            attachHTTPSFixtureState("https-fixture-initial-sign-in-failure", app: app, webView: webView)
            XCTFail("initial fixture sign-in document did not load")
            return
        }
        let username = webView.textFields["Fixture username"]
        let password = webView.secureTextFields["Fixture password"]
        username.tap()
        username.typeText(try XCTUnwrap(environment["WEATHER_HTTPS_FIXTURE_USERNAME"]))
        password.tap()
        password.typeText(try XCTUnwrap(environment["WEATHER_HTTPS_FIXTURE_PASSWORD"]))
        webView.buttons["Sign in to fixture"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture administration"].waitForExistence(timeout: 10))
        XCTAssertTrue(webView.staticTexts["Authenticated fixture session"].exists)
        XCTAssertTrue(webView.staticTexts["HttpOnly session hidden"].exists)

        try chooseServerUnit("Celsius", app: app, webView: webView)
        webView.buttons["Save fixture settings"].tap()
        XCTAssertTrue(webView.staticTexts["Server unit: Celsius"].waitForExistence(timeout: 10))
        attachHTTPSFixtureState(
            "https-fixture-authenticated-celsius",
            app: app,
            webView: webView
        )

        // prove the server-authenticated session survives process restart
        app.terminate()
        app = try fixtureApp(path: "/admin")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture administration"].waitForExistence(timeout: 15))
        XCTAssertTrue(webView.staticTexts["Server unit: Celsius"].exists)
        webView.buttons["Sign out of fixture"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture session signed out"].waitForExistence(timeout: 10))

        // prove logout deletion survives another process restart
        app.terminate()
        app = try fixtureApp(path: "/admin")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture sign in"].waitForExistence(timeout: 15))

        // prove WebKit local storage retains the public unit setting
        app.terminate()
        app = try fixtureApp(path: "/settings")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture settings"].waitForExistence(timeout: 15))
        webView.buttons["Use Celsius"].tap()
        XCTAssertTrue(webView.staticTexts["Public unit preference: Celsius"].waitForExistence(timeout: 5))
        app.terminate()
        app = try fixtureApp(path: "/settings")
        app.launch()
        webView = app.webViews["weather.webview"]
        let settingsDeadline = Date().addingTimeInterval(15)
        // separate an unloaded document from a lost persisted preference
        guard webView.staticTexts["Fixture settings"].waitForExistence(timeout: 15) else {
            attachHTTPSFixtureState("https-fixture-settings-relaunch-load-failure", app: app, webView: webView)
            XCTFail("fixture settings did not load after app restart")
            return
        }
        // share the original fifteen-second readiness budget
        let remainingUnitWait = max(0, settingsDeadline.timeIntervalSinceNow)
        guard webView.staticTexts["Public unit preference: Celsius"].waitForExistence(
            timeout: remainingUnitWait
        ) else {
            attachHTTPSFixtureState("https-fixture-public-unit-persistence-failure", app: app, webView: webView)
            XCTFail("public Celsius preference did not persist after app restart")
            return
        }
        webView.buttons["Use Fahrenheit"].tap()
        XCTAssertTrue(webView.staticTexts["Public unit preference: Fahrenheit"].waitForExistence(timeout: 5))

        // prove same-origin history and target-blank stay in one WebView
        app.terminate()
        app = try fixtureApp(path: "/")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture home"].waitForExistence(timeout: 15))
        webView.links["Open fixture forecast"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture forecast"].waitForExistence(timeout: 10))
        let back = app.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        let homeNavigation = webView.links["Fixture home navigation"]
        XCTAssertTrue(homeNavigation.exists)
        attachHTTPSFixtureState("https-fixture-forecast-before-back", app: app, webView: webView)
        // require an actual touch-sized target outside the HTML navigation
        XCTAssertGreaterThanOrEqual(back.frame.width, 44)
        XCTAssertGreaterThanOrEqual(back.frame.height, 44)
        XCTAssertFalse(back.frame.intersects(homeNavigation.frame))
        back.tap()
        // retain failure state without waiving the ten-second home proof
        if !webView.staticTexts["Fixture home"].waitForExistence(timeout: 10) {
            attachHTTPSFixtureState("https-fixture-home-after-back-failure", app: app, webView: webView)
            XCTFail("native Back did not return to fixture home")
            return
        }
        attachHTTPSFixtureState("https-fixture-home-after-back", app: app, webView: webView)
        webView.links["Open fixture map in new window"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture map"].waitForExistence(timeout: 10))
        assertOneHostedWebView("https-fixture-map", app: app, webView: webView)

        // prove logs load through the same native hosted surface
        app.terminate()
        app = try fixtureApp(path: "/logs")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture logs"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.state, .runningForeground)
        assertOneHostedWebView("https-fixture-logs", app: app, webView: webView)

        // prove trends load through the same native hosted surface
        app.terminate()
        app = try fixtureApp(path: "/trends")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture trends"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.state, .runningForeground)
        assertOneHostedWebView("https-fixture-trends", app: app, webView: webView)

        // prove unsafe and external policy links never leave the fixture
        app.terminate()
        app = try fixtureApp(path: "/policy")
        app.launch()
        webView = app.webViews["weather.webview"]
        for label in ["Unsafe HTTP fixture", "Lookalike Weather origin", "External fixture policy"] {
            let link = webView.links[label]
            XCTAssertTrue(link.waitForExistence(timeout: 15))
            link.tap()
            XCTAssertTrue(link.waitForExistence(timeout: 3))
        }

        // pass the matched-host negative origin to normal TLS evaluation
        app.terminate()
        app = try fixtureApp(path: "/")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture home"].waitForExistence(timeout: 15))
        webView.links["Open untrusted TLS fixture"].tap()
        let loadError = app.staticTexts["weather.load-error"]
        XCTAssertTrue(loadError.waitForExistence(timeout: 15))
        let retry = app.buttons["Retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        XCTAssertTrue(loadError.waitForExistence(timeout: 15))
        attachHTTPSFixtureState(
            "https-fixture-untrusted-retry",
            app: app,
            webView: webView
        )
    }

    // refuse malformed fixture environment instead of loading production
    func testHTTPSFixtureFailsClosedWithoutOrigins() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-weather-https-fixture"]
        app.launchEnvironment["WEATHER_HTTPS_FIXTURE_IOS_ORIGIN"] = "invalid"
        app.launchEnvironment["WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN"] = "invalid"
        app.launch()
        XCTAssertTrue(app.staticTexts["weather.load-error"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Retry"].exists)
    }
}

@MainActor
final class WidgetHostUITests: XCTestCase {
    private enum MatrixScenario: String {
        case maximumDensity
        case nearCutoff
        case bedtime
        case adjustedStandard
        case fallBack
        case midnightRace
        case missingRawAtExpiry
        case springForward
        case staleOldSource

        // identify the actual hosted semantic surface
        var widgetLabelFragments: [String] {
            // bind each fixture to unique output
            switch self {
            case .maximumDensity:
                return ["21 forecast intervals", "Open-Meteo", "daylight", "standard"]
            case .nearCutoff:
                return ["1 forecast intervals", "Open-Meteo", "go to bed"]
            case .bedtime:
                return ["0 forecast intervals", "go to bed", "day complete"]
            case .adjustedStandard:
                return ["Updated, adjusted", "60–63°F", "Open-Meteo"]
            case .fallBack:
                return ["Updated, raw", "50°F", "Open-Meteo"]
            case .midnightRace:
                return ["weather unavailable"]
            case .missingRawAtExpiry:
                return ["Updated, mixed", "11°C", "go to bed", "Open-Meteo"]
            case .springForward:
                return ["Updated, raw", "10°C", "Open-Meteo"]
            case .staleOldSource:
                return ["Stale, raw", "50°F", "Open-Meteo"]
            }
        }

        // identify whether licensed numeric weather is present
        var showsWeather: Bool {
            self != .bedtime && self != .midnightRace
        }

        // identify the exact spare/cutoff message cases
        var showsBedtime: Bool {
            [.nearCutoff, .bedtime, .missingRawAtExpiry].contains(self)
        }
    }

    // capture one bounded application state
    private func attachState(_ application: XCUIApplication, name: String) {
        let screenshot = XCTAttachment(screenshot: application.screenshot())
        screenshot.name = "\(name)-screenshot"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let hierarchy = XCTAttachment(string: application.debugDescription)
        hierarchy.name = "\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    // find the first visible control
    private func firstHittable(
        in query: XCUIElementQuery,
        timeout: TimeInterval
    ) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)

        // poll while SpringBoard animates
        repeat {
            // inspect every current match
            for element in query.allElementsBoundByIndex {
                // require a usable control
                if element.exists && element.isHittable {
                    return element
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        return nil
    }

    // find semantics without requesting an activation point
    private func firstExisting(
        in query: XCUIElementQuery,
        timeout: TimeInterval
    ) -> XCUIElement? {
        let deadline = Date().addingTimeInterval(timeout)

        // poll while extension semantics attach
        repeat {
            // inspect every current match
            for element in query.allElementsBoundByIndex {
                // require only readable semantics
                if element.exists {
                    return element
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        return nil
    }

    // query exact accessible labels
    private func elements(
        in springboard: XCUIApplication,
        labeled labels: [String]
    ) -> XCUIElementQuery {
        let predicates = labels.flatMap { label in
            [
                NSPredicate(format: "label ==[c] %@", label),
                NSPredicate(format: "identifier == %@", label)
            ]
        }
        return springboard.descendants(matching: .any).matching(
            NSCompoundPredicate(orPredicateWithSubpredicates: predicates)
        )
    }

    // fail with visual selector evidence
    private func requireHittable(
        in query: XCUIElementQuery,
        springboard: XCUIApplication,
        stage: String,
        timeout: TimeInterval = 10
    ) throws -> XCUIElement {
        // return a discovered control
        if let element = firstHittable(in: query, timeout: timeout) {
            return element
        }

        attachState(springboard, name: "failure-\(stage)")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing hittable SpringBoard element at \(stage)"]
        )
    }

    // fail with semantic discovery evidence
    private func requireExisting(
        in query: XCUIElementQuery,
        springboard: XCUIApplication,
        stage: String,
        timeout: TimeInterval = 10
    ) throws -> XCUIElement {
        // return readable extension semantics
        if let element = firstExisting(in: query, timeout: timeout) {
            return element
        }

        attachState(springboard, name: "failure-\(stage)")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 6,
            userInfo: [NSLocalizedDescriptionKey: "missing WidgetKit semantics at \(stage)"]
        )
    }

    // query the SpringBoard widget container
    private func widgetHostQuery(on springboard: XCUIApplication) -> XCUIElementQuery {
        springboard.icons.matching(
            NSPredicate(
                format: "(label ==[c] %@ OR identifier == %@) AND value ==[c] %@",
                "Weather",
                "Weather",
                "Widget"
            )
        )
    }

    // find the tappable SpringBoard widget container
    private func widgetHostElement(on springboard: XCUIApplication) throws -> XCUIElement {
        let widget = try requireHittable(
            in: widgetHostQuery(on: springboard),
            springboard: springboard,
            stage: "weather-widget-springboard-host",
            timeout: 10
        )
        // reject multiple indistinguishable placements
        guard widgetHostQuery(on: springboard).count == 1 else {
            attachState(springboard, name: "failure-ambiguous-widget-host")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 12,
                userInfo: [NSLocalizedDescriptionKey: "SpringBoard exposed multiple Weather widget hosts"]
            )
        }
        return widget
    }

    // bind one accessible content frame to the observed host
    private func semanticBelongsToHost(_ semanticFrame: CGRect, hostFrame: CGRect) -> Bool {
        let normalized = normalizedSemanticFrame(semanticFrame, within: hostFrame).frame
        return normalized.width > 0 && normalized.height > 0 &&
            hostFrame.insetBy(dx: -1, dy: -1).contains(normalized)
    }

    // require only semantics geometrically bound to the one observed host
    private func requireTargetSemantics(
        on springboard: XCUIApplication,
        fragments: [String],
        stage: String,
        timeout: TimeInterval = 45
    ) throws -> XCUIElement {
        let deadline = Date().addingTimeInterval(timeout)
        let predicates = fragments.map { NSPredicate(format: "label CONTAINS[c] %@", $0) }
        let candidates = springboard.descendants(matching: .any).matching(
            NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        )

        // wait for the target's own rendered semantics
        repeat {
            let hosts = widgetHostQuery(on: springboard).allElementsBoundByIndex.filter { $0.exists }
            // reject a second physical host rather than sampling it
            if hosts.count > 1 {
                attachState(springboard, name: "failure-\(stage)-ambiguous-host")
                throw NSError(
                    domain: "farm.ballydidean.weather.widget-host",
                    code: 13,
                    userInfo: [NSLocalizedDescriptionKey: "multiple Weather widget hosts appeared"]
                )
            }
            // inspect semantics only after the unique host appears
            if let host = hosts.first {
                let frame = host.frame
                // ignore matching weather elsewhere on SpringBoard
                for candidate in candidates.allElementsBoundByIndex {
                    // accept only nonempty contained content
                    if candidate.exists,
                       semanticBelongsToHost(candidate.frame, hostFrame: frame) {
                        return candidate
                    }
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        attachState(springboard, name: "failure-\(stage)")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 14,
            userInfo: [NSLocalizedDescriptionKey: "observed Weather host did not render \(stage)"]
        )
    }

    // require the actual Home Screen before querying icons
    private func requireHomeScreen(on springboard: XCUIApplication) throws {
        let homeScreen = springboard.otherElements.matching(
            NSPredicate(format: "identifier == %@", "Home screen icons")
        )
        let appSwitcher = springboard.otherElements.matching(
            NSPredicate(format: "identifier == %@", "AppSwitcherContentView")
        )

        // accept the intended state immediately
        if firstExisting(in: homeScreen, timeout: 2) != nil {
            return
        }

        // dismiss the observed post-install app switcher state
        if firstExisting(in: appSwitcher, timeout: 1) != nil {
            attachState(springboard, name: "home-screen-app-switcher-before-recovery")
            XCUIDevice.shared.press(.home)
        }

        // fail before an app-switcher card can masquerade as an icon
        guard firstExisting(in: homeScreen, timeout: 10) != nil else {
            attachState(springboard, name: "failure-home-screen-state")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "SpringBoard did not expose Home screen icons"]
            )
        }
    }

    // enter editing through the exact captured SpringBoard action
    private func enterHomeScreenEditing(on springboard: XCUIApplication) throws {
        let editModeEdit = springboard.buttons.matching(
            NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Edit", "Edit")
        )
        let editModeDone = springboard.buttons.matching(
            NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Done", "Done")
        )

        // accept a completed prior transition
        if firstHittable(in: editModeEdit, timeout: 1) != nil,
           firstHittable(in: editModeDone, timeout: 1) != nil {
            return
        }

        let editHomeScreen = springboard.buttons.matching(
            NSPredicate(
                format: "identifier == %@ AND label ==[c] %@",
                "com.apple.springboardhome.application-shortcut-item.rearrange-icons",
                "Edit Home Screen"
            )
        )
        // retry one ignored public system-menu action
        for attempt in 1...2 {
            let editAction = try requireHittable(
                in: editHomeScreen,
                springboard: springboard,
                stage: "edit-home-screen-action-\(attempt)",
                timeout: 3
            )
            editAction.tap()

            // require the observed edit-mode controls
            if firstHittable(in: editModeEdit, timeout: 3) != nil,
               firstHittable(in: editModeDone, timeout: 3) != nil {
                return
            }

            // preserve the one bounded retry state
            if attempt == 1 {
                attachState(springboard, name: "edit-home-screen-retry-state")
            }
        }

        attachState(springboard, name: "failure-home-screen-edit-mode")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "SpringBoard did not enter Home Screen edit mode"]
        )
    }

    // find the app icon across bounded Home Screen pages
    private func weatherIcon(on springboard: XCUIApplication) throws -> XCUIElement {
        let weatherIcons = springboard.icons.matching(
            NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Weather", "Weather")
        )
        var discoveredIcon = firstHittable(in: weatherIcons, timeout: 2)
        // inspect the bounded Home Screen pages
        for _ in 0..<4 where discoveredIcon == nil {
            springboard.swipeLeft()
            discoveredIcon = firstHittable(in: weatherIcons, timeout: 2)
        }
        return try requireHittable(
            in: weatherIcons,
            springboard: springboard,
            stage: "weather-icon"
        )
    }

    // use the public direct conversion when SpringBoard offers it
    private func convertUsingDirectMediumAction(
        on springboard: XCUIApplication,
        widgets: XCUIElementQuery,
        mediumConversion: XCUIElementQuery
    ) throws -> XCUIElement? {
        // leave gallery placement to the caller when absent
        guard let directConversion = firstHittable(in: mediumConversion, timeout: 3) else {
            return nil
        }
        attachState(springboard, name: "home-screen-medium-conversion-before")
        directConversion.tap()

        // accept only the actual hosted widget postcondition
        if let convertedWidget = firstExisting(in: widgets, timeout: 45) {
            attachState(springboard, name: "home-screen-medium-conversion-after")
            return convertedWidget
        }

        // retry only when the exact action proves the first tap was ignored
        if let retryConversion = firstHittable(in: mediumConversion, timeout: 2) {
            attachState(springboard, name: "home-screen-medium-conversion-retry")
            retryConversion.tap()
            let convertedWidget = try requireExisting(
                in: widgets,
                springboard: springboard,
                stage: "converted-medium-widget",
                timeout: 45
            )
            attachState(springboard, name: "home-screen-medium-conversion-after")
            return convertedWidget
        }

        attachState(springboard, name: "failure-home-screen-medium-conversion")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "direct medium conversion did not host the widget"]
        )
    }

    // add one freshly installed WidgetKit artifact through public controls
    private func addWidget(
        on springboard: XCUIApplication,
        scenario: MatrixScenario
    ) throws -> XCUIElement {
        let widgets = widgetQuery(on: springboard, scenario: scenario)

        // reject stale placement across artifact replacements
        if firstExisting(in: widgetHostQuery(on: springboard), timeout: 2) != nil ||
            firstExisting(in: widgets, timeout: 2) != nil {
            attachState(springboard, name: "failure-stale-widget-before-placement")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 9,
                userInfo: [NSLocalizedDescriptionKey: "widget existed before fresh artifact placement"]
            )
        }

        let initialWeatherIcon = try weatherIcon(on: springboard)
        initialWeatherIcon.press(forDuration: 1.5)

        let mediumConversion = springboard.buttons.matching(
            NSPredicate(format: "label ==[c] %@", "Medium-sized widget")
        )
        // prefer the evidenced direct medium conversion
        if let convertedWidget = try convertUsingDirectMediumAction(
            on: springboard,
            widgets: widgets,
            mediumConversion: mediumConversion
        ) {
            return convertedWidget
        }

        let editHomeScreen = springboard.buttons.matching(
            NSPredicate(
                format: "identifier == %@ AND label ==[c] %@",
                "com.apple.springboardhome.application-shortcut-item.rearrange-icons",
                "Edit Home Screen"
            )
        )
        // retry only when the icon press exposed neither public action
        if firstHittable(in: editHomeScreen, timeout: 1) == nil {
            attachState(springboard, name: "home-screen-menu-missing-before-recovery")
            XCUIDevice.shared.press(.home)
            try requireHomeScreen(on: springboard)
            let retryWeatherIcon = try weatherIcon(on: springboard)
            retryWeatherIcon.press(forDuration: 1.5)

            // accept direct conversion exposed by the bounded retry
            if let convertedWidget = try convertUsingDirectMediumAction(
                on: springboard,
                widgets: widgets,
                mediumConversion: mediumConversion
            ) {
                return convertedWidget
            }
        }

        // retain the public gallery as a supported fallback
        try enterHomeScreenEditing(on: springboard)

        let addControls = elements(in: springboard, labeled: ["Add Widget", "Add"])
        let addControl: XCUIElement
        // use a directly exposed gallery control when available
        if let directAddControl = firstHittable(in: addControls, timeout: 2) {
            addControl = directAddControl
        } else {
            // open the iOS 26 edit menu observed in hosted evidence
            let editMenu = try requireHittable(
                in: elements(in: springboard, labeled: ["Edit"]),
                springboard: springboard,
                stage: "home-screen-edit-menu"
            )
            editMenu.tap()
            addControl = try requireHittable(
                in: addControls,
                springboard: springboard,
                stage: "home-screen-edit-menu-add-widget"
            )
            attachState(springboard, name: "home-screen-edit-menu")
        }
        addControl.tap()
        attachState(springboard, name: "widget-gallery")

        let searchField = firstHittable(in: springboard.searchFields, timeout: 5)
        // reveal search when the gallery starts collapsed
        if searchField == nil,
           let searchControl = firstHittable(
               in: elements(in: springboard, labeled: ["Search Widgets", "Search"]),
               timeout: 3
           ) {
            searchControl.tap()
        }
        let resolvedSearchField = try requireHittable(
            in: springboard.searchFields,
            springboard: springboard,
            stage: "widget-gallery-search"
        )
        resolvedSearchField.tap()
        resolvedSearchField.typeText("Weather")
        attachState(springboard, name: "weather-widget-search")

        // tap the hittable gallery result row observed in hosted evidence
        let weatherResult = try requireHittable(
            in: springboard.cells.matching(
                NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Weather", "Weather")
            ),
            springboard: springboard,
            stage: "weather-widget-result"
        )
        weatherResult.tap()
        attachState(springboard, name: "weather-widget-size")

        let addWidget = try requireHittable(
            in: elements(in: springboard, labeled: ["Add Widget", " Add Widget"]),
            springboard: springboard,
            stage: "add-weather-widget"
        )
        addWidget.tap()

        // finish home-screen editing when offered
        if let done = firstHittable(
            in: elements(in: springboard, labeled: ["Done"]),
            timeout: 3
        ) {
            done.tap()
        }

        return try requireExisting(
            in: widgets,
            springboard: springboard,
            stage: "placed-weather-widget",
            timeout: 45
        )
    }

    // query one fixture's actual hosted accessibility summary
    private func widgetQuery(
        on springboard: XCUIApplication,
        scenario: MatrixScenario
    ) -> XCUIElementQuery {
        // require every scenario fragment
        let predicates = scenario.widgetLabelFragments.map { fragment in
            NSPredicate(format: "label CONTAINS[c] %@", fragment)
        }
        return springboard.descendants(matching: .any).matching(
            NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        )
    }

    // find one widget across bounded Home Screen pages
    private func findWidget(
        on springboard: XCUIApplication,
        scenario: MatrixScenario,
        timeout: TimeInterval = 10
    ) throws -> XCUIElement {
        let widgets = widgetQuery(on: springboard, scenario: scenario)
        var widget = firstExisting(in: widgets, timeout: timeout)
        // inspect the bounded Home Screen pages
        for _ in 0..<4 where widget == nil {
            springboard.swipeLeft()
            widget = firstExisting(in: widgets, timeout: 2)
        }
        // return the witnessed hosted control
        if let widget {
            return widget
        }
        return try requireExisting(
            in: widgets,
            springboard: springboard,
            stage: "matrix-\(scenario.rawValue)-widget",
            timeout: 2
        )
    }

    // launch the deterministic app and request a public timeline refresh
    private func launchHost() throws -> (app: XCUIApplication, springboard: XCUIApplication) {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["WEATHER_RUN_WIDGET_HOST_TEST"] == "1",
            "actual WidgetKit host capture runs only in the bounded host probe"
        )

        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test", "-weather-m0-reload-widget"]
        app.launch()
        // require the containing app before host interaction
        guard app.webViews["weather.webview"].waitForExistence(timeout: 15) else {
            attachState(app, name: "failure-containing-app-launch")
            XCTFail("containing app did not expose its WebKit surface")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 2,
                userInfo: nil
            )
        }

        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // require SpringBoard before host interaction
        guard springboard.wait(for: .runningForeground, timeout: 10) else {
            attachState(springboard, name: "failure-springboard-launch")
            XCTFail("SpringBoard did not become foreground")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 3,
                userInfo: nil
            )
        }
        try requireHomeScreen(on: springboard)
        return (app, springboard)
    }

    // choose genuine Home Screen tinted rendering
    private func selectTintedAppearance(
        for widget: XCUIElement,
        on springboard: XCUIApplication
    ) throws -> XCUIElement {
        XCTAssertTrue(widget.exists)
        let hostWidget = try widgetHostElement(on: springboard)
        hostWidget.press(forDuration: 1.5)
        try enterHomeScreenEditing(on: springboard)

        let editMenu = try requireHittable(
            in: elements(in: springboard, labeled: ["Edit"]),
            springboard: springboard,
            stage: "matrix-tinted-edit-menu"
        )
        editMenu.tap()
        let customize = try requireHittable(
            in: elements(in: springboard, labeled: ["Customize"]),
            springboard: springboard,
            stage: "matrix-tinted-customize"
        )
        attachState(springboard, name: "matrix-tinted-edit-menu")
        customize.tap()
        attachState(springboard, name: "matrix-tinted-customization")

        let tinted = try requireHittable(
            in: elements(in: springboard, labeled: ["Tinted"]),
            springboard: springboard,
            stage: "matrix-tinted-control"
        )
        tinted.tap()
        attachState(springboard, name: "matrix-tinted-selected")

        let selectedTint = try requireHittable(
            in: elements(in: springboard, labeled: ["Tinted"]),
            springboard: springboard,
            stage: "matrix-tinted-selected-control"
        )
        let selectedValue = String(describing: selectedTint.value ?? "")
        // require an exposed selected-state postcondition
        guard selectedTint.isSelected ||
            selectedValue.localizedCaseInsensitiveContains("selected") else {
            attachState(springboard, name: "failure-matrix-tinted-not-selected")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "SpringBoard did not expose Tinted as selected"]
            )
        }

        // dismiss customization through the public Home control
        XCUIDevice.shared.press(.home)
        _ = springboard.wait(for: .runningForeground, timeout: 10)
        return try findWidget(on: springboard, scenario: .maximumDensity, timeout: 20)
    }

    // edit the product temperature unit through the public widget sheet
    private func editTemperatureUnit(
        to label: String,
        on springboard: XCUIApplication
    ) throws {
        let hostWidget = try widgetHostElement(on: springboard)
        let originalFrame = hostWidget.frame
        attachState(springboard, name: "unit-target-before-\(label.lowercased())-edit")
        hostWidget.press(forDuration: 1.5)
        let editWidget = try requireHittable(
            in: elements(in: springboard, labeled: ["Edit Widget"]),
            springboard: springboard,
            stage: "unit-edit-widget"
        )
        editWidget.tap()

        // require the system switch in its prior state
        let switchQuery = springboard.switches.matching(
            NSPredicate(format: "label ==[c] %@", "Use Celsius")
        )
        let unitSwitch = try requireHittable(
            in: switchQuery,
            springboard: springboard,
            stage: "unit-switch-before-\(label.lowercased())"
        )
        attachState(springboard, name: "unit-edit-sheet")
        let priorValue = label == "Celsius" ? "0" : "1"
        let selectedValue = label == "Celsius" ? "1" : "0"
        // reject a missing or ambiguous prior switch state
        guard switchQuery.count == 1,
              String(describing: unitSwitch.value ?? "") == priorValue else {
            attachState(springboard, name: "failure-unit-switch-prior-state")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 21,
                userInfo: [NSLocalizedDescriptionKey: "public temperature switch did not expose the prior 0/1 state"]
            )
        }
        // tap the visible switch track inside the full-width row
        unitSwitch.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        // require the actual system switch state after the public tap
        let switchDeadline = Date().addingTimeInterval(3)
        // wait only for the existing edit-sheet transition
        while switchQuery.firstMatch.exists,
              String(describing: switchQuery.firstMatch.value ?? "") != selectedValue,
              Date() < switchDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        guard switchQuery.firstMatch.exists,
              String(describing: switchQuery.firstMatch.value ?? "") == selectedValue else {
            attachState(springboard, name: "failure-unit-switch-selected-state")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 22,
                userInfo: [NSLocalizedDescriptionKey: "public temperature switch did not expose the selected 0/1 state"]
            )
        }
        attachState(springboard, name: "unit-selected-\(label.lowercased())")
        let editRow = elements(in: springboard, labeled: ["Use Celsius"])

        // commit through the system sheet when it exposes Done
        if let done = firstHittable(
            in: elements(in: springboard, labeled: ["Done"]),
            timeout: 3
        ) {
            done.tap()
        } else {
            // dismiss at the observed blank point above the edit card
            let screen = springboard.frame
            let outsideCard = springboard.coordinate(
                withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)
            )
            guard editRow.firstMatch.exists,
                  screen.minY + screen.height * 0.12 < editRow.firstMatch.frame.minY - 80 else {
                attachState(springboard, name: "failure-unit-outside-card-geometry")
                throw NSError(
                    domain: "farm.ballydidean.weather.widget-host",
                    code: 15,
                    userInfo: [NSLocalizedDescriptionKey: "outside-card point overlaps the edit controls"]
                )
            }
            outsideCard.tap()
        }
        // require the public edit card to close before reading the host
        let dismissalDeadline = Date().addingTimeInterval(3)
        // wait only for the actual card transition
        while editRow.firstMatch.exists && Date() < dismissalDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        guard !editRow.firstMatch.exists else {
            attachState(springboard, name: "failure-unit-edit-card-not-dismissed")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 16,
                userInfo: [NSLocalizedDescriptionKey: "widget edit card remained open after public dismissal"]
            )
        }
        try requireHomeScreen(on: springboard)
        let observedFrame = try widgetHostElement(on: springboard).frame
        // retain the same visible placement after dismissal
        guard abs(observedFrame.minX - originalFrame.minX) <= 2,
              abs(observedFrame.minY - originalFrame.minY) <= 2,
              abs(observedFrame.width - originalFrame.width) <= 2,
              abs(observedFrame.height - originalFrame.height) <= 2 else {
            attachState(springboard, name: "failure-unit-target-changed-after-dismissal")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 17,
                userInfo: [NSLocalizedDescriptionKey: "observed Weather host changed after edit"]
            )
        }
        attachState(springboard, name: "unit-target-after-\(label.lowercased())-dismissal")
    }

    // prove the typed persisted unit and visible spoken rerender
    private func assertTemperatureUnit(
        _ unit: String,
        symbol: String,
        app: XCUIApplication,
        springboard: XCUIApplication,
        stage: String
    ) throws {
        try requireHomeScreen(on: springboard)
        let widget = try requireTargetSemantics(
            on: springboard,
            fragments: [symbol, "adjusted air temperature", "Open-Meteo"],
            stage: "unit-\(stage)-visible-spoken"
        )
        XCTAssertTrue(widget.label.contains(symbol))
        XCTAssertTrue(widget.label.contains("adjusted air temperature"))
        attachState(springboard, name: "unit-\(stage)-visible-spoken")

        // inspect typed configuration only after the target renders
        _ = try captureWidgetConfiguration(
            unit: unit,
            app: app,
            stage: "unit-\(stage)-typed-widget-info"
        )
        // restore the same public host before the next edit stage
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))
        try requireHomeScreen(on: springboard)
        _ = try widgetHostElement(on: springboard)
    }

    // wait for the expected public typed WidgetInfo value
    private func assertConfigurationReceiptBoundaries() {
        let valid = "widget-config epoch=2 observedAtMs=123 status=unique total=1 matchCount=1 kind=farm.ballydidean.weather.forecast family=systemMedium unit=celsius"
        XCTAssertTrue(WidgetConfigurationReceipt(valid)?.accepts(epoch: 2, unit: "celsius") == true)
        let rejected = [
            valid.replacingOccurrences(of: "status=unique total=1 matchCount=1", with: "status=missing total=0 matchCount=0"),
            valid.replacingOccurrences(of: "status=unique total=1 matchCount=1", with: "status=ambiguous total=2 matchCount=2"),
            valid.replacingOccurrences(of: "status=unique", with: "status=untyped"),
            valid.replacingOccurrences(of: "unit=celsius", with: "unit=nil"),
            valid.replacingOccurrences(of: "status=unique", with: "status=ambiguous") + " detail=celsius",
            valid.replacingOccurrences(of: "family=systemMedium", with: "family=systemLarge"),
            String(valid.dropLast(8))
        ]
        // reject every missing, ambiguous, untyped, or partial receipt
        for receipt in rejected {
            XCTAssertFalse(WidgetConfigurationReceipt(receipt)?.accepts(epoch: 2, unit: "celsius") == true)
        }
        XCTAssertFalse(WidgetConfigurationReceipt(valid)?.accepts(epoch: 3, unit: "celsius") == true)
        let host = CGRect(x: 24, y: 88, width: 354, height: 191)
        // reject another widget's temperature even when its label matches
        XCTAssertFalse(semanticBelongsToHost(
            CGRect(x: 400, y: 88, width: 200, height: 160), hostFrame: host
        ))
        XCTAssertTrue(semanticBelongsToHost(
            CGRect(x: 26, y: 90, width: 349, height: 164), hostFrame: host
        ))
    }

    // query a fresh supported summary within one stage deadline
    private func captureWidgetConfiguration(
        unit: String,
        app: XCUIApplication,
        stage: String
    ) throws -> String {
        app.terminate()
        app.launchArguments = [
            "-weather-ui-test",
            "-weather-m0-reload-widget",
            "-weather-widget-configuration-diagnostic"
        ]
        app.launch()
        let diagnostic = app.staticTexts["weather.widget.configuration"]
        let refresh = app.buttons["weather.widget.configuration.refresh"]
        let deadline = Date().addingTimeInterval(15)
        var refreshCount = 0
        var lastQueryRequest = Date()

        // reject pending, stale, ambiguous, and mismatched values
        repeat {
            let value = String(describing: refresh.value ?? "")
            let currentEpoch = value.hasPrefix("epoch=") ? Int(value.dropFirst(6)) : nil
            // process only the epoch independently exposed by the control
            if diagnostic.exists,
               let expectedEpoch = currentEpoch,
               expectedEpoch > 0,
               let summary = WidgetConfigurationReceipt(diagnostic.label),
               summary.epoch == expectedEpoch {
                // accept only a complete unique current result
                if summary.accepts(epoch: expectedEpoch, unit: unit) {
                    let receipt = XCTAttachment(string: diagnostic.label)
                    receipt.name = stage
                    receipt.lifetime = .keepAlways
                    add(receipt)
                    attachState(app, name: stage)
                    return diagnostic.label
                }
                // refresh only a completed unresolved public query
                if summary.status != "pending",
                   refreshCount < 2,
                   Date().timeIntervalSince(lastQueryRequest) >= 4,
                   refresh.exists {
                    refresh.tap()
                    refreshCount += 1
                    lastQueryRequest = Date()
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        attachState(app, name: "failure-\(stage)")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 11,
            userInfo: [NSLocalizedDescriptionKey: "unique current typed WidgetInfo did not report unit=\(unit)"]
        )
    }

    // query public configuration before reopening the failed edit
    private func diagnoseFailedTemperatureConfiguration(app: XCUIApplication) throws {
        app.terminate()
        app.launchArguments = ["-weather-ui-test", "-weather-widget-configuration-diagnostic"]
        app.launch()
        let diagnostic = app.staticTexts["weather.widget.configuration"]
        let refresh = app.buttons["weather.widget.configuration.refresh"]
        let deadline = Date().addingTimeInterval(10)
        // retain any complete count and unit as observation, never acceptance
        repeat {
            let value = String(describing: refresh.value ?? "")
            let currentEpoch = value.hasPrefix("epoch=") ? Int(value.dropFirst(6)) : nil
            if diagnostic.exists,
               let currentEpoch,
               let summary = WidgetConfigurationReceipt(diagnostic.label),
               summary.epoch == currentEpoch,
               summary.status != "pending" {
                let receipt = XCTAttachment(string: diagnostic.label)
                receipt.name = "unit-failure-fresh-typed-observation"
                receipt.lifetime = .keepAlways
                add(receipt)
                attachState(app, name: "unit-failure-fresh-typed-observation")
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        attachState(app, name: "unit-failure-fresh-typed-observation-timeout")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 20,
            userInfo: [NSLocalizedDescriptionKey: "failed-edit typed diagnostic did not complete"]
        )
    }

    // observe the same host's edit row after the public query
    private func diagnoseFailedTemperatureRow(
        springboard: XCUIApplication,
        originalFrame: CGRect
    ) throws {
        XCUIDevice.shared.press(.home)
        try requireHomeScreen(on: springboard)
        let host = try widgetHostElement(on: springboard)
        let frame = host.frame
        // refuse a different placement as diagnostic evidence
        guard abs(frame.minX - originalFrame.minX) <= 2,
              abs(frame.minY - originalFrame.minY) <= 2,
              abs(frame.width - originalFrame.width) <= 2,
              abs(frame.height - originalFrame.height) <= 2 else {
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 18,
                userInfo: [NSLocalizedDescriptionKey: "failed-edit diagnostic host differs from placed host"]
            )
        }
        attachState(springboard, name: "unit-failure-target-before-reopen")
        host.press(forDuration: 1.5)
        let edit = try requireHittable(
            in: elements(in: springboard, labeled: ["Edit Widget"]),
            springboard: springboard,
            stage: "unit-failure-reopen-edit-widget"
        )
        edit.tap()
        let unitSwitch = springboard.switches.matching(
            NSPredicate(format: "label ==[c] %@", "Use Celsius")
        )
        let row = elements(in: springboard, labeled: ["Use Celsius"])
        // observe one current public switch without changing it
        guard row.firstMatch.waitForExistence(timeout: 5),
              unitSwitch.count == 1,
              ["0", "1"].contains(String(describing: unitSwitch.firstMatch.value ?? "")) else {
            attachState(springboard, name: "unit-failure-reopened-row-ambiguous")
            throw NSError(
                domain: "farm.ballydidean.weather.widget-host",
                code: 19,
                userInfo: [NSLocalizedDescriptionKey: "failed-edit stored row is missing or ambiguous"]
            )
        }
        let observedValue = String(describing: unitSwitch.firstMatch.value ?? "")
        let observedUnit = observedValue == "1" ? "celsius" : "fahrenheit"
        let rowReceipt = XCTAttachment(
            string: "unit-failure-reopened-row unit=\(observedUnit) switch=\(observedValue)"
        )
        rowReceipt.name = "unit-failure-reopened-stored-row"
        rowReceipt.lifetime = .keepAlways
        add(rowReceipt)
        attachState(springboard, name: "unit-failure-reopened-stored-row")
        // dismiss only after recording the post-query row
        XCUIDevice.shared.press(.home)
    }

    // require complete persisted failure semantics from WidgetKit
    private func assertPersistenceFailure(
        on springboard: XCUIApplication,
        stage: String
    ) throws -> XCUIElement {
        let required = ["Offline", "°C", "Open-Meteo", "CC BY 4.0"]
        let widget = try requireTargetSemantics(on: springboard, fragments: required, stage: stage)
        let label = widget.label
        XCTAssertTrue(label.contains("Offline, adjusted"), label)
        XCTAssertEqual(label.components(separatedBy: "air temperature").count - 1, 7, label)
        XCTAssertNotNil(
            label.range(of: #"-?[0-9]+(?:–-?[0-9]+)?°C"#, options: .regularExpression),
            label
        )
        XCTAssertTrue(label.contains("Weather data by Open-Meteo under CC BY 4.0"), label)
        attachState(springboard, name: stage)
        return widget
    }

    // locate the actual fixed Home Screen host frame
    private func systemMediumHostFrame(on springboard: XCUIApplication) throws -> CGRect {
        let candidates = springboard.scrollViews
        let deadline = Date().addingTimeInterval(5)

        // wait for the outer WidgetKit container
        repeat {
            // inspect frame geometry without requiring hit testing
            for candidate in candidates.allElementsBoundByIndex {
                let frame = candidate.frame
                // accept only medium-sized landscape geometry
                if frame.width > 250,
                   frame.height > 100,
                   frame.height < 250,
                   frame.minX > 0,
                   frame.minY > 0,
                   frame.width > frame.height * 1.5 {
                    return frame
                }
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline

        attachState(springboard, name: "failure-system-medium-host-frame")
        throw NSError(
            domain: "farm.ballydidean.weather.widget-host",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "actual systemMedium host frame was not found"]
        )
    }

    // normalize extension-local semantics into screen coordinates
    private func normalizedSemanticFrame(
        _ semanticFrame: CGRect,
        within outerHostFrame: CGRect
    ) -> (frame: CGRect, coordinateSpace: String) {
        // translate only the evidenced extension-local origin
        if abs(semanticFrame.minX) <= 1, abs(semanticFrame.minY) <= 1 {
            return (
                CGRect(origin: outerHostFrame.origin, size: semanticFrame.size),
                "extension-local"
            )
        }
        return (semanticFrame, "screen")
    }

    // capture semantics, geometry, and the fixed primary tap
    private func captureAndTap(
        _ widget: XCUIElement,
        scenario: MatrixScenario,
        caseID: String,
        app: XCUIApplication,
        springboard: XCUIApplication
    ) throws {
        attachState(springboard, name: "matrix-\(caseID)-home-screen")
        XCTAssertTrue(widget.exists)
        // hard expiry must remove yesterday's sunset
        if scenario == .midnightRace {
            XCTAssertFalse(widget.label.contains("Sunset"))
        } else {
            XCTAssertTrue(widget.label.contains("Sunset"))
        }
        // require weather-only content and credit
        if scenario.showsWeather {
            XCTAssertTrue(widget.label.contains("air temperature"))
            XCTAssertTrue(widget.label.contains("CC BY 4.0"))
        } else {
            XCTAssertFalse(widget.label.contains("Open-Meteo"))
        }
        // require exact cutoff copy
        if scenario.showsBedtime {
            XCTAssertTrue(widget.label.contains("go to bed"))
        }
        let outerHostFrame = try systemMediumHostFrame(on: springboard)
        let semanticContentRawFrame = widget.frame
        let semanticContent = normalizedSemanticFrame(
            semanticContentRawFrame,
            within: outerHostFrame
        )
        let expandedHostFrame = outerHostFrame.insetBy(dx: -1, dy: -1)
        XCTAssertGreaterThan(outerHostFrame.width, outerHostFrame.height * 1.5)
        XCTAssertGreaterThan(outerHostFrame.width, 250)
        XCTAssertGreaterThan(outerHostFrame.height, 100)
        XCTAssertTrue(
            expandedHostFrame.contains(semanticContent.frame),
            "semantic content escaped the actual systemMedium host bounds"
        )

        // record outer and inner geometry separately
        let geometryDescription = """
        case=\(caseID)
        scenario=\(scenario.rawValue)
        system-medium-outer-frame-points=\(outerHostFrame)
        semantic-content-raw-frame-points=\(semanticContentRawFrame)
        semantic-content-coordinate-space=\(semanticContent.coordinateSpace)
        semantic-content-normalized-frame-points=\(semanticContent.frame)
        semantic-content-contained=\(expandedHostFrame.contains(semanticContent.frame))
        """
        let geometryAttachment = XCTAttachment(string: geometryDescription)
        geometryAttachment.name = "matrix-\(caseID)-widgetkit-bounds"
        geometryAttachment.lifetime = .keepAlways
        add(geometryAttachment)

        let hostWidget = try widgetHostElement(on: springboard)
        hostWidget.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(app.webViews["weather.webview"].staticTexts["Weather route /forecast"].waitForExistence(timeout: 10))

        let tapAttachment = XCTAttachment(screenshot: app.screenshot())
        tapAttachment.name = "matrix-\(caseID)-widget-tap-forecast-route"
        tapAttachment.lifetime = .keepAlways
        add(tapAttachment)
    }

    // place and capture the baseline actual widget
    func test01MaximumLightLarge() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .maximumDensity)
        try captureAndTap(
            widget,
            scenario: .maximumDensity,
            caseID: "01-maximum-light-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture the dark actual widget
    func test02MaximumDarkLarge() throws {
        let host = try launchHost()
        let widget = try findWidget(on: host.springboard, scenario: .maximumDensity)
        try captureAndTap(
            widget,
            scenario: .maximumDensity,
            caseID: "02-maximum-dark-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture fixed visual type under the actual AX5 setting
    func test03MaximumLightAX5() throws {
        let host = try launchHost()
        let widget = try findWidget(on: host.springboard, scenario: .maximumDensity)
        try captureAndTap(
            widget,
            scenario: .maximumDensity,
            caseID: "03-maximum-light-ax5",
            app: host.app,
            springboard: host.springboard
        )
    }

    // place and capture the compiled near-cutoff artifact
    func test04NearCutoffLightLarge() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .nearCutoff)
        try captureAndTap(
            widget,
            scenario: .nearCutoff,
            caseID: "04-near-cutoff-light-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // place and capture the compiled bedtime artifact
    func test05BedtimeLightLarge() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .bedtime)
        try captureAndTap(
            widget,
            scenario: .bedtime,
            caseID: "05-bedtime-light-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // place maximum density and capture genuine tinting
    func test06MaximumTintedLarge() throws {
        let host = try launchHost()
        let maximum = try addWidget(on: host.springboard, scenario: .maximumDensity)
        let widget = try selectTintedAppearance(for: maximum, on: host.springboard)
        try captureAndTap(
            widget,
            scenario: .maximumDensity,
            caseID: "06-maximum-tinted-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // leave one publicly edited Celsius configuration for the restart probe
    func test07TemperatureUnitEditToCelsius() throws {
        assertConfigurationReceiptBoundaries()
        let host = try launchHost()
        _ = try addWidget(on: host.springboard, scenario: .maximumDensity)
        let placedFrame = try widgetHostElement(on: host.springboard).frame
        // keep the original product verdict even when diagnosis fails
        do {
            try assertTemperatureUnit(
                "fahrenheit",
                symbol: "°F",
                app: host.app,
                springboard: host.springboard,
                stage: "initial-fahrenheit"
            )
            try editTemperatureUnit(to: "Celsius", on: host.springboard)
            try assertTemperatureUnit(
                "celsius",
                symbol: "°C",
                app: host.app,
                springboard: host.springboard,
                stage: "celsius"
            )
        } catch {
            let primaryFailure = error
            attachState(host.springboard, name: "unit-failure-primary-state")
            // query before any potentially committing edit-card action
            do {
                try diagnoseFailedTemperatureConfiguration(app: host.app)
            } catch {
                let diagnosticFailure = XCTAttachment(string: String(describing: error))
                diagnosticFailure.name = "unit-failure-typed-diagnostic-error"
                diagnosticFailure.lifetime = .keepAlways
                add(diagnosticFailure)
                attachState(host.app, name: "unit-failure-typed-diagnostic-state")
            }
            // keep post-query row failure independent of the typed result
            do {
                try diagnoseFailedTemperatureRow(
                    springboard: host.springboard,
                    originalFrame: placedFrame
                )
            } catch {
                let diagnosticFailure = XCTAttachment(string: String(describing: error))
                diagnosticFailure.name = "unit-failure-row-diagnostic-error"
                diagnosticFailure.lifetime = .keepAlways
                add(diagnosticFailure)
                attachState(host.springboard, name: "unit-failure-row-diagnostic-state")
            }
            throw primaryFailure
        }

    }

    // prove Celsius survived extension restart before restoring Fahrenheit
    func test08TemperatureUnitPersistsAfterExtensionRestart() throws {
        let host = try launchHost()
        _ = try findWidget(on: host.springboard, scenario: .maximumDensity, timeout: 45)
        try assertTemperatureUnit(
            "celsius",
            symbol: "°C",
            app: host.app,
            springboard: host.springboard,
            stage: "celsius-after-restart"
        )

        try editTemperatureUnit(to: "Fahrenheit", on: host.springboard)
        try assertTemperatureUnit(
            "fahrenheit",
            symbol: "°F",
            app: host.app,
            springboard: host.springboard,
            stage: "final-fahrenheit"
        )
    }

    // capture decoded adjusted shared semantics in the real host
    func test09AdjustedStandardSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .adjustedStandard)
        try captureAndTap(
            widget,
            scenario: .adjustedStandard,
            caseID: "09-adjusted-standard",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture decoded fall-back grouping in the real host
    func test10FallBackSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .fallBack)
        try captureAndTap(
            widget,
            scenario: .fallBack,
            caseID: "10-fall-back",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture hard-expired unavailable semantics in the real host
    func test11MidnightRaceSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .midnightRace)
        try captureAndTap(
            widget,
            scenario: .midnightRace,
            caseID: "11-midnight-race",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture mixed raw fallback and Celsius semantics in the real host
    func test12MissingRawSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .missingRawAtExpiry)
        try captureAndTap(
            widget,
            scenario: .missingRawAtExpiry,
            caseID: "12-missing-raw-at-expiry",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture spring-forward raw Celsius semantics in the real host
    func test13SpringForwardSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .springForward)
        try captureAndTap(
            widget,
            scenario: .springForward,
            caseID: "13-spring-forward",
            app: host.app,
            springboard: host.springboard
        )
    }

    // capture stale old-source semantics in the real host
    func test14StaleOldSourceSemanticHost() throws {
        let host = try launchHost()
        let widget = try addWidget(on: host.springboard, scenario: .staleOldSource)
        try captureAndTap(
            widget,
            scenario: .staleOldSource,
            caseID: "14-stale-old-source",
            app: host.app,
            springboard: host.springboard
        )
    }

    // persist one real last-good snapshot and offline attempt
    func test15PersistenceSeedAndFailBeforeRestart() throws {
        let host = try launchHost()
        let seeded = try addWidget(on: host.springboard, scenario: .adjustedStandard)
        XCTAssertTrue(seeded.label.contains("Updated, adjusted"), seeded.label)
        XCTAssertTrue(seeded.label.contains("°F"), seeded.label)
        XCTAssertEqual(
            seeded.label.components(separatedBy: "air temperature").count - 1,
            7,
            seeded.label
        )
        XCTAssertTrue(
            seeded.label.contains("Weather data by Open-Meteo under CC BY 4.0"),
            seeded.label
        )
        attachState(host.springboard, name: "persistence-seeded-success")

        try editTemperatureUnit(to: "Celsius", on: host.springboard)
        _ = try assertPersistenceFailure(
            on: host.springboard,
            stage: "persistence-before-restart-offline-visible-spoken"
        )
        let widgetInfo = try captureWidgetConfiguration(
            unit: "celsius",
            app: host.app,
            stage: "persistence-before-restart-widget-info"
        )
        XCTAssertTrue(widgetInfo.contains("status=unique"), widgetInfo)
        XCUIDevice.shared.press(.home)
        try requireHomeScreen(on: host.springboard)
    }

    // read the exact persisted failure after extension process death
    func test16PersistenceFailureSurvivesExtensionRestart() throws {
        let host = try launchHost()
        _ = try assertPersistenceFailure(
            on: host.springboard,
            stage: "persistence-after-restart-offline-visible-spoken"
        )
        let widgetInfo = try captureWidgetConfiguration(
            unit: "celsius",
            app: host.app,
            stage: "persistence-after-restart-widget-info"
        )
        XCTAssertTrue(widgetInfo.contains("status=unique"), widgetInfo)
        XCUIDevice.shared.press(.home)
        try requireHomeScreen(on: host.springboard)
    }
}
