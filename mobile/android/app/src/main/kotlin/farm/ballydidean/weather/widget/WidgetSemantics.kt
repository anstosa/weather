package farm.ballydidean.weather.widget

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
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
) {
    // describe every visible forecast semantic
    fun accessibilityLabel(): String {
        return "$accessibleHours, $temperatureLabel, ${condition.accessibleName}, ${status.wireName()}"
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
) {
    val showCredit: Boolean
        get() = mode == WidgetPresentationMode.WEATHER && groups.isNotEmpty()
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
    ): WidgetPresentation {
        val hardExpiry = minOf(snapshot.calendar.dayEnd, snapshot.receivedAt.plus(Duration.ofHours(24)))
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
        val width = if (remaining.isEmpty()) 1 else minOf(3, maxOf(1, ceil(remaining.size / 7.0).toInt()))
        val groups = mutableListOf<WidgetGroup>()
        val applicableFields = mutableListOf<EffectiveForecastField>()
        // preserve contiguous fixed-membership groups
        for ((groupIndex, members) in remaining.chunked(width).withIndex()) {
            val temperatures = members.map { effective(it.temperatureC, now, hardExpired) }
            val rains = members.map { effective(it.rainMmPerHour, now, hardExpired) }
            applicableFields += temperatures
            applicableFields += rains
            val range = temperatureRange(temperatures, unit)
            val isNow = groupIndex == 0 && now >= members.first().start && now < members.first().end
            val hourLabel = groupLabel(snapshot, members, isNow)
            val temperatureLabel = range?.let { (minimum, maximum) ->
                if (minimum == maximum) "$minimum°" else "$minimum–$maximum°"
            } ?: "—"
            groups += WidgetGroup(
                start = members.first().start,
                end = members.last().end,
                hourCount = members.size,
                isNow = isNow,
                status = WidgetForecastDecoder.summarize((temperatures + rains).map { it.mode }),
                minimumTemperature = range?.first,
                maximumTemperature = range?.second,
                temperatureLabel = temperatureLabel,
                condition = rainCondition(rains),
                hourLabel = hourLabel,
                landscapeLabel = "$hourLabel ${temperatureLabel.removeSuffix("°")}",
                accessibleHours = accessibleHours(members, isNow),
            )
        }
        val stale = stale(snapshot, applicableFields, now, attempt)
        val status = if (applicableFields.isEmpty()) {
            if (hardExpired) ForecastStatus.UNAVAILABLE else snapshot.status
        } else {
            WidgetForecastDecoder.summarize(applicableFields.map { it.mode })
        }
        val mode = when {
            hardExpired -> WidgetPresentationMode.UNAVAILABLE
            groups.isEmpty() -> WidgetPresentationMode.BEDTIME
            else -> WidgetPresentationMode.WEATHER
        }
        val showBedtime = mode == WidgetPresentationMode.BEDTIME || (mode == WidgetPresentationMode.WEATHER && groups.size < 7)
        val message = when {
            mode == WidgetPresentationMode.UNAVAILABLE -> "refresh needed"
            showBedtime -> "go to bed"
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

    // build a compact disambiguated group label
    private fun groupLabel(snapshot: WidgetForecastSnapshot, members: List<ForecastHour>, isNow: Boolean): String {
        // identify the current interval explicitly
        if (isNow) {
            return "Now"
        }
        val firstIndex = snapshot.hours.indexOf(members.first())
        val lastIndex = snapshot.hours.indexOf(members.last())
        val first = compactHour(snapshot, firstIndex)
        val last = compactHour(snapshot, lastIndex)
        return if (members.size == 1) first else "$first–$last"
    }

    // label repeated local hours as a and b
    private fun compactHour(snapshot: WidgetForecastSnapshot, index: Int): String {
        val local = snapshot.hours[index].start.atZone(siteZone)
        val peers = snapshot.hours.indices.filter {
            val candidate = snapshot.hours[it].start.atZone(siteZone)
            candidate.toLocalDateTime() == local.toLocalDateTime()
        }
        val hour = when (val clockHour = local.hour % 12) {
            0 -> 12
            else -> clockHour
        }
        val repeatSuffix = if (peers.size == 2) if (peers.first() == index) "a" else "b" else ""
        val daySuffix = if (local.hour < 12) "a" else "p"
        return "$hour$repeatSuffix$daySuffix"
    }

    // describe the complete interval range
    private fun accessibleHours(members: List<ForecastHour>, isNow: Boolean): String {
        val start = members.first().start.atZone(siteZone)
        val end = members.last().end.atZone(siteZone)
        val startText = start.format(timeFormatter)
        val endText = end.format(timeFormatter)
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
