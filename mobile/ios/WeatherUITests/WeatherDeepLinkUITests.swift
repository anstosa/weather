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
    private enum MatrixScenario: String {
        case maximumDensity
        case nearCutoff
        case bedtime

        // expose the Debug AppIntent choice
        var optionLabel: String {
            // map every selectable fixture
            switch self {
            case .maximumDensity:
                return "Maximum density M0"
            case .nearCutoff:
                return "Near cutoff M0"
            case .bedtime:
                return "Bedtime M0"
            }
        }

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
            }
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

    // add the real WidgetKit surface through public SpringBoard controls
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

        let mediumConversion = springboard.buttons.matching(
            NSPredicate(format: "label ==[c] %@", "Medium-sized widget")
        )
        // prefer the evidenced direct medium conversion
        if let directConversion = firstHittable(in: mediumConversion, timeout: 3) {
            attachState(springboard, name: "home-screen-medium-conversion-before")
            directConversion.tap()

            // accept only the actual hosted widget postcondition
            if let convertedWidget = firstHittable(in: widgets, timeout: 45) {
                attachState(springboard, name: "home-screen-medium-conversion-after")
                return convertedWidget
            }

            // retry only when the exact action proves the first tap was ignored
            if let retryConversion = firstHittable(in: mediumConversion, timeout: 2) {
                attachState(springboard, name: "home-screen-medium-conversion-retry")
                retryConversion.tap()
                let convertedWidget = try requireHittable(
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

        return try requireHittable(
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
        var widget = firstHittable(in: widgets, timeout: timeout)
        // inspect the bounded Home Screen pages
        for _ in 0..<4 where widget == nil {
            springboard.swipeLeft()
            widget = firstHittable(in: widgets, timeout: 2)
        }
        // return the witnessed hosted control
        if let widget {
            return widget
        }
        return try requireHittable(
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
        return (app, springboard)
    }

    // select a DEBUG-only fixture through the real Edit Widget surface
    private func configureWidget(
        _ widget: XCUIElement,
        to targetScenario: MatrixScenario,
        on springboard: XCUIApplication
    ) throws -> XCUIElement {
        widget.press(forDuration: 1.5)
        attachState(springboard, name: "matrix-\(targetScenario.rawValue)-edit-widget-context")

        let editWidget = try requireHittable(
            in: springboard.buttons.matching(
                NSPredicate(format: "label ==[c] %@ OR identifier == %@", "Edit Widget", "Edit Widget")
            ),
            springboard: springboard,
            stage: "matrix-\(targetScenario.rawValue)-edit-widget"
        )
        editWidget.tap()
        attachState(springboard, name: "matrix-\(targetScenario.rawValue)-configuration")

        let fixtureRow = try requireHittable(
            in: springboard.descendants(matching: .any).matching(
                NSPredicate(
                    format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@",
                    "M0 fixture",
                    "M0 fixture"
                )
            ),
            springboard: springboard,
            stage: "matrix-\(targetScenario.rawValue)-fixture-row"
        )
        fixtureRow.tap()
        attachState(springboard, name: "matrix-\(targetScenario.rawValue)-fixture-options")

        let fixtureOption = try requireHittable(
            in: elements(in: springboard, labeled: [targetScenario.optionLabel]),
            springboard: springboard,
            stage: "matrix-\(targetScenario.rawValue)-fixture-option"
        )
        fixtureOption.tap()
        XCUIDevice.shared.press(.home)
        _ = springboard.wait(for: .runningForeground, timeout: 10)

        let configuredWidget = try findWidget(
            on: springboard,
            scenario: targetScenario,
            timeout: 45
        )
        attachState(springboard, name: "matrix-\(targetScenario.rawValue)-configured")
        return configuredWidget
    }

    // choose genuine Home Screen tinted rendering
    private func selectTintedAppearance(
        for widget: XCUIElement,
        on springboard: XCUIApplication
    ) throws -> XCUIElement {
        widget.press(forDuration: 1.5)
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

    // locate the actual fixed Home Screen host frame
    private func systemMediumHostFrame(on springboard: XCUIApplication) throws -> CGRect {
        let candidates = springboard.otherElements.matching(
            NSPredicate(format: "label ==[c] %@", "Weather")
        )
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

    // capture semantics, geometry, and the fixed primary tap
    private func captureAndTap(
        _ widget: XCUIElement,
        scenario: MatrixScenario,
        caseID: String,
        app: XCUIApplication,
        springboard: XCUIApplication
    ) throws {
        attachState(springboard, name: "matrix-\(caseID)-home-screen")
        XCTAssertTrue(widget.isHittable)
        XCTAssertTrue(widget.label.contains("Sunset"))
        // require weather-only content and credit
        if scenario != .bedtime {
            XCTAssertTrue(widget.label.contains("adjusted air temperature"))
            XCTAssertTrue(widget.label.contains("CC BY 4.0"))
        } else {
            XCTAssertFalse(widget.label.contains("Open-Meteo"))
        }
        // require exact cutoff copy
        if scenario != .maximumDensity {
            XCTAssertTrue(widget.label.contains("go to bed"))
        }
        let outerHostFrame = try systemMediumHostFrame(on: springboard)
        let semanticContentFrame = widget.frame
        let expandedHostFrame = outerHostFrame.insetBy(dx: -1, dy: -1)
        XCTAssertGreaterThan(outerHostFrame.width, outerHostFrame.height * 1.5)
        XCTAssertGreaterThan(outerHostFrame.width, 250)
        XCTAssertGreaterThan(outerHostFrame.height, 100)
        XCTAssertTrue(
            expandedHostFrame.contains(semanticContentFrame),
            "semantic content escaped the actual systemMedium host bounds"
        )

        // record outer and inner geometry separately
        let geometryDescription = """
        case=\(caseID)
        scenario=\(scenario.rawValue)
        system-medium-outer-frame-points=\(outerHostFrame)
        semantic-content-frame-points=\(semanticContentFrame)
        semantic-content-contained=\(expandedHostFrame.contains(semanticContentFrame))
        """
        let geometryAttachment = XCTAttachment(string: geometryDescription)
        geometryAttachment.name = "matrix-\(caseID)-widgetkit-bounds"
        geometryAttachment.lifetime = .keepAlways
        add(geometryAttachment)

        widget.tap()
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
        let widget = try addMaximumWidget(on: host.springboard)
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

    // configure and capture the near-cutoff actual widget
    func test04NearCutoffLightLarge() throws {
        let host = try launchHost()
        let maximum = try findWidget(on: host.springboard, scenario: .maximumDensity)
        let widget = try configureWidget(
            maximum,
            to: .nearCutoff,
            on: host.springboard
        )
        try captureAndTap(
            widget,
            scenario: .nearCutoff,
            caseID: "04-near-cutoff-light-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // configure and capture the bedtime actual widget
    func test05BedtimeLightLarge() throws {
        let host = try launchHost()
        let nearCutoff = try findWidget(on: host.springboard, scenario: .nearCutoff)
        let widget = try configureWidget(
            nearCutoff,
            to: .bedtime,
            on: host.springboard
        )
        try captureAndTap(
            widget,
            scenario: .bedtime,
            caseID: "05-bedtime-light-large",
            app: host.app,
            springboard: host.springboard
        )
    }

    // restore maximum density and capture genuine tinting
    func test06MaximumTintedLarge() throws {
        let host = try launchHost()
        let bedtime = try findWidget(on: host.springboard, scenario: .bedtime)
        let maximum = try configureWidget(
            bedtime,
            to: .maximumDensity,
            on: host.springboard
        )
        let widget = try selectTintedAppearance(for: maximum, on: host.springboard)
        try captureAndTap(
            widget,
            scenario: .maximumDensity,
            caseID: "06-maximum-tinted-large",
            app: host.app,
            springboard: host.springboard
        )
    }
}
