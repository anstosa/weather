package farm.ballydidean.weather.debug

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import farm.ballydidean.weather.widget.FixtureVariant
import farm.ballydidean.weather.widget.WeatherWidgetProvider

class FixtureHostActivity : Activity() {
    private lateinit var widgetHost: AppWidgetHost
    private var allocatedWidgetId: Int? = null
    var renderedHostView: AppWidgetHostView? = null
        private set

    // bind the real provider into a test-only host
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val (widthDp, heightDp) = requestedBounds()
        val variant = FixtureVariant.fromWireName(intent.getStringExtra(EXTRA_VARIANT))
        widgetHost = AppWidgetHost(this, HOST_ID)
        widgetHost.startListening()
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(238, 238, 238))
        }
        setContentView(root)
        bindWidget(root, widthDp, heightDp, variant)
    }

    // release the short-lived host allocation
    override fun onDestroy() {
        widgetHost.stopListening()
        allocatedWidgetId?.let(widgetHost::deleteAppWidgetId)
        super.onDestroy()
    }

    // permit only approved M0 dimensions
    private fun requestedBounds(): Pair<Int, Int> {
        val requestedWidth = intent.getIntExtra(EXTRA_WIDTH_DP, PORTRAIT_WIDTH_DP)
        val requestedHeight = intent.getIntExtra(EXTRA_HEIGHT_DP, PORTRAIT_HEIGHT_DP)
        // select the official typical landscape minimum
        if (requestedWidth == LANDSCAPE_WIDTH_DP && requestedHeight == LANDSCAPE_HEIGHT_DP) {
            return LANDSCAPE_WIDTH_DP to LANDSCAPE_HEIGHT_DP
        }
        return PORTRAIT_WIDTH_DP to PORTRAIT_HEIGHT_DP
    }

    // perform the platform host binding flow
    private fun bindWidget(root: FrameLayout, widthDp: Int, heightDp: Int, variant: FixtureVariant) {
        val manager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, WeatherWidgetProvider::class.java)
        val appWidgetId = widgetHost.allocateAppWidgetId()
        allocatedWidgetId = appWidgetId
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, widthDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, widthDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, heightDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, heightDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY, AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN)
        }
        // surface missing shell-granted bind authority
        if (!manager.bindAppWidgetIdIfAllowed(appWidgetId, provider, options)) {
            root.addView(TextView(this).apply {
                text = "fixture host requires: cmd appwidget grantbind --package $packageName"
                setTextColor(Color.BLACK)
                textSize = 16f
                gravity = Gravity.CENTER
            }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            return
        }
        val providerInfo = manager.getAppWidgetInfo(appWidgetId)
        val hostView = widgetHost.createView(this, appWidgetId, providerInfo)
        renderedHostView = hostView
        val density = resources.displayMetrics.density
        val layoutParams = FrameLayout.LayoutParams((widthDp * density).toInt(), (heightDp * density).toInt()).apply {
            gravity = Gravity.CENTER
        }
        root.addView(hostView, layoutParams)
        // apply the fixture after bind-time provider callbacks settle
        hostView.postDelayed({
            WeatherWidgetProvider.updateWidget(this, manager, appWidgetId, options, variant)
        }, FIXTURE_UPDATE_DELAY_MS)
    }

    companion object {
        const val EXTRA_WIDTH_DP = "widthDp"
        const val EXTRA_HEIGHT_DP = "heightDp"
        const val EXTRA_VARIANT = "variant"
        const val PORTRAIT_WIDTH_DP = 276
        const val PORTRAIT_HEIGHT_DP = 102
        const val LANDSCAPE_WIDTH_DP = 554
        const val LANDSCAPE_HEIGHT_DP = 51
        private const val HOST_ID = 0x57454154
        private const val FIXTURE_UPDATE_DELAY_MS = 250L
    }
}
