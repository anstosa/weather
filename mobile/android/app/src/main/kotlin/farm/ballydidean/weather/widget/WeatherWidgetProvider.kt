package farm.ballydidean.weather.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.util.SizeF
import android.util.TypedValue
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import farm.ballydidean.weather.MainActivity
import farm.ballydidean.weather.R
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

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
        val stored = storage.readStoredSnapshot()
        val views = WeatherWidgetRenderer.render(context, appWidgetId, options) { capacity ->
            // retain an honest empty state without a cached snapshot
            if (stored == null) {
                WidgetSemanticRenderer.unavailable(now, unit)
            } else {
                WidgetSemanticRenderer.render(stored.snapshot, now, unit, runtimeAttempt(storage, stored, now), capacity)
            }
        }
        manager.updateAppWidget(appWidgetId, views)
    }

    // render every current provider instance
    fun updateAll(context: Context, now: Instant, attemptOverride: WidgetAttempt? = null) {
        val manager = AppWidgetManager.getInstance(context)
        val provider = ComponentName(context, WeatherWidgetProvider::class.java)
        // recompute each configured unit independently
        for (appWidgetId in manager.getAppWidgetIds(provider)) {
            val unit = WidgetPreferences.unit(context, appWidgetId)
            val storage = WidgetStorage(context)
            val stored = storage.readStoredSnapshot()
            val views = WeatherWidgetRenderer.render(context, appWidgetId, manager.getAppWidgetOptions(appWidgetId)) { capacity ->
                // render each size without extending cache or correction lifetime
                if (stored == null) {
                    WidgetSemanticRenderer.unavailable(now, unit)
                } else {
                    WidgetSemanticRenderer.render(stored.snapshot, now, unit,
                        boundAttempt(attemptOverride ?: storage.readAttempt(), stored, now), capacity)
                }
            }
            manager.updateAppWidget(appWidgetId, views)
        }
    }

    // fail missing or corrupt runtime metadata conservatively
    private fun runtimeAttempt(
        storage: WidgetStorage,
        stored: StoredWidgetSnapshot,
        now: Instant,
    ): WidgetAttempt {
        return boundAttempt(storage.readAttempt(), stored, now)
    }

    // require success metadata to identify the exact cached bytes
    internal fun boundAttempt(
        attempt: WidgetAttempt?,
        stored: StoredWidgetSnapshot,
        now: Instant,
    ): WidgetAttempt {
        // fail missing or mismatched receipts conservatively
        if (attempt == null ||
            attempt.outcome == WidgetAttemptOutcome.SUCCESS && attempt.snapshotIdentity != stored.identity
        ) {
            return WidgetAttempt(maxOf(stored.snapshot.receivedAt, now), WidgetAttemptOutcome.INVALID)
        }
        return attempt
    }
}

object WeatherWidgetRenderer {
    private val siteZone = ZoneId.of("America/Los_Angeles")
    private val timeFormatter = DateTimeFormatter.ofPattern("h:mm a", Locale.US)

    // preserve the debug host seam without changing its fixed fixture data
    fun render(context: Context, appWidgetId: Int, options: Bundle?, presentation: WidgetPresentation): RemoteViews {
        return render(context, appWidgetId, options) { presentation }
    }

    // recompute the complete forecast grouping for each launcher allocation
    @Suppress("DEPRECATION")
    fun render(
        context: Context,
        appWidgetId: Int,
        options: Bundle?,
        presentation: (Int) -> WidgetPresentation,
    ): RemoteViews {
        // use exact responsive allocations on modern launchers
        if (Build.VERSION.SDK_INT >= 31) {
            val sizes = options?.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
                ?.filter { it.width > 0 && it.height > 0 }?.distinct()?.take(16).orEmpty()
            // tolerate launchers that omit the size map
            if (sizes.isNotEmpty()) {
                return RemoteViews(sizes.associateWith { size ->
                    renderSize(context, appWidgetId, size, presentation(WidgetRowGeometry.capacity(size.width.toInt())))
                })
            }
        }
        val width = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 320)?.coerceAtLeast(1) ?: 320
        val height = options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 100)?.coerceAtLeast(1) ?: 100
        val portrait = SizeF(width.toFloat(), height.toFloat())
        val landscape = SizeF(
            options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, width)?.coerceAtLeast(1)?.toFloat() ?: portrait.width,
            options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)?.coerceAtLeast(1)?.toFloat() ?: portrait.height,
        )
        return RemoteViews(
            renderSize(context, appWidgetId, landscape, presentation(WidgetRowGeometry.capacity(landscape.width.toInt()))),
            renderSize(context, appWidgetId, portrait, presentation(WidgetRowGeometry.capacity(portrait.width.toInt()))),
        )
    }

    // compose one uninterrupted native row with no inset cards or metadata footer
    private fun renderSize(context: Context, appWidgetId: Int, size: SizeF, presentation: WidgetPresentation): RemoteViews {
        val compact = size.height < 76
        val views = RemoteViews(context.packageName, R.layout.widget_row_root)
        views.removeAllViews(R.id.row_primary)
        views.setImageViewBitmap(R.id.widget_panels, panelBitmap(context, size, presentation))
        views.setImageViewBitmap(R.id.widget_hour_ticks, hourTicksBitmap(context, size, presentation))
        // preserve equal weather widths and full-height native content
        for (group in presentation.groups) {
            views.addView(R.id.row_primary, slotView(context, group, compact, (size.width * WidgetRowGeometry.weatherFraction(presentation)).toFloat()))
        }
        // reserve all remaining fifths for one overnight or unavailable message
        if (presentation.message != null) {
            val weight = maxOf(1, WidgetRowGeometry.MIN_WEATHER_SEGMENTS - presentation.groups.size)
            val width = size.width * (1.0 - presentation.groups.size * WidgetRowGeometry.weatherFraction(presentation))
            views.addView(R.id.row_primary, messageView(context, presentation, weight, compact, width.toFloat()))
        }
        views.setContentDescription(android.R.id.background, presentationAccessibility(presentation))
        views.setOnClickPendingIntent(android.R.id.background, forecastPendingIntent(context, appWidgetId))
        return views
    }

    // draw flat panels and evening shading behind real native text and icons
    private fun panelBitmap(context: Context, size: SizeF, presentation: WidgetPresentation): Bitmap {
        val density = context.resources.displayMetrics.density
        val width = (size.width * density).toInt().coerceIn(1, 4096)
        val bitmap = Bitmap.createBitmap(width, 1, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        val fraction = WidgetRowGeometry.weatherFraction(presentation)
        canvas.drawColor(context.getColor(R.color.widget_background))
        // fill each weather panel through its exact edge
        for ((index, group) in presentation.groups.withIndex()) {
            val left = (index * fraction * width).toFloat()
            val right = ((index + 1) * fraction * width).toFloat()
            paint.color = context.getColor(if (group.isNow) R.color.widget_now else R.color.widget_background)
            canvas.drawRect(left, 0f, right, 1f, paint)
            // interpolate sunset within each forecast without recoloring now or bedtime
            WidgetRowGeometry.postSunsetStartFraction(group, presentation.sunset)?.let { start ->
                paint.color = context.getColor(R.color.widget_after_sunset)
                canvas.drawRect(left + (right - left) * start.toFloat(), 0f, right, 1f, paint)
            }
        }
        // fill all unused fifths blue only when overnight is actually displayed
        if (presentation.showBedtime) {
            paint.color = context.getColor(R.color.widget_bedtime)
            canvas.drawRect((presentation.groups.size * fraction * width).toFloat(), 0f, width.toFloat(), 1f, paint)
        }
        val count = presentation.groups.size + if (presentation.message != null) 1 else 0
        paint.color = context.getColor(R.color.widget_divider)
        // separate panels with vertical rules only
        for (index in 1 until count) {
            val x = (index * fraction * width).toFloat()
            canvas.drawRect(x - density * 0.35f, 0f, x + density * 0.35f, 1f, paint)
        }
        return bitmap
    }

    // keep hourly marks in a tiny transparent strip above the unchanged full-height panels
    private fun hourTicksBitmap(context: Context, size: SizeF, presentation: WidgetPresentation): Bitmap {
        val density = context.resources.displayMetrics.density
        val width = (size.width * density).toInt().coerceIn(1, 4096)
        val height = (3 * density).roundToInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint().apply { color = context.getColor(R.color.widget_divider) }
        val tickHeight = minOf(height.toFloat(), (if (size.height < 76) 2f else 3f) * density)
        val halfWidth = density * 0.5f
        val fraction = WidgetRowGeometry.weatherFraction(presentation)
        // mark only interior hour boundaries inside grouped forecasts
        for ((index, group) in presentation.groups.withIndex()) {
            // now already occupies its own single-hour segment
            if (group.isNow) continue
            val left = index * fraction * width
            val panelWidth = fraction * width
            // let existing full-height edges denote the first and final hours
            for (hour in WidgetRowGeometry.hourTickFractions(group.start, group.end)) {
                val x = (left + hour * panelWidth).toFloat()
                canvas.drawRect(x - halfWidth, 0f, x + halfWidth, tickHeight, paint)
            }
        }
        val start = presentation.bedtimeStart
        val end = presentation.bedtimeEnd
        // spread overnight hours across its actual remainder without inventing unknown bounds
        if (presentation.showBedtime && start != null && end != null) {
            val left = presentation.groups.size * fraction * width
            val panelWidth = width - left
            // preserve real elapsed-hour spacing across overnight daylight-saving changes
            for (hour in WidgetRowGeometry.hourTickFractions(start, end)) {
                val x = (left + hour * panelWidth).toFloat()
                canvas.drawRect(x - halfWidth, 0f, x + halfWidth, tickHeight, paint)
            }
        }
        return bitmap
    }

    // tighten text insets and shrink temperatures to give the centered artwork more room
    private fun slotView(context: Context, group: WidgetGroup, compact: Boolean, widthDp: Float): RemoteViews {
        val available = widthDp - if (compact) 6f else 12f
        val temperatureSize = fittedTextSize(context, group.temperatureLabel, available, if (compact) 16f else 24f,
            Typeface.create(context.resources.getFont(R.font.google_sans_bold), Typeface.BOLD))
        val layout = if (compact) R.layout.widget_panel_compact else R.layout.widget_panel
        return RemoteViews(context.packageName, layout).apply {
            setTextViewText(R.id.slot_hour, group.hourLabel)
            setTextViewText(R.id.slot_temperature, group.temperatureLabel)
            // explicitly reset the color when reused tiles return to the neutral range
            setTextColor(R.id.slot_temperature, context.getColor(temperatureColor(group.temperatureTone)))
            setTextViewTextSize(R.id.slot_hour, TypedValue.COMPLEX_UNIT_DIP, if (compact) 10f else 13f)
            setTextViewTextSize(R.id.slot_temperature, TypedValue.COMPLEX_UNIT_DIP, temperatureSize)
            // render the supplied bitmap directly without effects
            setImageViewResource(R.id.slot_condition,
                conditionIcon(group.weatherCondition, group.highWind, group.isNight))
            setContentDescription(R.id.slot_root, group.accessibilityLabel())
        }
    }

    // measure at the actual pixel size so tiny-font hinting cannot shrink readable labels
    private fun fittedTextSize(context: Context, text: String, availableDp: Float, preferredDp: Float, font: Typeface): Float {
        // empty unavailable labels need no width adjustment
        if (text.isEmpty()) return preferredDp
        val density = context.resources.displayMetrics.density
        val measure = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
            textSize = preferredDp * density
            typeface = font
        }
        return preferredDp * minOf(1f, availableDp.coerceAtLeast(1f) * density / measure.measureText(text))
    }

    // retain readable blue orange and red on both daytime and evening blush
    private fun temperatureColor(tone: WidgetTemperatureTone): Int {
        return when (tone) {
            WidgetTemperatureTone.NEUTRAL -> R.color.widget_foreground
            WidgetTemperatureTone.COLD -> R.color.widget_temperature_cold
            WidgetTemperatureTone.WARM -> R.color.widget_temperature_warm
            WidgetTemperatureTone.HOT -> R.color.widget_temperature_hot
        }
    }

    // choose supplied day or moon illustrations without modifying their pixels
    internal fun conditionIcon(condition: WeatherCondition, windy: Boolean, night: Boolean = false): Int {
        // substitute crescents only where the daytime illustration contains a sun
        if (night) {
            when (condition) {
                WeatherCondition.SUNNY -> return if (windy) R.drawable.ic_weather_clear_night_wind else R.drawable.ic_weather_clear_night
                WeatherCondition.PARTLY_CLOUDY -> return if (windy) R.drawable.ic_weather_partly_night_wind else R.drawable.ic_weather_partly_night
                else -> Unit
            }
        }
        return when (condition) {
            WeatherCondition.SUNNY -> if (windy) R.drawable.ic_weather_sunny_wind else R.drawable.ic_weather_sunny
            WeatherCondition.PARTLY_CLOUDY -> if (windy) R.drawable.ic_weather_partly_wind else R.drawable.ic_weather_partly
            WeatherCondition.CLOUDY -> if (windy) R.drawable.ic_weather_cloudy_wind else R.drawable.ic_weather_cloudy
            WeatherCondition.LIGHT_RAIN -> if (windy) R.drawable.ic_weather_light_rain_wind else R.drawable.ic_weather_light_rain
            WeatherCondition.HEAVY_RAIN -> if (windy) R.drawable.ic_weather_heavy_rain_wind else R.drawable.ic_weather_heavy_rain
            WeatherCondition.UNAVAILABLE -> R.drawable.ic_unavailable
        }
    }

    // match the tighter weather spacing throughout the remainder-filling overnight segment
    private fun messageView(context: Context, presentation: WidgetPresentation, weight: Int, compact: Boolean, widthDp: Float): RemoteViews {
        val layout = when {
            compact && weight == 2 -> R.layout.widget_message_compact_weight_2
            compact && weight == 3 -> R.layout.widget_message_compact_weight_3
            compact && weight == 4 -> R.layout.widget_message_compact_weight_4
            compact -> R.layout.widget_message_compact
            weight == 2 -> R.layout.widget_message_weight_2
            weight == 3 -> R.layout.widget_message_weight_3
            weight == 4 -> R.layout.widget_message_weight_4
            else -> R.layout.widget_message
        }
        val overnight = presentation.overnight
        val label = if (presentation.showBedtime) "Overnight" else ""
        val available = widthDp - if (compact) 6f else 12f
        // preserve the shared left edge while giving the longer label more trailing room
        val labelWidth = widthDp - if (compact) 6f else 10f
        val labelSize = fittedTextSize(context, label, labelWidth, if (compact) 10f else 13f,
            context.resources.getFont(R.font.google_sans_regular))
        val temperatureSize = fittedTextSize(context, presentation.message.orEmpty(), available, if (compact) 16f else 24f,
            Typeface.create(context.resources.getFont(R.font.google_sans_bold), Typeface.BOLD))
        return RemoteViews(context.packageName, layout).apply {
            setTextViewText(R.id.bedtime_hour, label)
            setTextViewText(R.id.bedtime_message, presentation.message)
            setTextViewTextSize(R.id.bedtime_hour, TypedValue.COMPLEX_UNIT_DIP, labelSize)
            setTextViewTextSize(R.id.bedtime_message, TypedValue.COMPLEX_UNIT_DIP, temperatureSize)
            setTextColor(R.id.bedtime_message, context.getColor(temperatureColor(overnight?.temperatureTone ?: WidgetTemperatureTone.NEUTRAL)))
            // render the supplied overnight bitmap directly without effects
            setImageViewResource(R.id.bedtime_icon,
                conditionIcon(overnight?.weatherCondition ?: WeatherCondition.UNAVAILABLE,
                    overnight?.highWind == true, night = true))
            setViewVisibility(R.id.bedtime_icon, if (presentation.showBedtime) View.VISIBLE else View.GONE)
            setContentDescription(R.id.bedtime_root, overnightAccessibility(presentation))
        }
    }

    // retain an honest accessible summary for legacy caches without overnight hours
    private fun overnightAccessibility(presentation: WidgetPresentation): String? {
        return presentation.overnight?.accessibilityLabel()
            ?: if (presentation.showBedtime) "Overnight, 8 PM through 7 AM, forecast unavailable" else presentation.message
    }

    // keep complete metadata accessible without a visible footer
    private fun presentationAccessibility(presentation: WidgetPresentation): String {
        val groups = presentation.groups.joinToString("; ") { it.accessibilityLabel() }
        val sunset = presentation.sunset?.atZone(siteZone)?.format(timeFormatter)?.let { "Sunset $it" }
        val freshness = if (presentation.stale) "stale" else "current"
        val unit = if (presentation.unit == TemperatureUnit.FAHRENHEIT) "degrees Fahrenheit" else "degrees Celsius"
        val attribution = if (presentation.showCredit) "Open-Meteo, CC BY 4.0; attribution and license in forecast" else null
        return listOfNotNull(groups.ifBlank { null }, overnightAccessibility(presentation), sunset,
            "${presentation.status.wireName()} forecast", freshness, unit, attribution).joinToString("; ")
    }

    // open the existing attributed in-app forecast route
    internal fun forecastPendingIntent(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            putExtra(MainActivity.EXTRA_ROUTE, MainActivity.ROUTE_FORECAST)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        return PendingIntent.getActivity(context, appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
