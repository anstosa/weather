import XCTest

@MainActor
final class WeatherDeepLinkUITests: XCTestCase {
    // preserve an actual loaded WebKit failure state
    private func attachFailureState(_ app: XCUIApplication, webView: XCUIElement) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "deep-link-loaded-document-failure"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "deep-link-app-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)

        let webViewState = XCTAttachment(string: webView.debugDescription)
        webViewState.name = "deep-link-webview-hierarchy"
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

    // open the same fixed route used by the widget
    func testForecastDeepLinkOpensContainingApp() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test"]
        app.launch()

        let webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.waitForExistence(timeout: 15))
        XCTAssertTrue(webView.staticTexts["Weather route /"].waitForExistence(timeout: 5))

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
        let selector = webView.buttons["Fixture server unit"]
        XCTAssertTrue(selector.waitForExistence(timeout: 5))
        selector.tap()
        let picker = app.pickerWheels.firstMatch
        // use the standard iOS select picker when exposed
        if picker.waitForExistence(timeout: 3) {
            picker.adjust(toPickerWheelValue: unit)
            let done = app.toolbars.buttons["Done"]
            XCTAssertTrue(done.waitForExistence(timeout: 3))
            done.tap()
            return
        }
        let option = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", unit)
        ).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 3))
        option.tap()
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
        XCTAssertTrue(webView.staticTexts["Fixture sign in"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(webView.staticTexts["Public unit preference: Celsius"].waitForExistence(timeout: 15))
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
        XCTAssertTrue(app.buttons["Back"].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture home"].waitForExistence(timeout: 10))
        webView.links["Open fixture map in new window"].tap()
        XCTAssertTrue(webView.staticTexts["Fixture map"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.webViews.count, 1)

        // prove logs load through the same native hosted surface
        app.terminate()
        app = try fixtureApp(path: "/logs")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture logs"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertEqual(app.webViews.count, 1)

        // prove trends load through the same native hosted surface
        app.terminate()
        app = try fixtureApp(path: "/trends")
        app.launch()
        webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.staticTexts["Fixture trends"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertEqual(app.webViews.count, 1)

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
        return try requireHittable(
            in: widgetHostQuery(on: springboard),
            springboard: springboard,
            stage: "weather-widget-springboard-host",
            timeout: 10
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

        let weatherIcons = springboard.icons.matching(
            NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Weather", "Weather")
        )
        var discoveredIcon = firstHittable(in: weatherIcons, timeout: 2)
        // inspect the bounded Home Screen pages
        for _ in 0..<4 where discoveredIcon == nil {
            springboard.swipeLeft()
            discoveredIcon = firstHittable(in: weatherIcons, timeout: 2)
        }
        let weatherIcon = try requireHittable(
            in: weatherIcons,
            springboard: springboard,
            stage: "weather-icon"
        )
        weatherIcon.press(forDuration: 1.5)

        let mediumConversion = springboard.buttons.matching(
            NSPredicate(format: "label ==[c] %@", "Medium-sized widget")
        )
        // prefer the evidenced direct medium conversion
        if let directConversion = firstHittable(in: mediumConversion, timeout: 3) {
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
        hostWidget.press(forDuration: 1.5)
        let editWidget = try requireHittable(
            in: elements(in: springboard, labeled: ["Edit Widget"]),
            springboard: springboard,
            stage: "unit-edit-widget"
        )
        editWidget.tap()
        attachState(springboard, name: "unit-edit-sheet")

        let target = elements(in: springboard, labeled: [label])
        // open the parameter choice when the value is not directly actionable
        if firstHittable(in: target, timeout: 2) == nil {
            let parameter = try requireHittable(
                in: elements(in: springboard, labeled: ["Temperature unit", "Temperature Unit"]),
                springboard: springboard,
                stage: "unit-parameter"
            )
            parameter.tap()
        }
        let choice = try requireHittable(
            in: target,
            springboard: springboard,
            stage: "unit-choice-\(label.lowercased())"
        )
        choice.tap()
        attachState(springboard, name: "unit-selected-\(label.lowercased())")

        // commit through the system sheet when it exposes Done
        if let done = firstHittable(
            in: elements(in: springboard, labeled: ["Done"]),
            timeout: 3
        ) {
            done.tap()
        } else {
            XCUIDevice.shared.press(.home)
        }
        try requireHomeScreen(on: springboard)
    }

    // prove the typed persisted unit and visible spoken rerender
    private func assertTemperatureUnit(
        _ unit: String,
        symbol: String,
        app: XCUIApplication,
        springboard: XCUIApplication,
        stage: String
    ) throws {
        app.terminate()
        app.launchArguments = [
            "-weather-ui-test",
            "-weather-m0-reload-widget",
            "-weather-widget-configuration-diagnostic"
        ]
        app.launch()
        let diagnostic = app.staticTexts["weather.widget.configuration"]
        XCTAssertTrue(diagnostic.waitForExistence(timeout: 15))
        XCTAssertTrue(diagnostic.label.contains("unit=\(unit)"), diagnostic.label)
        attachState(app, name: "unit-\(stage)-typed-widget-info")

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))
        try requireHomeScreen(on: springboard)
        let unitSemantics = springboard.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] %@", symbol)
        )
        let widget = try requireExisting(
            in: unitSemantics,
            springboard: springboard,
            stage: "unit-\(stage)-visible-spoken",
            timeout: 45
        )
        XCTAssertTrue(widget.label.contains(symbol))
        XCTAssertTrue(widget.label.contains("adjusted air temperature"))
        attachState(springboard, name: "unit-\(stage)-visible-spoken")
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
        let host = try launchHost()
        _ = try addWidget(on: host.springboard, scenario: .maximumDensity)
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
}
