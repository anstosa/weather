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

class WeatherWidgetProvider : AppWidgetProvider() {
    // render every active widget
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        // update each allocated host instance
        for (appWidgetId in appWidgetIds) {
            updateWidget(context, manager, appWidgetId)
        }
    }

    // rerender after launcher sizing changes
    override fun onAppWidgetOptionsChanged(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle
    ) {
        updateWidget(context, manager, appWidgetId, newOptions)
    }

    companion object {
        // update one provider instance from the deterministic M0 fixture
        fun updateWidget(
            context: Context,
            manager: AppWidgetManager,
            appWidgetId: Int,
            options: Bundle = manager.getAppWidgetOptions(appWidgetId),
            variant: FixtureVariant = FixtureVariant.MAXIMUM
        ) {
            manager.updateAppWidget(appWidgetId, WeatherWidgetRenderer.render(context, appWidgetId, options, variant))
        }

        // rerender all allocated instances for fixture evidence
        fun updateAll(context: Context, variant: FixtureVariant) {
            val manager = AppWidgetManager.getInstance(context)
            val provider = ComponentName(context, WeatherWidgetProvider::class.java)
            // update each allocated host instance
            for (appWidgetId in manager.getAppWidgetIds(provider)) {
                updateWidget(context, manager, appWidgetId, manager.getAppWidgetOptions(appWidgetId), variant)
            }
        }
    }
}

object WeatherWidgetRenderer {
    private const val LARGE_TEXT_FONT_SCALE = 1.3f
    private const val LANDSCAPE_MAX_HEIGHT_DP = 60
    private const val LANDSCAPE_MIN_WIDTH_DP = 500
    private const val PROVIDER_URL = "https://open-meteo.com/"
    private const val LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"

    // build the size-aware RemoteViews tree
    fun render(
        context: Context,
        appWidgetId: Int,
        options: Bundle?,
        variant: FixtureVariant
    ): RemoteViews {
        val landscapeMinimum = isLandscapeMinimum(options)
        val landscape = landscapeMinimum && (
            isExactLandscapeAllocation(options) ||
                context.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            )
        val largeText = context.resources.configuration.fontScale >= LARGE_TEXT_FONT_SCALE
        val fixture = WidgetFixture.forVariant(variant)
        val layout = when {
            landscape && largeText && fixture.groups.isEmpty() -> R.layout.widget_root_landscape_bedtime_large
            landscape && largeText -> R.layout.widget_root_landscape_large
            landscape -> R.layout.widget_root_landscape
            largeText -> R.layout.widget_root_portrait_large
            else -> R.layout.widget_root_portrait
        }
        val views = RemoteViews(context.packageName, layout)
        views.removeAllViews(R.id.row_primary)
        views.removeAllViews(R.id.row_secondary)
        populateForecast(context, views, fixture, landscape, largeText)
        populateFooter(context, views, fixture, appWidgetId)
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

    // add weather and bedtime coverage
    private fun populateForecast(
        context: Context,
        views: RemoteViews,
        fixture: WidgetFixture,
        landscape: Boolean,
        largeText: Boolean
    ) {
        // retain the compact single row at normal landscape scale
        if (landscape && (!largeText || fixture.groups.isEmpty())) {
            // add every remaining weather group
            for (group in fixture.groups) {
                views.addView(R.id.row_primary, slotView(context, group, landscape = true, largeText = false))
            }
            // fill post-cutoff room once
            if (fixture.showBedtime) {
                val weight = if (fixture.groups.isEmpty()) 1 else 6
                views.addView(R.id.row_primary, bedtimeView(context, weight))
            }
            return
        }

        val primaryGroups = fixture.groups.take(4)
        val secondaryGroups = fixture.groups.drop(4)
        // populate the first static row
        for (group in primaryGroups) {
            views.addView(R.id.row_primary, slotView(context, group, landscape, largeText))
        }
        // populate the second static row
        for (group in secondaryGroups) {
            views.addView(R.id.row_secondary, slotView(context, group, landscape, largeText))
        }
        // fill both post-cutoff rows
        if (fixture.showBedtime) {
            val firstWeight = if (primaryGroups.isEmpty()) 1 else 3
            views.addView(R.id.row_primary, bedtimeView(context, firstWeight))
            views.addView(R.id.row_secondary, bedtimeView(context, 1))
        }
        // move metadata into the spare second-row width at large scale
        if (largeText) {
            views.addView(R.id.row_secondary, footerView(context, landscape))
        }
    }

    // bind one forecast group
    private fun slotView(
        context: Context,
        group: FixtureGroup,
        landscape: Boolean,
        largeText: Boolean
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

    // select the static condition icon
    private fun conditionIcon(condition: RainCondition): Int {
        return when (condition) {
            RainCondition.DRY -> R.drawable.ic_dry
            RainCondition.SPRINKLE -> R.drawable.ic_sprinkle
            RainCondition.RAIN -> R.drawable.ic_rain
        }
    }

    // fill the remaining fixed widget footprint
    private fun bedtimeView(context: Context, weight: Int): RemoteViews {
        val layout = when (weight) {
            3 -> R.layout.widget_bedtime_weight_3
            6 -> R.layout.widget_bedtime_weight_6
            else -> R.layout.widget_bedtime
        }
        return RemoteViews(context.packageName, layout).apply {
            setContentDescription(R.id.bedtime_root, context.getString(R.string.widget_bedtime))
        }
    }

    // protect large-scale status unit and credit width
    private fun footerView(context: Context, landscape: Boolean): RemoteViews {
        val layout = if (landscape) {
            R.layout.widget_footer_inline_landscape
        } else {
            R.layout.widget_footer_inline_portrait
        }
        return RemoteViews(context.packageName, layout)
    }

    // bind fixed footer and allowlisted credit actions
    private fun populateFooter(
        context: Context,
        views: RemoteViews,
        fixture: WidgetFixture,
        appWidgetId: Int
    ) {
        views.setTextViewText(R.id.footer_primary, fixture.footer)
        views.setContentDescription(R.id.footer_primary, fixture.footer)
        val creditVisibility = if (fixture.showCredit) View.VISIBLE else View.GONE
        views.setViewVisibility(R.id.credit_provider, creditVisibility)
        views.setViewVisibility(R.id.credit_separator, creditVisibility)
        views.setViewVisibility(R.id.credit_license, creditVisibility)
        // bind only compile-time credit destinations
        if (fixture.showCredit) {
            views.setOnClickPendingIntent(
                R.id.credit_provider,
                externalPendingIntent(context, appWidgetId + 10_000, PROVIDER_URL)
            )
            views.setOnClickPendingIntent(
                R.id.credit_license,
                externalPendingIntent(context, appWidgetId + 20_000, LICENSE_URL)
            )
            views.setContentDescription(R.id.credit_provider, "Weather data provider Open-Meteo")
            views.setContentDescription(R.id.credit_license, "Weather data licensed under CC BY 4.0")
        }
    }

    // open the enum-like in-app forecast route
    private fun forecastPendingIntent(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_ROUTE, MainActivity.ROUTE_FORECAST)
        }
        return PendingIntent.getActivity(
            context,
            appWidgetId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    // open one fixed safe external url
    private fun externalPendingIntent(context: Context, requestCode: Int, url: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
