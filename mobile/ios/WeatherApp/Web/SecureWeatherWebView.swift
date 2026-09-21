import os
import SwiftUI
import UIKit
import WebKit

@MainActor
final class WeatherWebViewModel: ObservableObject {
    @Published private(set) var canGoBack = false
    @Published private(set) var failureMessage: String?
    private weak var webView: WKWebView?

    // retain only the native WebKit surface
    func attach(_ webView: WKWebView) {
        self.webView = webView
        canGoBack = webView.canGoBack
    }

    // navigate only within WebKit's accepted history
    func goBack() {
        // refuse a synthetic route when no accepted history exists
        guard webView?.canGoBack == true else {
            return
        }
        webView?.goBack()
    }

    // retry only the last policy-approved request
    func retry() {
        failureMessage = nil
        webView?.reload()
    }

    // clear errors after a committed successful document
    func didFinish() {
        failureMessage = nil
        canGoBack = webView?.canGoBack == true
    }

    // expose a bounded native error state
    func didFail() {
        failureMessage = "Weather could not load."
        canGoBack = webView?.canGoBack == true
    }

}

struct SecureWeatherWebView: UIViewRepresentable {
    let route: WeatherRoute
    let usesDeterministicTestDocument: Bool
    @ObservedObject var model: WeatherWebViewModel
    #if DEBUG
    // emit only bounded lifecycle receipts
    private static let diagnosticLogger = Logger(
        subsystem: "farm.ballydidean.weather",
        category: "webview"
    )
    private var httpsFixtureRequested: Bool {
        WeatherHTTPSFixtureConfiguration.isRequested(
            arguments: ProcessInfo.processInfo.arguments
        )
    }
    private var httpsFixture: WeatherHTTPSFixtureConfiguration? {
        WeatherHTTPSFixtureConfiguration.load()
    }
    #endif

    // create persistent hosted browsing
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.accessibilityIdentifier = "weather.webview"
        model.attach(webView)
        return webView
    }

    // load only explicit route changes
    func updateUIView(_ webView: WKWebView, context: Context) {
        #if DEBUG
        let routeLabel = route == .forecast ? "forecast" : "home"
        // describe the previous representable state
        let previousRouteLabel = context.coordinator.lastRequestedRoute.map {
            $0 == .forecast ? "forecast" : "home"
        } ?? "none"
        Self.diagnosticLogger.notice(
            "m0-webview-lifecycle update route=\(routeLabel, privacy: .public) previous=\(previousRouteLabel, privacy: .public) deterministic=\(usesDeterministicTestDocument, privacy: .public)"
        )
        #endif
        guard context.coordinator.lastRequestedRoute != route else {
            #if DEBUG
            Self.diagnosticLogger.notice("m0-webview-lifecycle update-skipped-same-route")
            #endif
            return
        }
        context.coordinator.lastRequestedRoute = route

        #if DEBUG
        // use only the validated real HTTPS fixture when explicitly requested
        if httpsFixtureRequested {
            guard let httpsFixture else {
                model.didFail()
                Self.diagnosticLogger.error("https-fixture-invalid")
                return
            }
            let url = route == .forecast ? httpsFixture.forecastURL : httpsFixture.startURL
            Self.diagnosticLogger.notice(
                "https-fixture-load path=\(url.path, privacy: .public)"
            )
            webView.load(URLRequest(url: url))
            return
        }
        // avoid production traffic during UI tests
        if usesDeterministicTestDocument {
            Self.diagnosticLogger.notice(
                "m0-webview-lifecycle inline-load-request route=\(routeLabel, privacy: .public)"
            )
            webView.loadHTMLString(Self.testDocument(for: route), baseURL: nil)
            return
        }
        #endif

        webView.load(URLRequest(url: route.url))
    }

    // install the navigation delegate
    func makeCoordinator() -> Coordinator {
        #if DEBUG
        Coordinator(
            allowsDeterministicTestDocument: usesDeterministicTestDocument,
            httpsFixture: httpsFixture,
            injectsDeterministicFailure: ProcessInfo.processInfo.arguments.contains(
                "-weather-ui-test-error"
            ),
            model: model
        )
        #else
        Coordinator(
            allowsDeterministicTestDocument: usesDeterministicTestDocument,
            model: model
        )
        #endif
    }

    #if DEBUG
    // expose a deterministic route marker
    private static func testDocument(for route: WeatherRoute) -> String {
        let marker = route == .forecast ? "/forecast" : "/"
        return """
        <!doctype html>
        <html lang="en"><head><meta name="viewport" content="width=device-width"></head>
        <body>
          <main>Weather route \(marker)</main>
          <a href="about:blank?history">History fixture</a>
          <a href="about:blank?popup" target="_blank">Popup fixture</a>
        </body></html>
        """
    }
    #endif

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastRequestedRoute: WeatherRoute?
        private let allowsDeterministicTestDocument: Bool
        #if DEBUG
        private let httpsFixture: WeatherHTTPSFixtureConfiguration?
        private var pendingDeterministicFailure: Bool
        #endif
        private let model: WeatherWebViewModel
        #if DEBUG
        private let diagnosticLogger = Logger(
            subsystem: "farm.ballydidean.weather",
            category: "webview"
        )
        #endif

        #if DEBUG
        // retain the debug-only fixture decision
        init(
            allowsDeterministicTestDocument: Bool,
            httpsFixture: WeatherHTTPSFixtureConfiguration?,
            injectsDeterministicFailure: Bool,
            model: WeatherWebViewModel
        ) {
            self.allowsDeterministicTestDocument = allowsDeterministicTestDocument
            self.httpsFixture = httpsFixture
            self.pendingDeterministicFailure = injectsDeterministicFailure
            self.model = model
        }
        #else
        // retain only the production document decision
        init(
            allowsDeterministicTestDocument: Bool,
            model: WeatherWebViewModel
        ) {
            self.allowsDeterministicTestDocument = allowsDeterministicTestDocument
            self.model = model
        }
        #endif

        // record successful document completion
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.didFinish()
            #if DEBUG
            // inject one failure only after the initial document commits
            if pendingDeterministicFailure {
                pendingDeterministicFailure = false
                model.didFail()
            }
            diagnosticLogger.notice(
                "m0-webview-lifecycle did-finish path=\(webView.url?.path ?? "nil", privacy: .public)"
            )
            #endif
        }

        // record committed navigation failures
        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            // ignore cancellation caused by a deliberate policy handoff
            if (error as? URLError)?.code == .cancelled {
                return
            }
            model.didFail()
            #if DEBUG
            let failure = error as NSError
            diagnosticLogger.notice(
                "m0-webview-lifecycle did-fail domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
            )
            #endif
        }

        // record provisional navigation failures
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            // ignore cancellation caused by a deliberate policy handoff
            if (error as? URLError)?.code == .cancelled {
                return
            }
            model.didFail()
            #if DEBUG
            let failure = error as NSError
            diagnosticLogger.notice(
                "m0-webview-lifecycle provisional-fail domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
            )
            #endif
        }

        // record WebKit process loss
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            model.didFail()
            #if DEBUG
            diagnosticLogger.notice("m0-webview-lifecycle content-process-terminated")
            #endif
        }

        // enforce the compiled navigation policy
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }

            #if DEBUG
            // allow only the inline UI-test document
            if allowsDeterministicTestDocument && url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            #endif

            let decision: WeatherNavigationDecision
            #if DEBUG
            // keep explicit HTTPS fixture navigation inside its two origins
            if let httpsFixture {
                decision = WeatherNavigationPolicy.decision(for: url, fixture: httpsFixture)
            } else {
                decision = WeatherNavigationPolicy.decision(for: url)
            }
            #else
            decision = WeatherNavigationPolicy.decision(for: url)
            #endif
            switch decision {
            case .hosted:
                // keep new hosted windows in the same view
                if navigationAction.targetFrame == nil {
                    webView.load(navigationAction.request)
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.allow)
            case .external(let externalURL):
                UIApplication.shared.open(externalURL, options: [:])
                decisionHandler(.cancel)
            case .rejected:
                decisionHandler(.cancel)
            }
        }

        // suppress untrusted popup web views
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard let url = navigationAction.request.url else {
                return nil
            }

            #if DEBUG
            // keep only the deterministic popup in the current test WebView
            if allowsDeterministicTestDocument && url.scheme == "about" {
                webView.load(navigationAction.request)
                return nil
            }
            #endif

            let decision: WeatherNavigationDecision
            #if DEBUG
            // keep explicit HTTPS fixture popups inside the current view
            if let httpsFixture {
                decision = WeatherNavigationPolicy.decision(for: url, fixture: httpsFixture)
            } else {
                decision = WeatherNavigationPolicy.decision(for: url)
            }
            #else
            decision = WeatherNavigationPolicy.decision(for: url)
            #endif
            switch decision {
            case .hosted:
                webView.load(navigationAction.request)
            case .external(let externalURL):
                UIApplication.shared.open(externalURL, options: [:])
            case .rejected:
                break
            }
            return nil
        }
    }
}
