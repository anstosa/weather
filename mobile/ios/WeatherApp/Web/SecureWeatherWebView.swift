import os
import SwiftUI
import UIKit
import WebKit

@MainActor
final class WeatherWebViewModel: ObservableObject {
    @Published private(set) var canGoBack = false
    @Published private(set) var cookieDiagnostic: String?
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

    #if DEBUG
    // expose only the deterministic persistent-cookie receipt
    func setCookieDiagnostic(_ value: String) {
        cookieDiagnostic = value
    }
    #endif
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
        #if DEBUG
        // exercise the same persistent store without production traffic
        configureDeterministicCookie(in: configuration.websiteDataStore.httpCookieStore)
        // expose the retry journey only to the deterministic UI test
        if ProcessInfo.processInfo.arguments.contains("-weather-ui-test-error") {
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(750))
                model.didFail()
            }
        }
        #endif
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
        Coordinator(
            allowsDeterministicTestDocument: usesDeterministicTestDocument,
            model: model
        )
    }

    #if DEBUG
    // set or read a production-shaped secure HttpOnly test cookie
    private func configureDeterministicCookie(in store: WKHTTPCookieStore) {
        let arguments = ProcessInfo.processInfo.arguments
        let shouldSet = arguments.contains("-weather-ui-test-cookie-set")
        let shouldRead = arguments.contains("-weather-ui-test-cookie-read") || shouldSet
        // skip ordinary UI-test launches
        guard shouldRead else {
            return
        }
        let inspect = {
            store.getAllCookies { cookies in
                let cookie = cookies.first { candidate in
                    candidate.name == "weather_admin_session" &&
                        candidate.domain == "weather.ballydidean.farm" &&
                        candidate.path == "/" &&
                        candidate.isSecure &&
                        candidate.isHTTPOnly
                }
                Task { @MainActor in
                    model.setCookieDiagnostic(cookie == nil ? "cookie-missing" : "cookie-persisted")
                }
            }
        }
        // read without rewriting after app restart
        guard shouldSet else {
            inspect()
            return
        }
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: "weather_admin_session",
            .value: "deterministic-ui-test",
            .domain: "weather.ballydidean.farm",
            .path: "/",
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(60 * 60),
            HTTPCookiePropertyKey(rawValue: "HttpOnly"): "TRUE"
        ]
        // reject an invalid synthetic cookie rather than weakening attributes
        guard let cookie = HTTPCookie(properties: properties) else {
            model.setCookieDiagnostic("cookie-invalid")
            return
        }
        store.setCookie(cookie, completionHandler: inspect)
    }

    // expose a deterministic route marker
    private static func testDocument(for route: WeatherRoute) -> String {
        let marker = route == .forecast ? "/forecast" : "/"
        return """
        <!doctype html>
        <html lang="en"><head><meta name="viewport" content="width=device-width"></head>
        <body>
          <main>Weather route \(marker)</main>
          <a href="about:blank#history">History fixture</a>
          <a href="about:blank#popup" target="_blank">Popup fixture</a>
        </body></html>
        """
    }
    #endif

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastRequestedRoute: WeatherRoute?
        private let allowsDeterministicTestDocument: Bool
        private let model: WeatherWebViewModel
        #if DEBUG
        private let diagnosticLogger = Logger(
            subsystem: "farm.ballydidean.weather",
            category: "webview"
        )
        #endif

        // retain the debug-only document decision
        init(
            allowsDeterministicTestDocument: Bool,
            model: WeatherWebViewModel
        ) {
            self.allowsDeterministicTestDocument = allowsDeterministicTestDocument
            self.model = model
        }

        // record successful document completion
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.didFinish()
            #if DEBUG
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

            switch WeatherNavigationPolicy.decision(for: url) {
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

            switch WeatherNavigationPolicy.decision(for: url) {
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
