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
}

@MainActor
final class WidgetHostUITests: XCTestCase {
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

    // add the real WidgetKit surface through the public gallery UI
    private func addMaximumWidget(on springboard: XCUIApplication) throws -> XCUIElement {
        let widgetPredicate = NSPredicate(
            format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@",
            "Open-Meteo",
            "21 forecast intervals"
        )
        let widgets = springboard.descendants(matching: .any).matching(widgetPredicate)

        // reuse only a real existing widget
        if let widget = firstHittable(in: widgets, timeout: 2) {
            return widget
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

        let editActions = elements(
            in: springboard,
            labeled: ["Edit Home Screen", "Edit Home Screen…"]
        )
        // enter edit mode when the icon menu appears
        if let editAction = firstHittable(in: editActions, timeout: 3) {
            editAction.tap()
        }

        let addControl = try requireHittable(
            in: elements(in: springboard, labeled: ["Add Widget", "Add"]),
            springboard: springboard,
            stage: "home-screen-add"
        )
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

        let weatherResult = try requireHittable(
            in: springboard.staticTexts.matching(
                NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Weather", "Weather")
            ),
            springboard: springboard,
            stage: "weather-widget-result"
        )
        weatherResult.tap()
        attachState(springboard, name: "weather-widget-size")

        let addWidget = try requireHittable(
            in: elements(in: springboard, labeled: ["Add Widget"]),
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

        return try requireHittable(
            in: widgets,
            springboard: springboard,
            stage: "placed-weather-widget",
            timeout: 45
        )
    }

    // add and tap a real hosted widget
    func testPlacedWidgetOpensForecast() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["WEATHER_RUN_WIDGET_HOST_TEST"] == "1",
            "actual WidgetKit host capture runs only in the bounded host probe"
        )

        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test"]
        app.launch()
        // require the containing app before host interaction
        guard app.webViews["weather.webview"].waitForExistence(timeout: 15) else {
            attachState(app, name: "failure-containing-app-launch")
            XCTFail("containing app did not expose its WebKit surface")
            return
        }

        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        // require SpringBoard before gallery interaction
        guard springboard.wait(for: .runningForeground, timeout: 10) else {
            attachState(springboard, name: "failure-springboard-launch")
            XCTFail("SpringBoard did not become foreground")
            return
        }

        let widget = try addMaximumWidget(on: springboard)
        attachState(springboard, name: "actual-widgetkit-home-screen")
        XCTAssertTrue(widget.isHittable)
        XCTAssertTrue(widget.label.contains("Sunset"))
        XCTAssertTrue(widget.label.contains("adjusted air temperature"))
        XCTAssertTrue(widget.label.contains("CC BY 4.0"))
        XCTAssertTrue(widget.label.contains("daylight"))
        XCTAssertTrue(widget.label.contains("standard"))
        XCTAssertGreaterThan(widget.frame.width, widget.frame.height * 1.5)
        XCTAssertGreaterThan(widget.frame.width, 250)
        XCTAssertGreaterThan(widget.frame.height, 100)

        let geometryAttachment = XCTAttachment(string: "widget-frame-points=\(widget.frame)")
        geometryAttachment.name = "actual-widgetkit-bounds"
        geometryAttachment.lifetime = .keepAlways
        add(geometryAttachment)

        widget.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        XCTAssertTrue(app.webViews["weather.webview"].staticTexts["Weather route /forecast"].waitForExistence(timeout: 10))

        let tapAttachment = XCTAttachment(screenshot: app.screenshot())
        tapAttachment.name = "widget-tap-forecast-route"
        tapAttachment.lifetime = .keepAlways
        add(tapAttachment)
    }
}
