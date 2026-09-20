import XCTest

@MainActor
final class WeatherDeepLinkUITests: XCTestCase {
    // open the same fixed route used by the widget
    func testForecastDeepLinkOpensContainingApp() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test"]
        app.launch()

        let webView = app.webViews["weather.webview"]
        XCTAssertTrue(webView.waitForExistence(timeout: 15))
        XCTAssertTrue(webView.staticTexts["Weather route /"].waitForExistence(timeout: 5))

        let forecastURL = try XCTUnwrap(URL(string: "ballydidean-weather://forecast"))
        app.open(forecastURL)

        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(webView.staticTexts["Weather route /forecast"].waitForExistence(timeout: 5))
    }
}

@MainActor
final class WidgetHostUITests: XCTestCase {
    // tap a widget already placed by xcdebug
    func testPlacedWidgetOpensForecast() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["WEATHER_RUN_WIDGET_HOST_TEST"] == "1",
            "actual WidgetKit host capture runs only after xcdebug placement"
        )

        let app = XCUIApplication()
        app.launchArguments = ["-weather-ui-test"]
        app.launch()
        XCTAssertTrue(app.webViews["weather.webview"].waitForExistence(timeout: 15))

        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10))

        let widgetPredicate = NSPredicate(
            format: "label CONTAINS[c] %@ AND label CONTAINS[c] %@",
            "Open-Meteo",
            "21 forecast intervals"
        )
        let widget = springboard.descendants(matching: .any).matching(widgetPredicate).firstMatch
        XCTAssertTrue(widget.waitForExistence(timeout: 30), springboard.debugDescription)
        XCTAssertTrue(widget.isHittable)
        XCTAssertTrue(widget.label.contains("Sunset"))
        XCTAssertTrue(widget.label.contains("adjusted air temperature"))
        XCTAssertTrue(widget.label.contains("CC BY 4.0"))
        XCTAssertTrue(widget.label.contains("daylight"))
        XCTAssertTrue(widget.label.contains("standard"))

        let homeAttachment = XCTAttachment(screenshot: springboard.screenshot())
        homeAttachment.name = "actual-widgetkit-home-screen"
        homeAttachment.lifetime = .keepAlways
        add(homeAttachment)

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
