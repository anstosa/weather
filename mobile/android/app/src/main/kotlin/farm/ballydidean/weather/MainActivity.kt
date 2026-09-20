package farm.ballydidean.weather

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.window.OnBackInvokedDispatcher
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var canonicalOrigin: Uri

    // configure the hosted shell
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        canonicalOrigin = Uri.parse(getString(R.string.canonical_weather_origin))
        webView = WebView(this)
        configureWebView(webView)
        setContentView(webView)
        webView.loadUrl(startUrl(intent))
        // register predictive back on modern android
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                ::navigateBack,
            )
        }
    }

    // preserve in-site browser history
    @Deprecated("legacy fallback below api 33")
    @Suppress("DEPRECATION")
    @SuppressLint("GestureBackNavigation")
    override fun onBackPressed() {
        navigateBack()
    }

    // preserve in-site browser history
    private fun navigateBack() {
        // return within the hosted app
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        finishAfterTransition()
    }

    // release native browser resources
    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    // apply the production web boundary
    private fun configureWebView(view: WebView) {
        view.settings.javaScriptEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.setSupportMultipleWindows(false)
        view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = object : WebViewClient() {
            // route modern navigation
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
                return handleNavigation(request.url)
            }

            // route legacy navigation
            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String): Boolean {
                return handleNavigation(Uri.parse(url))
            }

            // retain ordinary certificate validation
            override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
                handler.cancel()
            }
        }
    }

    // resolve the fixed internal route
    private fun startUrl(intent: Intent?): String {
        val route = intent?.getStringExtra(EXTRA_ROUTE)
        // accept the enum-like forecast route only
        if (route == ROUTE_FORECAST) {
            return canonicalOrigin.buildUpon().path("/forecast").build().toString()
        }
        return canonicalOrigin.toString()
    }

    // enforce the exact hosted origin
    private fun handleNavigation(uri: Uri): Boolean {
        // keep exact-origin links in the web view
        if (isCanonicalWeatherUri(uri)) {
            return false
        }
        // send other safe web links outside the app
        if (isSafeExternalUri(uri)) {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (_: ActivityNotFoundException) {
                // reject when no browser exists
            }
        }
        return true
    }

    // match scheme host credentials and port
    private fun isCanonicalWeatherUri(uri: Uri): Boolean {
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(canonicalOrigin.host, ignoreCase = true) &&
            uri.userInfo == null &&
            (uri.port == -1 || uri.port == 443)
    }

    // allow credential-free external https only
    private fun isSafeExternalUri(uri: Uri): Boolean {
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host != null &&
            uri.userInfo == null &&
            (uri.port == -1 || uri.port == 443)
    }

    companion object {
        const val EXTRA_ROUTE = "route"
        const val ROUTE_FORECAST = "forecast"
    }
}
