package farm.ballydidean.weather.debug

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView
import farm.ballydidean.weather.widget.WeatherWidgetProvider

class FixtureHostActivity : Activity() {
    private lateinit var widgetHost: AppWidgetHost
    private lateinit var activeOptions: Bundle
    private lateinit var activeVariant: FixtureVariant
    private var allocatedWidgetId: Int? = null
    private var activeLandscape = false
    private var acceptsHostUpdates = true
    var renderedHostView: AppWidgetHostView? = null
        private set
    var fixtureRestorationCount = 0
        private set

    // bind the real provider into a test-only host
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val (widthDp, heightDp) = requestedBounds()
        val variant = FixtureVariant.fromWireName(intent.getStringExtra(EXTRA_VARIANT))
        activeOptions = widgetOptions(widthDp, heightDp)
        activeVariant = variant
        activeLandscape = heightDp == LANDSCAPE_HEIGHT_DP
        widgetHost = FixtureAppWidgetHost(this, HOST_ID, ::restoreFixtureAfterProviderUpdate)
        widgetHost.startListening()
        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(238, 238, 238))
        }
        setContentView(root)
        bindWidget(root, widthDp, heightDp, variant)
    }

    // release the short-lived host allocation
    override fun onDestroy() {
        acceptsHostUpdates = false
        widgetHost.stopListening()
        allocatedWidgetId?.let(widgetHost::deleteAppWidgetId)
        super.onDestroy()
    }

    // resize one bound host instance through real options
    fun resizeWidget(widthDp: Int, heightDp: Int, variant: FixtureVariant) {
        val appWidgetId = checkNotNull(allocatedWidgetId)
        val hostView = checkNotNull(renderedHostView)
        val options = widgetOptions(widthDp, heightDp)
        activeOptions = options
        activeVariant = variant
        activeLandscape = heightDp == LANDSCAPE_HEIGHT_DP
        val density = resources.displayMetrics.density
        hostView.layoutParams = (hostView.layoutParams as FrameLayout.LayoutParams).apply {
            width = (widthDp * density).toInt()
            height = (heightDp * density).toInt()
        }
        AppWidgetManager.getInstance(this).updateAppWidgetOptions(appWidgetId, options)
        hostView.updateAppWidgetSize(options, widthDp, heightDp, widthDp, heightDp)
        applyFixture(appWidgetId, options, variant)
    }

    // replay the real provider broadcast for lifecycle regression coverage
    fun requestProviderUpdate() {
        val appWidgetId = checkNotNull(allocatedWidgetId)
        val provider = ComponentName(this, WeatherWidgetProvider::class.java)
        sendBroadcast(
            Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                .setComponent(provider)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(appWidgetId)),
        )
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
        // surface missing shell-granted bind authority
        if (!manager.bindAppWidgetIdIfAllowed(appWidgetId, provider, activeOptions)) {
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
        applyFixture(appWidgetId, activeOptions, variant)
    }

    // restore the selected fixture after any late provider remoteviews
    private fun restoreFixtureAfterProviderUpdate(hostView: AppWidgetHostView) {
        // ignore teardown and already-correct fixture deliveries
        if (!acceptsHostUpdates || matchesFixture(hostView, activeVariant, activeLandscape)) {
            return
        }
        val appWidgetId = allocatedWidgetId ?: return
        fixtureRestorationCount += 1
        applyFixture(appWidgetId, activeOptions, activeVariant)
    }

    // apply deterministic content through the production renderer
    private fun applyFixture(appWidgetId: Int, options: Bundle, variant: FixtureVariant) {
        WeatherWidgetProvider.updateWidget(
            this,
            AppWidgetManager.getInstance(this),
            appWidgetId,
            options,
            DebugWidgetFixtures.fixture(variant).presentation,
        )
    }

    // build exact appwidget option bounds
    private fun widgetOptions(widthDp: Int, heightDp: Int): Bundle {
        return Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, widthDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, widthDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, heightDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, heightDp)
            putInt(AppWidgetManager.OPTION_APPWIDGET_HOST_CATEGORY, AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN)
        }
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

        // identify the selected fixture after production remoteviews inflation
        internal fun matchesFixture(view: View, variant: FixtureVariant, landscape: Boolean): Boolean {
            val text = buildList { collectText(view, this) }.joinToString(" ")
            return when (variant) {
                FixtureVariant.MAXIMUM -> text.contains(if (landscape) "12·1ᵃᵇ 38–41" else "12·1a·1b")
                FixtureVariant.NEAR_CUTOFF -> text.contains(if (landscape) "6–8 48–51" else "6–8p")
                FixtureVariant.ALL_BEDTIME -> text.contains("go to bed")
                FixtureVariant.STALE -> text.contains("stale")
                FixtureVariant.RAW_MIXED -> text.contains("mix")
                FixtureVariant.RAW -> text.contains("raw")
                FixtureVariant.UNAVAILABLE -> text.contains("refresh needed") && text.contains("unavailable")
                FixtureVariant.CELSIUS -> text.contains("°C")
            }
        }

        // collect every inflated remoteviews text value
        private fun collectText(view: View, destination: MutableList<String>) {
            // retain text nodes including hidden semantic placeholders
            if (view is TextView) {
                destination += view.text.toString()
            }
            // visit the complete remoteviews hierarchy
            if (view is ViewGroup) {
                for (index in 0 until view.childCount) {
                    collectText(view.getChildAt(index), destination)
                }
            }
        }
    }
}

private class FixtureAppWidgetHost(
    context: Context,
    hostId: Int,
    private val onRemoteViewsUpdated: (AppWidgetHostView) -> Unit,
) : AppWidgetHost(context, hostId) {
    // create an observing real host view
    override fun onCreateView(
        context: Context,
        appWidgetId: Int,
        appWidget: AppWidgetProviderInfo,
    ): AppWidgetHostView {
        return FixtureAppWidgetHostView(context, onRemoteViewsUpdated)
    }
}

private class FixtureAppWidgetHostView(
    context: Context,
    private val onRemoteViewsUpdated: (AppWidgetHostView) -> Unit,
) : AppWidgetHostView(context) {
    // report each fully applied provider update
    override fun updateAppWidget(remoteViews: RemoteViews?) {
        super.updateAppWidget(remoteViews)
        onRemoteViewsUpdated(this)
    }
}
