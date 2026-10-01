package farm.ballydidean.weather.widget

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

enum class TemperatureUnit {
    FAHRENHEIT,
    CELSIUS;

    val symbol: String
        get() = if (this == FAHRENHEIT) "°F" else "°C"
}

enum class RainCondition(val accessibleName: String) {
    DRY("dry"),
    SPRINKLE("sprinkle"),
    RAIN("rain"),
    UNAVAILABLE("unavailable")
}

enum class WeatherCondition(val accessibleName: String) {
    SUNNY("sunny"),
    PARTLY_CLOUDY("partly cloudy"),
    CLOUDY("cloudy"),
    LIGHT_RAIN("light rain"),
    HEAVY_RAIN("heavy rain"),
    UNAVAILABLE("conditions unavailable")
}

enum class WidgetTemperatureTone {
    NEUTRAL,
    COLD,
    WARM,
    HOT;

    companion object {
        // share the 55f blue cutoff while replacing green with normal ink
        fun fromCelsius(value: Double?): WidgetTemperatureTone {
            // missing readings must not imply heat or cold
            if (value == null || !value.isFinite()) return NEUTRAL
            return when {
                value < (55.0 - 32.0) * 5.0 / 9.0 -> COLD
                value <= (70.0 - 32.0) * 5.0 / 9.0 -> NEUTRAL
                value <= (80.0 - 32.0) * 5.0 / 9.0 -> WARM
                else -> HOT
            }
        }
    }
}

enum class WidgetPresentationMode {
    WEATHER,
    BEDTIME,
    UNAVAILABLE
}

data class WidgetGroup(
    val start: Instant,
    val end: Instant,
    val hourCount: Int,
    val isNow: Boolean,
    val status: ForecastStatus,
    val minimumTemperature: Int?,
    val maximumTemperature: Int?,
    val temperatureLabel: String,
    val condition: RainCondition,
    val hourLabel: String,
    val landscapeLabel: String,
    val accessibleHours: String,
    val weatherCondition: WeatherCondition = WeatherCondition.UNAVAILABLE,
    val highWind: Boolean = false,
    val temperatureTone: WidgetTemperatureTone = WidgetTemperatureTone.NEUTRAL,
    val isNight: Boolean = false,
) {
    // describe every visible forecast semantic
    fun accessibilityLabel(): String {
        // announce wind emphasis alongside the selected condition
        val wind = if (highWind) ", high wind" else ""
        // describe a clear night without announcing sunshine
        val conditionName = if (isNight && weatherCondition == WeatherCondition.SUNNY) "clear" else weatherCondition.accessibleName
        return "$accessibleHours, $temperatureLabel, $conditionName$wind, ${status.wireName()}"
    }
}

data class WidgetPresentation(
    val date: String,
    val groups: List<WidgetGroup>,
    val status: ForecastStatus,
    val stale: Boolean,
    val hardExpired: Boolean,
    val mode: WidgetPresentationMode,
    val showBedtime: Boolean,
    val message: String?,
    val footer: String,
    val sunset: Instant?,
    val generatedAt: Instant,
    val unit: TemperatureUnit,
    val bedtimeStart: Instant? = null,
    val bedtimeEnd: Instant? = null,
    val overnight: WidgetGroup? = null,
) {
    val showCredit: Boolean
        get() = groups.isNotEmpty() || overnight != null
}

data class EffectiveForecastField(
    val mode: ForecastMode,
    val value: Double?,
    val source: ForecastSource?,
)

object WidgetSemanticRenderer {
    private val siteZone = ZoneId.of("America/Los_Angeles")
    private val timeFormatter = DateTimeFormatter.ofPattern("h:mm", Locale.US)

    // recompute cached weather at the supplied clock
    fun render(
        snapshot: WidgetForecastSnapshot,
        now: Instant,
        unit: TemperatureUnit,
        attempt: WidgetAttempt? = null,
        maxSegments: Int = WidgetRowGeometry.MIN_WEATHER_SEGMENTS,
    ): WidgetPresentation {
        val hardExpiry = minOf(snapshot.calendar.overnightEnd ?: snapshot.calendar.dayEnd, snapshot.receivedAt.plus(Duration.ofHours(24)))
        val hardExpired = now >= hardExpiry
        val first = when {
            now < snapshot.calendar.dayStart -> 0
            else -> snapshot.hours.indexOfFirst { now >= it.start && now < it.end }
        }
        val remaining = if (hardExpired || first < 0 || now >= snapshot.calendar.cutoff) {
            emptyList()
        } else {
            snapshot.hours.drop(first).takeWhile { it.start < snapshot.calendar.cutoff }
        }
        val capacity = maxOf(WidgetRowGeometry.MIN_WEATHER_SEGMENTS, maxSegments)
        var blockHours = 1
        // widen only future blocks until all hours fit the single row
        while (1 + (remaining.size - 1 + blockHours - 1) / blockHours > capacity) {
            blockHours += 1
        }
        val memberships = remaining.take(1).map { listOf(it) }.toMutableList()
        val future = remaining.drop(1)
        val forecastCount = minOf(future.size, capacity - 1)
        var consumed = 0
        // use every available panel before reserving any space for bedtime
        for (index in 0 until forecastCount) {
            val reserved = forecastCount - index - 1
            val count = minOf(blockHours, future.size - consumed - reserved)
            memberships += future.subList(consumed, consumed + count)
            consumed += count
        }
        val groups = mutableListOf<WidgetGroup>()
        val applicableFields = mutableListOf<EffectiveForecastField>()
        // preserve every hour once while keeping now separate
        for ((groupIndex, members) in memberships.withIndex()) {
            val temperatures = members.map { effective(it.temperatureC, now, hardExpired) }
            val rains = members.map { effective(it.rainMmPerHour, now, hardExpired) }
            val clouds = members.map { optionalEffective(it.cloudCoverPercent, now, hardExpired) }
            val winds = members.map { optionalEffective(it.windSpeedMps, now, hardExpired) }
            val fields = temperatures + rains + members.mapNotNull { it.cloudCoverPercent?.let { field -> effective(field, now, hardExpired) } } +
                members.mapNotNull { it.windSpeedMps?.let { field -> effective(field, now, hardExpired) } }
            applicableFields += fields
            val range = temperatureRange(temperatures, unit)
            val isNow = groupIndex == 0 && now >= members.first().start && now < members.first().end
            val hourLabel = groupLabel(members, isNow)
            val selectedTemperature = representativeTemperature(temperatures)
            val temperatureLabel = selectedTemperature?.let { "${roundTemperature(convertTemperature(it, unit))}°" } ?: "—"
            groups += WidgetGroup(
                start = members.first().start,
                end = members.last().end,
                hourCount = members.size,
                isNow = isNow,
                status = WidgetForecastDecoder.summarize(fields.map { it.mode }),
                minimumTemperature = range?.first,
                maximumTemperature = range?.second,
                temperatureLabel = temperatureLabel,
                condition = rainCondition(rains),
                hourLabel = hourLabel,
                landscapeLabel = "$hourLabel ${temperatureLabel.removeSuffix("°")}",
                accessibleHours = accessibleHours(members, isNow),
                weatherCondition = weatherCondition(rains, clouds),
                highWind = winds.any { (it.value ?: 0.0) >= 8.9408 },
                temperatureTone = WidgetTemperatureTone.fromCelsius(selectedTemperature),
                isNight = members.first().start.atZone(siteZone).hour < 7 ||
                    snapshot.calendar.sunset?.let { members.first().start >= it } == true,
            )
        }
        val mode = when {
            hardExpired -> WidgetPresentationMode.UNAVAILABLE
            groups.isEmpty() -> WidgetPresentationMode.BEDTIME
            else -> WidgetPresentationMode.WEATHER
        }
        // introduce overnight at four pm when fewer than five daytime hours remain
        val showBedtime = mode == WidgetPresentationMode.BEDTIME ||
            (mode == WidgetPresentationMode.WEATHER && groups.size < WidgetRowGeometry.MIN_WEATHER_SEGMENTS)
        // include only the visible overnight summary in freshness and provenance
        val overnight = if (showBedtime) overnightGroup(snapshot, now, unit, applicableFields) else null
        val stale = stale(snapshot, applicableFields, now, attempt)
        val status = if (applicableFields.isEmpty()) {
            if (hardExpired) ForecastStatus.UNAVAILABLE else snapshot.status
        } else {
            WidgetForecastDecoder.summarize(applicableFields.map { it.mode })
        }
        val message = when {
            mode == WidgetPresentationMode.UNAVAILABLE -> "refresh needed"
            showBedtime -> overnight?.temperatureLabel ?: "—"
            else -> null
        }
        val sunset = if (hardExpired) null else snapshot.calendar.sunset
        return WidgetPresentation(
            date = snapshot.calendar.date.toString(),
            groups = groups,
            status = status,
            stale = stale,
            hardExpired = hardExpired,
            mode = mode,
            showBedtime = showBedtime,
            message = message,
            footer = footer(snapshot, now, sunset, status, stale, unit),
            sunset = sunset,
            generatedAt = snapshot.generatedAt,
            unit = unit,
            bedtimeStart = snapshot.calendar.cutoff,
            bedtimeEnd = snapshot.calendar.overnightEnd,
            overnight = overnight,
        )
    }

    // summarize every real hour from eight pm through seven am including dst
    private fun overnightGroup(
        snapshot: WidgetForecastSnapshot,
        now: Instant,
        unit: TemperatureUnit,
        applicableFields: MutableList<EffectiveForecastField>,
    ): WidgetGroup? {
        val start = snapshot.calendar.cutoff
        val end = snapshot.calendar.overnightEnd ?: return null
        val members = snapshot.hours.filter { it.start >= start && it.end <= end }
        // never summarize an incomplete overnight grid as the full night
        if (members.size.toLong() != Duration.between(start, end).toHours() || members.isEmpty()) return null
        val temperatures = members.map { effective(it.temperatureC, now, false) }
        val rains = members.map { effective(it.rainMmPerHour, now, false) }
        val clouds = members.map { optionalEffective(it.cloudCoverPercent, now, false) }
        val winds = members.map { optionalEffective(it.windSpeedMps, now, false) }
        val fields = temperatures + rains + clouds + winds
        applicableFields += fields
        // keep a missing hour from inventing an overnight low
        val minimum = if (temperatures.any { it.value == null }) null else temperatures.minOf { it.value!! }
        val range = temperatureRange(temperatures, unit)
        val label = minimum?.let { "${roundTemperature(convertTemperature(it, unit))}°" } ?: "—"
        val highWind = winds.any { (it.value ?: 0.0) >= 8.9408 }
        // one proven windy hour is enough but missing readings cannot prove a calm night
        val condition = if (!highWind && winds.any { it.value == null }) WeatherCondition.UNAVAILABLE else weatherCondition(rains, clouds)
        return WidgetGroup(
            start = start,
            end = end,
            hourCount = members.size,
            isNow = false,
            status = WidgetForecastDecoder.summarize(fields.map { it.mode }),
            minimumTemperature = range?.first,
            maximumTemperature = range?.second,
            temperatureLabel = label,
            condition = rainCondition(rains),
            hourLabel = "Overnight",
            landscapeLabel = "Overnight ${label.removeSuffix("°")}",
            accessibleHours = "Overnight, ${accessibleHours(members, false)}, low",
            weatherCondition = condition,
            highWind = highWind,
            temperatureTone = WidgetTemperatureTone.fromCelsius(minimum),
            isNight = true,
        )
    }

    // create an honest empty presentation
    fun unavailable(now: Instant, unit: TemperatureUnit): WidgetPresentation {
        return WidgetPresentation(
            date = now.atZone(siteZone).toLocalDate().toString(),
            groups = emptyList(),
            status = ForecastStatus.UNAVAILABLE,
            stale = true,
            hardExpired = true,
            mode = WidgetPresentationMode.UNAVAILABLE,
            showBedtime = false,
            message = "refresh needed",
            footer = "unavailable · ${unit.symbol}",
            sunset = null,
            generatedAt = now,
            unit = unit,
        )
    }

    // apply a correction deadline without extending it
    internal fun effective(field: ForecastField, now: Instant, hardExpired: Boolean): EffectiveForecastField {
        // hard expiry removes numeric weather
        if (hardExpired) {
            return EffectiveForecastField(ForecastMode.UNAVAILABLE, null, null)
        }
        // retain a correction only before its deadline
        if (field.mode == ForecastMode.ADJUSTED && field.selectedUntil != null && now < field.selectedUntil) {
            return EffectiveForecastField(ForecastMode.ADJUSTED, field.selected, field.selectedSource)
        }
        // demote to the captured raw pair
        if (field.raw != null && field.rawSource != null) {
            return EffectiveForecastField(ForecastMode.RAW, field.raw, field.rawSource)
        }
        return EffectiveForecastField(ForecastMode.UNAVAILABLE, null, null)
    }

    // mark acquisition source or known-attempt failures stale
    private fun stale(
        snapshot: WidgetForecastSnapshot,
        fields: List<EffectiveForecastField>,
        now: Instant,
        attempt: WidgetAttempt?,
    ): Boolean {
        val acquisitionAge = Duration.between(snapshot.receivedAt, now)
        // reject future or old acquisition clocks
        if (acquisitionAge.isNegative || acquisitionAge > Duration.ofMinutes(90)) {
            return true
        }
        // a persisted failed attempt is immediately visible
        if (attempt != null) {
            // unknown failure or impossible success clocks cannot claim freshness
            if (attempt.outcome != WidgetAttemptOutcome.SUCCESS ||
                attempt.attemptedAt < snapshot.receivedAt || attempt.attemptedAt > now
            ) {
                return true
            }
        }
        // inspect every applicable source clock
        for (field in fields) {
            val source = field.source ?: continue
            val receiptAge = Duration.between(source.receivedAt, now)
            val runAge = source.runAt?.let { Duration.between(it, now) }
            // reject future clocks or age over twelve hours
            if (receiptAge.isNegative || receiptAge > Duration.ofHours(12) ||
                runAge?.isNegative == true || runAge != null && runAge > Duration.ofHours(12)
            ) {
                return true
            }
        }
        return false
    }

    // retain missing legacy condition fields as unknown
    private fun optionalEffective(field: ForecastField?, now: Instant, expired: Boolean): EffectiveForecastField {
        return field?.let { effective(it, now, expired) } ?: EffectiveForecastField(ForecastMode.UNAVAILABLE, null, null)
    }

    // share the unrounded selected celsius value between text and comfort color
    private fun representativeTemperature(fields: List<EffectiveForecastField>): Double? {
        // a partial interval cannot claim a complete temperature
        if (fields.any { it.value == null }) {
            return null
        }
        val values = fields.map { it.value!! }
        val mean = values.average()
        val meanFahrenheit = convertTemperature(mean, TemperatureUnit.FAHRENHEIT)
        return when {
            meanFahrenheit > 65.0 -> values.max()
            meanFahrenheit < 50.0 -> values.min()
            else -> mean
        }
    }

    // let the wettest hour override mean cloud coverage
    private fun weatherCondition(rains: List<EffectiveForecastField>, clouds: List<EffectiveForecastField>): WeatherCondition {
        // never infer fair weather from missing rainfall
        if (rains.any { it.value == null }) {
            return WeatherCondition.UNAVAILABLE
        }
        val rain = rains.maxOf { it.value!! }
        // preserve rain even when cloud coverage is unavailable
        if (rain > 0) {
            return if (rain < 2.5) WeatherCondition.LIGHT_RAIN else WeatherCondition.HEAVY_RAIN
        }
        // dry weather still needs real cloud coverage
        if (clouds.any { it.value == null }) {
            return WeatherCondition.UNAVAILABLE
        }
        val coverage = clouds.map { it.value!! }.average()
        return when {
            coverage < 25 -> WeatherCondition.SUNNY
            coverage < 75 -> WeatherCondition.PARTLY_CLOUDY
            else -> WeatherCondition.CLOUDY
        }
    }

    // round a complete group after conversion
    private fun temperatureRange(fields: List<EffectiveForecastField>, unit: TemperatureUnit): Pair<Int, Int>? {
        // keep partial groups unavailable
        if (fields.any { it.value == null }) {
            return null
        }
        val rounded = fields.map { roundTemperature(convertTemperature(it.value!!, unit)) }
        return rounded.min() to rounded.max()
    }

    // classify the wettest unrounded member
    private fun rainCondition(fields: List<EffectiveForecastField>): RainCondition {
        // never render missing rain as dry
        if (fields.any { it.value == null }) {
            return RainCondition.UNAVAILABLE
        }
        val maximum = fields.maxOf { it.value!! }
        return when {
            maximum == 0.0 -> RainCondition.DRY
            maximum <= 2.5 -> RainCondition.SPRINKLE
            else -> RainCondition.RAIN
        }
    }

    // convert only for fahrenheit displays
    private fun convertTemperature(value: Double, unit: TemperatureUnit): Double {
        return if (unit == TemperatureUnit.FAHRENHEIT) value * 9.0 / 5.0 + 32.0 else value
    }

    // round midpoint ties away from zero
    private fun roundTemperature(value: Double): Int {
        val rounded = if (value < 0) -floor(abs(value) + 0.5) else floor(value + 0.5)
        return rounded.toInt()
    }

    // show only the starting clock hour
    private fun groupLabel(members: List<ForecastHour>, isNow: Boolean): String {
        // identify the current interval explicitly
        if (isNow) {
            return "Now"
        }
        val local = members.first().start.atZone(siteZone)
        return local.format(DateTimeFormatter.ofPattern("ha", Locale.US)).lowercase(Locale.US)
    }

    // describe the complete interval range
    private fun accessibleHours(members: List<ForecastHour>, isNow: Boolean): String {
        val start = members.first().start.atZone(siteZone)
        val end = members.last().end.atZone(siteZone)
        val intervalFormatter = DateTimeFormatter.ofPattern("h a z", Locale.US)
        val startText = start.format(intervalFormatter)
        val endText = end.format(intervalFormatter)
        return if (isNow) "Now, $startText through $endText" else "$startText through $endText"
    }

    // combine compact sunset freshness provenance and unit
    private fun footer(
        snapshot: WidgetForecastSnapshot,
        now: Instant,
        sunset: Instant?,
        status: ForecastStatus,
        stale: Boolean,
        unit: TemperatureUnit,
    ): String {
        val sunsetText = sunset?.atZone(siteZone)?.format(timeFormatter)
        val ageMinutes = maxOf(0, Duration.between(snapshot.receivedAt, now).toMinutes())
        val freshness = if (stale) "stale" else "${ageMinutes}m"
        val provenance = when (status) {
            ForecastStatus.ADJUSTED -> "adj"
            ForecastStatus.MIXED -> "mix"
            ForecastStatus.RAW -> "raw"
            ForecastStatus.UNAVAILABLE -> "n/a"
        }
        return listOfNotNull(sunsetText, provenance, freshness, unit.symbol).joinToString(" · ")
    }
}

// expose the lowercase public status spelling
internal fun ForecastStatus.wireName(): String = name.lowercase(Locale.US)
