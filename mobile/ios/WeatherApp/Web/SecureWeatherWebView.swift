import SwiftUI
import UIKit
import WebKit

struct SecureWeatherWebView: UIViewRepresentable {
    let route: WeatherRoute
    let usesDeterministicTestDocument: Bool

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
        guard context.coordinator.lastRequestedRoute != route else {
            return
        }
        context.coordinator.lastRequestedRoute = route

        #if DEBUG
        // avoid production traffic during UI tests
        if usesDeterministicTestDocument {
            webView.loadHTMLString(Self.testDocument(for: route), baseURL: nil)
            return
        }
        #endif

        webView.load(URLRequest(url: route.url))
    }

    // install the navigation delegate
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    #if DEBUG
    // expose a deterministic route marker
    private static func testDocument(for route: WeatherRoute) -> String {
        let marker = route == .forecast ? "/forecast" : "/"
        return """
        <!doctype html>
        <html lang="en"><head><meta name="viewport" content="width=device-width"></head>
        <body><main aria-label="Weather route \(marker)">\(marker)</main></body></html>
        """
    }
    #endif

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var lastRequestedRoute: WeatherRoute?

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
