import os
import SwiftUI
import UIKit
import WebKit

struct SecureWeatherWebView: UIViewRepresentable {
    let route: WeatherRoute
    let usesDeterministicTestDocument: Bool
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
        Coordinator(allowsDeterministicTestDocument: usesDeterministicTestDocument)
    }

    #if DEBUG
    // expose a deterministic route marker
    private static func testDocument(for route: WeatherRoute) -> String {
        let marker = route == .forecast ? "/forecast" : "/"
        return """
        <!doctype html>
        <html lang="en"><head><meta name="viewport" content="width=device-width"></head>
        <body><main>Weather route \(marker)</main></body></html>
        """
    }
    #endif

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastRequestedRoute: WeatherRoute?
        private let allowsDeterministicTestDocument: Bool
        #if DEBUG
        private let diagnosticLogger = Logger(
            subsystem: "farm.ballydidean.weather",
            category: "webview"
        )
        #endif

        // retain the debug-only document decision
        init(allowsDeterministicTestDocument: Bool) {
            self.allowsDeterministicTestDocument = allowsDeterministicTestDocument
        }

        #if DEBUG
        // record successful document completion
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            diagnosticLogger.notice(
                "m0-webview-lifecycle did-finish path=\(webView.url?.path ?? "nil", privacy: .public)"
            )
        }

        // record committed navigation failures
        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            let failure = error as NSError
            diagnosticLogger.notice(
                "m0-webview-lifecycle did-fail domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
            )
        }

        // record provisional navigation failures
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            let failure = error as NSError
            diagnosticLogger.notice(
                "m0-webview-lifecycle provisional-fail domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)"
            )
        }

        // record WebKit process loss
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            diagnosticLogger.notice("m0-webview-lifecycle content-process-terminated")
        }
        #endif

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
            if allowsDeterministicTestDocument && url.absoluteString == "about:blank" {
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
