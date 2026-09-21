package farm.ballydidean.weather.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import farm.ballydidean.weather.MainActivity
import farm.ballydidean.weather.R
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class WeatherWidgetProvider : AppWidgetProvider() {
    // render cache first and enqueue bounded work
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        // update every allocated host instance
        for (appWidgetId in appWidgetIds) {
            WidgetController.updateWidget(context, manager, appWidgetId, now = Instant.now())
        }
        WidgetWorkScheduler.ensure(context)
    }

    // recompute after launcher sizing changes
    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        WidgetController.updateWidget(context, manager, appWidgetId, newOptions, Instant.now())
        WidgetWorkScheduler.ensure(context)
    }

    // establish refresh work for the first widget
    override fun onEnabled(context: Context) {
        WidgetController.updateAll(context, Instant.now())
        WidgetWorkScheduler.ensure(context)
    }

    // remove per-instance state and stop unused work
    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        // remove every deleted unit selection
        for (appWidgetId in appWidgetIds) {
            WidgetPreferences.remove(context, appWidgetId)
        }
        // retain work only while another instance exists
        if (WidgetWorkScheduler.hasWidgets(context)) {
            WidgetWorkScheduler.ensure(context)
        } else {
            WidgetWorkScheduler.cancel(context)
        }
    }

    // remove residual data after the final widget
    override fun onDisabled(context: Context) {
        WidgetWorkScheduler.cancel(context)
        WidgetStorage(context).clear()
    }

    // recompute after boot and package replacement
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // handle only trusted system lifecycle broadcasts here
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            WidgetController.updateAll(context, Instant.now())
            WidgetWorkScheduler.ensure(context)
        }
    }

    companion object {
        // expose a debug-host rendering seam without fixture data in release
        fun updateWidget(
            context: Context,
            manager: AppWidgetManager,
            appWidgetId: Int,
            options: Bundle,
            presentation: WidgetPresentation,
        ) {
            manager.updateAppWidget(
                appWidgetId,
                WeatherWidgetRenderer.render(context, appWidgetId, options, presentation),
            )
        }

        // expose the same seam for debug control broadcasts
        fun updateAll(context: Context, presentation: WidgetPresentation) {
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, WeatherWidgetProvider::class.java)
            // update every allocated host instance
            for (appWidgetId in manager.getAppWidgetIds(provider)) {
                updateWidget(context, manager, appWidgetId, manager.getAppWidgetOptions(appWidgetId), presentation)
            }
        }
    }
}

object WidgetController {
    // render one widget from independent persisted state
    fun updateWidget(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        options: Bundle = manager.getAppWidgetOptions(appWidgetId),
        now: Instant,
    ) {
        val unit = WidgetPreferences.unit(context, appWidgetId)
        val storage = WidgetStorage(context)
        val snapshot = storage.readSnapshot()
        val presentation = if (snapshot == null) {
            WidgetSemanticRenderer.unavailable(now, unit)
        } else {
            WidgetSemanticRenderer.render(snapshot, now, unit, runtimeAttempt(storage, snapshot, now))
        }
        manager.updateAppWidget(
            appWidgetId,
            WeatherWidgetRenderer.render(context, appWidgetId, options, presentation),
        )
    }

    // render every current provider instance
    fun updateAll(context: Context, now: Instant, attemptOverride: WidgetAttempt? = null) {
        val manager = AppWidgetManager.getInstance(context)
        val provider = ComponentName(context, WeatherWidgetProvider::class.java)
        // recompute each configured unit independently
        for (appWidgetId in manager.getAppWidgetIds(provider)) {
            val unit = WidgetPreferences.unit(context, appWidgetId)
            val storage = WidgetStorage(context)
            val snapshot = storage.readSnapshot()
            val presentation = if (snapshot == null) {
                WidgetSemanticRenderer.unavailable(now, unit)
            } else {
                WidgetSemanticRenderer.render(
                    snapshot,
                    now,
                    unit,
                    attemptOverride ?: runtimeAttempt(storage, snapshot, now),
                )
            }
            manager.updateAppWidget(
                appWidgetId,
                WeatherWidgetRenderer.render(context, appWidgetId, manager.getAppWidgetOptions(appWidgetId), presentation),
            )
        }
    }

    // fail missing or corrupt runtime metadata conservatively
    private fun runtimeAttempt(
        storage: WidgetStorage,
        snapshot: WidgetForecastSnapshot,
        now: Instant,
    ): WidgetAttempt {
        return storage.readAttempt() ?: WidgetAttempt(maxOf(snapshot.receivedAt, now), WidgetAttemptOutcome.INVALID)
    }
}

object WeatherWidgetRenderer {
    private const val LARGE_TEXT_FONT_SCALE = 1.3f
    private const val LANDSCAPE_MAX_HEIGHT_DP = 60
    private const val LANDSCAPE_MIN_WIDTH_DP = 500
    private const val PROVIDER_URL = "https://open-meteo.com/"
    private const val LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
    private val siteZone = ZoneId.of("America/Los_Angeles")
    private val timeFormatter = DateTimeFormatter.ofPattern("h:mm", Locale.US)

    // build the size-aware remoteviews tree
    fun render(
        context: Context,
        appWidgetId: Int,
        options: Bundle?,
        presentation: WidgetPresentation,
    ): RemoteViews {
        val landscapeMinimum = isLandscapeMinimum(options)
        val landscape = landscapeMinimum && (
            isExactLandscapeAllocation(options) ||
                context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            )
        val largeText = context.resources.configuration.fontScale >= LARGE_TEXT_FONT_SCALE
        val layout = when {
            landscape && largeText && presentation.groups.isEmpty() -> R.layout.widget_root_landscape_bedtime_large
            landscape && largeText -> R.layout.widget_root_landscape_large
            landscape -> R.layout.widget_root_landscape
            largeText -> R.layout.widget_root_portrait_large
            else -> R.layout.widget_root_portrait
        }
        val views = RemoteViews(context.packageName, layout)
        views.removeAllViews(R.id.row_primary)
        views.removeAllViews(R.id.row_secondary)
        populateForecast(context, views, presentation, landscape, largeText)
        populateFooter(context, views, presentation, appWidgetId)
        views.setContentDescription(R.id.widget_root, presentationAccessibility(presentation))
        views.setOnClickPendingIntent(R.id.widget_root, forecastPendingIntent(context, appWidgetId))
        return views
    }

    // infer the exact-layout orientation from host options
    internal fun isLandscapeMinimum(options: Bundle?): Boolean {
        val minimumHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, Int.MAX_VALUE)
            ?: Int.MAX_VALUE
        val maximumHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, Int.MAX_VALUE)
            ?: Int.MAX_VALUE
        val minimumWidth = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, Int.MIN_VALUE)
            ?: Int.MIN_VALUE
        val maximumWidth = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, Int.MIN_VALUE)
            ?: Int.MIN_VALUE
        return minOf(minimumHeight, maximumHeight) <= LANDSCAPE_MAX_HEIGHT_DP &&
            maxOf(minimumWidth, maximumWidth) >= LANDSCAPE_MIN_WIDTH_DP
    }

    // distinguish exact test bounds from launcher rotation ranges
    internal fun isExactLandscapeAllocation(options: Bundle?): Boolean {
        val minimumWidth = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, Int.MIN_VALUE)
            ?: Int.MIN_VALUE
        val maximumHeight = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, Int.MAX_VALUE)
            ?: Int.MAX_VALUE
        return minimumWidth >= LANDSCAPE_MIN_WIDTH_DP && maximumHeight <= LANDSCAPE_MAX_HEIGHT_DP
    }

    // add weather bedtime or unavailable coverage
    private fun populateForecast(
        context: Context,
        views: RemoteViews,
        presentation: WidgetPresentation,
        landscape: Boolean,
        largeText: Boolean,
    ) {
        // retain the compact single row at normal landscape scale
        if (landscape && (!largeText || presentation.groups.isEmpty())) {
            // add every remaining weather group
            for (group in presentation.groups) {
                views.addView(R.id.row_primary, slotView(context, group, landscape = true, largeText = false))
            }
            // fill spare or unavailable space once
            if (presentation.message != null) {
                val weight = if (presentation.groups.isEmpty()) 1 else 6
                views.addView(R.id.row_primary, messageView(context, weight, presentation.message))
            }
            return
        }

        val primaryGroups = presentation.groups.take(4)
        val secondaryGroups = presentation.groups.drop(4)
        // populate the first static row
        for (group in primaryGroups) {
            views.addView(R.id.row_primary, slotView(context, group, landscape, largeText))
        }
        // populate the second static row
        for (group in secondaryGroups) {
            views.addView(R.id.row_secondary, slotView(context, group, landscape, largeText))
        }
        // fill both spare rows when requested
        if (presentation.message != null) {
            val firstWeight = if (primaryGroups.isEmpty()) 1 else 3
            views.addView(R.id.row_primary, messageView(context, firstWeight, presentation.message))
            views.addView(R.id.row_secondary, messageView(context, 1, presentation.message))
        }
        // move metadata into spare second-row width at large scale
        if (largeText) {
            views.addView(R.id.row_secondary, footerView(context, landscape))
        }
    }

    // bind one forecast group
    private fun slotView(
        context: Context,
        group: WidgetGroup,
        landscape: Boolean,
        largeText: Boolean,
    ): RemoteViews {
        // use a one-line compact tile at the 51dp landscape minimum
        if (landscape) {
            return RemoteViews(context.packageName, R.layout.widget_slot_landscape).apply {
                setTextViewText(R.id.slot_summary, group.landscapeLabel)
                setImageViewResource(R.id.slot_condition, conditionIcon(group.condition))
                setContentDescription(R.id.slot_root, group.accessibilityLabel())
            }
        }
        val layout = if (largeText) R.layout.widget_slot_portrait_large else R.layout.widget_slot
        return RemoteViews(context.packageName, layout).apply {
            setTextViewText(R.id.slot_hour, group.hourLabel)
            setTextViewText(R.id.slot_temperature, group.temperatureLabel)
            setImageViewResource(R.id.slot_condition, conditionIcon(group.condition))
            setContentDescription(R.id.slot_root, group.accessibilityLabel())
        }
    }

    // select one truthful condition icon
    private fun conditionIcon(condition: RainCondition): Int {
        return when (condition) {
            RainCondition.DRY -> R.drawable.ic_dry
            RainCondition.SPRINKLE -> R.drawable.ic_sprinkle
            RainCondition.RAIN -> R.drawable.ic_rain
            RainCondition.UNAVAILABLE -> R.drawable.ic_unavailable
        }
    }

    // fill remaining fixed widget space
    private fun messageView(context: Context, weight: Int, message: String): RemoteViews {
        val layout = when (weight) {
            3 -> R.layout.widget_bedtime_weight_3
            6 -> R.layout.widget_bedtime_weight_6
            else -> R.layout.widget_bedtime
        }
        return RemoteViews(context.packageName, layout).apply {
            setTextViewText(R.id.bedtime_root, message)
            setContentDescription(R.id.bedtime_root, message)
        }
    }

    // protect large-scale status unit and credit width
    private fun footerView(context: Context, landscape: Boolean): RemoteViews {
        val layout = if (landscape) R.layout.widget_footer_inline_landscape else R.layout.widget_footer_inline_portrait
        return RemoteViews(context.packageName, layout)
    }

    // bind fixed footer and allowlisted credit actions
    private fun populateFooter(
        context: Context,
        views: RemoteViews,
        presentation: WidgetPresentation,
        appWidgetId: Int,
    ) {
        views.setTextViewText(R.id.footer_primary, presentation.footer)
        views.setContentDescription(R.id.footer_primary, footerAccessibility(presentation))
        val creditVisibility = if (presentation.showCredit) View.VISIBLE else View.GONE
        views.setViewVisibility(R.id.credit_provider, creditVisibility)
        views.setViewVisibility(R.id.credit_separator, creditVisibility)
        views.setViewVisibility(R.id.credit_license, creditVisibility)
        // bind only compile-time credit destinations
        if (presentation.showCredit) {
            views.setOnClickPendingIntent(
                R.id.credit_provider,
                externalPendingIntent(context, appWidgetId + 10_000, PROVIDER_URL),
            )
            views.setOnClickPendingIntent(
                R.id.credit_license,
                externalPendingIntent(context, appWidgetId + 20_000, LICENSE_URL),
            )
            views.setContentDescription(R.id.credit_provider, "Weather data provider Open-Meteo")
            views.setContentDescription(R.id.credit_license, "Weather data licensed under CC BY 4.0")
        }
    }

    // describe complete widget semantics including attribution
    private fun presentationAccessibility(presentation: WidgetPresentation): String {
        val groups = presentation.groups.joinToString("; ") { it.accessibilityLabel() }
        val attribution = if (presentation.showCredit) "; Open-Meteo, CC BY 4.0" else ""
        return listOfNotNull(groups.ifBlank { null }, presentation.message, footerAccessibility(presentation))
            .joinToString("; ") + attribution
    }

    // expand compact footer text for assistive technology
    private fun footerAccessibility(presentation: WidgetPresentation): String {
        val sunset = presentation.sunset?.atZone(siteZone)?.format(timeFormatter)?.let { "Sunset $it" }
        val freshness = if (presentation.stale) "stale" else "current"
        val unit = when (presentation.unit) {
            TemperatureUnit.FAHRENHEIT -> "degrees Fahrenheit"
            TemperatureUnit.CELSIUS -> "degrees Celsius"
        }
        return listOfNotNull(sunset, "${presentation.status.wireName()} forecast", freshness, unit).joinToString(", ")
    }

    // open the enum-like in-app forecast route
    private fun forecastPendingIntent(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_ROUTE, MainActivity.ROUTE_FORECAST)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(
            context,
            appWidgetId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    // open one fixed safe external url
    private fun externalPendingIntent(context: Context, requestCode: Int, url: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
