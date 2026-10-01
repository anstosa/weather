package farm.ballydidean.weather.widget

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

enum class ForecastMode {
    ADJUSTED,
    RAW,
    UNAVAILABLE
}

enum class ForecastStatus {
    ADJUSTED,
    MIXED,
    RAW,
    UNAVAILABLE
}

data class ForecastSource(
    val runAt: Instant?,
    val receivedAt: Instant,
)

data class ForecastField(
    val mode: ForecastMode,
    val raw: Double?,
    val rawSource: ForecastSource?,
    val reason: String,
    val selected: Double?,
    val selectedSource: ForecastSource?,
    val selectedUntil: Instant?,
)

data class ForecastHour(
    val start: Instant,
    val end: Instant,
    val temperatureC: ForecastField,
    val rainMmPerHour: ForecastField,
    val cloudCoverPercent: ForecastField? = null,
    val windSpeedMps: ForecastField? = null,
)

data class ForecastCalendar(
    val date: LocalDate,
    val dayStart: Instant,
    val dayEnd: Instant,
    val cutoff: Instant,
    val sunset: Instant?,
    val overnightEnd: Instant? = null,
)

data class WidgetForecastSnapshot(
    val generatedAt: Instant,
    val receivedAt: Instant,
    val calendar: ForecastCalendar,
    val hours: List<ForecastHour>,
    val status: ForecastStatus,
)

object WidgetForecastDecoder {
    const val MAX_BYTES = 128 * 1024
    private val instantPattern = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")
    private val datePattern = Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
    private val siteZone = ZoneId.of("America/Los_Angeles")
    private val rootKeys = setOf("attribution", "calendar", "generatedAt", "hours", "receivedAt", "schemaVersion", "site", "status")
    private val fieldKeys = setOf("mode", "raw", "rawSource", "reason", "selected", "selectedSource", "selectedUntil")
    private val adjustedReasons = setOf("generic_adjustment", "independent_adjustment", "rain_adjustment")
    private val rawReasons = setOf("deadline_expired", "deadline_unavailable", "raw_forecast")

    // validate one complete public snapshot
    fun decode(bytes: ByteArray): WidgetForecastSnapshot {
        require(bytes.size <= MAX_BYTES) { "widget snapshot exceeds 128 KiB" }
        val root = StrictJson.parse(bytes).closedObject(rootKeys, "root")
        val version = root.string("schemaVersion")
        require(version in setOf("weather-widget/v1", "weather-widget/v2", "weather-widget/v3")) { "unsupported schema version" }
        val hasConditions = version != "weather-widget/v1"
        val hasOvernight = version == "weather-widget/v3"
        validateAttribution(root.objectValue("attribution"))
        validateSite(root.objectValue("site"))
        val generatedAt = instant(root.string("generatedAt"), "generatedAt")
        val receivedAt = instant(root.string("receivedAt"), "receivedAt")
        require(generatedAt <= receivedAt) { "snapshot clocks are reversed" }
        val calendar = decodeCalendar(root.objectValue("calendar"), generatedAt, hasOvernight)
        val hours = root.array("hours").mapIndexed { index, value ->
            decodeHour(value, generatedAt, calendar, index, hasConditions)
        }
        val horizon = calendar.overnightEnd ?: calendar.dayEnd
        require(hours.size.toLong() == Duration.between(calendar.dayStart, horizon).toHours()) { "hour count is outside the site calendar" }
        require(hours.lastOrNull()?.end == horizon) { "hour grid does not reach forecast end" }
        val status = status(root.string("status"))
        val derivedStatus = summarize(hours.flatMap { listOfNotNull(it.temperatureC.mode, it.rainMmPerHour.mode, it.cloudCoverPercent?.mode, it.windSpeedMps?.mode) })
        require(status == derivedStatus) { "snapshot status does not match fields" }
        return WidgetForecastSnapshot(generatedAt, receivedAt, calendar, hours, status)
    }

    // validate fixed public attribution
    private fun validateAttribution(value: JsonObject) {
        value.closedObject(setOf("label", "licenseUrl", "providerUrl"), "attribution")
        require(value.string("label") == "Open-Meteo · CC BY 4.0") { "unexpected attribution" }
        require(value.string("licenseUrl") == "https://creativecommons.org/licenses/by/4.0/") { "unexpected license" }
        require(value.string("providerUrl") == "https://open-meteo.com/") { "unexpected provider" }
    }

    // validate the one supported public site
    private fun validateSite(value: JsonObject) {
        value.closedObject(setOf("latitude", "longitude", "name", "slug", "timezone"), "site")
        require(value.string("name") == "Ballydidean") { "unexpected site name" }
        require(value.string("slug") == "ballydidean") { "unexpected site slug" }
        require(value.string("timezone") == siteZone.id) { "unexpected site timezone" }
        require(value.number("latitude") == 47.950429954185445) { "unexpected site latitude" }
        require(value.number("longitude") == -122.42797012608193) { "unexpected site longitude" }
    }

    // validate generated-at anchored calendar fields
    private fun decodeCalendar(value: JsonObject, generatedAt: Instant, hasOvernight: Boolean): ForecastCalendar {
        // extend only the new closed contract
        val keys = setOf("cutoff", "date", "dayEnd", "dayStart", "sunset") + if (hasOvernight) setOf("overnightEnd") else emptySet()
        value.closedObject(keys, "calendar")
        val dateText = value.string("date")
        require(datePattern.matches(dateText)) { "calendar date is malformed" }
        val date = LocalDate.parse(dateText)
        val dayStart = instant(value.string("dayStart"), "dayStart")
        val dayEnd = instant(value.string("dayEnd"), "dayEnd")
        val cutoff = instant(value.string("cutoff"), "cutoff")
        val expectedDayStart = date.atStartOfDay(siteZone).toInstant()
        val expectedDayEnd = date.plusDays(1).atStartOfDay(siteZone).toInstant()
        val expectedCutoff = date.atTime(20, 0).atZone(siteZone).toInstant()
        require(dayStart == expectedDayStart && dayEnd == expectedDayEnd && cutoff == expectedCutoff) {
            "calendar bounds do not match the site date"
        }
        // retain the preceding evening until seven in the site timezone
        val overnightEnd = if (hasOvernight) instant(value.string("overnightEnd"), "overnightEnd") else null
        if (hasOvernight) {
            require(overnightEnd == date.plusDays(1).atTime(7, 0).atZone(siteZone).toInstant()) { "overnight end is not seven am" }
            require(generatedAt >= date.atTime(7, 0).atZone(siteZone).toInstant() && generatedAt < overnightEnd) {
                "generatedAt is outside the forecast day"
            }
        } else {
            require(generatedAt >= dayStart && generatedAt < dayEnd) { "generatedAt is outside the anchored day" }
        }
        val sunset = nullableInstant(value.values.getValue("sunset"), "sunset")
        return ForecastCalendar(date, dayStart, dayEnd, cutoff, sunset, overnightEnd)
    }

    // validate one exact hourly interval
    private fun decodeHour(
        value: JsonValue,
        generatedAt: Instant,
        calendar: ForecastCalendar,
        index: Int,
        hasConditions: Boolean,
    ): ForecastHour {
        val baseKeys = setOf("end", "rainMmPerHour", "start", "temperatureC")
        // keep both versioned hourly contracts closed
        val keys = if (hasConditions) baseKeys + setOf("cloudCoverPercent", "windSpeedMps") else baseKeys
        val objectValue = value.closedObject(keys, "hour")
        val start = instant(objectValue.string("start"), "hour start")
        val end = instant(objectValue.string("end"), "hour end")
        val expectedStart = calendar.dayStart.plus(Duration.ofHours(index.toLong()))
        require(start == expectedStart && end == start.plus(Duration.ofHours(1))) { "hour grid is not contiguous" }
        require(start >= calendar.dayStart && end <= (calendar.overnightEnd ?: calendar.dayEnd)) { "hour is outside the forecast horizon" }
        // retain absent v1 conditions without inventing sunny or calm weather
        val cloud = if (hasConditions) decodeField(objectValue.values.getValue("cloudCoverPercent"), generatedAt, 0.0, 100.0, "cloud") else null
        val wind = if (hasConditions) decodeField(objectValue.values.getValue("windSpeedMps"), generatedAt, 0.0, 150.0, "wind") else null
        require(cloud?.mode != ForecastMode.ADJUSTED) { "cloud corrections are unsupported" }
        require(wind?.mode != ForecastMode.ADJUSTED || wind.reason == "generic_adjustment") { "wind correction reason is invalid" }
        return ForecastHour(
            start,
            end,
            decodeField(objectValue.values.getValue("temperatureC"), generatedAt, -100.0, 70.0, "temperature"),
            decodeField(objectValue.values.getValue("rainMmPerHour"), generatedAt, 0.0, 2000.0, "rain"),
            cloud,
            wind,
        )
    }

    // validate one bounded value and its paired provenance
    private fun decodeField(
        value: JsonValue,
        generatedAt: Instant,
        minimum: Double,
        maximum: Double,
        label: String,
    ): ForecastField {
        val objectValue = value.closedObject(fieldKeys, label)
        val mode = mode(objectValue.string("mode"))
        val raw = nullableNumber(objectValue.values.getValue("raw"), minimum, maximum, "$label raw")
        val selected = nullableNumber(objectValue.values.getValue("selected"), minimum, maximum, "$label selected")
        val rawSource = nullableSource(objectValue.values.getValue("rawSource"), generatedAt, "$label rawSource")
        val selectedSource = nullableSource(objectValue.values.getValue("selectedSource"), generatedAt, "$label selectedSource")
        val selectedUntil = nullableInstant(objectValue.values.getValue("selectedUntil"), "$label selectedUntil")
        val reason = objectValue.string("reason")
        // enforce mode-specific pairings
        when (mode) {
            ForecastMode.ADJUSTED -> {
                require(selected != null && selectedSource != null && selectedUntil != null) { "adjusted $label is incomplete" }
                require((raw == null) == (rawSource == null)) { "adjusted raw $label provenance is unpaired" }
                require(reason in adjustedReasons) { "adjusted $label reason is invalid" }
                require(selectedUntil > generatedAt) { "adjusted $label deadline is not future" }
            }
            ForecastMode.RAW -> {
                require(raw != null && rawSource != null && selected == raw) { "raw $label is incomplete" }
                require(selectedSource == null && selectedUntil == null) { "raw $label has adjusted metadata" }
                require(reason in rawReasons) { "raw $label reason is invalid" }
            }
            ForecastMode.UNAVAILABLE -> {
                require(raw == null && rawSource == null && selected == null) { "unavailable $label has a value" }
                require(selectedSource == null && selectedUntil == null && reason == "missing") { "unavailable $label metadata is invalid" }
            }
        }
        return ForecastField(mode, raw, rawSource, reason, selected, selectedSource, selectedUntil)
    }

    // validate one source's causal clocks
    private fun nullableSource(value: JsonValue, generatedAt: Instant, label: String): ForecastSource? {
        // retain explicit null
        if (value === JsonNull) {
            return null
        }
        val objectValue = value.closedObject(setOf("receivedAt", "runAt"), label)
        val receivedAt = instant(objectValue.string("receivedAt"), "$label receivedAt")
        val runAt = nullableInstant(objectValue.values.getValue("runAt"), "$label runAt")
        require(receivedAt <= generatedAt) { "$label receipt is after generatedAt" }
        require(runAt == null || runAt <= receivedAt) { "$label clocks are reversed" }
        return ForecastSource(runAt, receivedAt)
    }

    // parse a bounded nullable number
    private fun nullableNumber(value: JsonValue, minimum: Double, maximum: Double, label: String): Double? {
        // retain explicit null
        if (value === JsonNull) {
            return null
        }
        val number = (value as? JsonNumber)?.value ?: throw IllegalArgumentException("$label must be numeric or null")
        require(number in minimum..maximum) { "$label is outside bounds" }
        return number
    }

    // parse a strict millisecond utc instant
    private fun instant(value: String, label: String): Instant {
        require(instantPattern.matches(value)) { "$label is malformed" }
        return try {
            Instant.parse(value)
        } catch (error: RuntimeException) {
            throw IllegalArgumentException("$label is malformed", error)
        }
    }

    // parse an instant or explicit null
    private fun nullableInstant(value: JsonValue, label: String): Instant? {
        // retain explicit null
        if (value === JsonNull) {
            return null
        }
        val text = (value as? JsonString)?.value ?: throw IllegalArgumentException("$label must be a string or null")
        return instant(text, label)
    }

    // map one public mode
    private fun mode(value: String): ForecastMode = when (value) {
        "adjusted" -> ForecastMode.ADJUSTED
        "raw" -> ForecastMode.RAW
        "unavailable" -> ForecastMode.UNAVAILABLE
        else -> throw IllegalArgumentException("unsupported forecast mode")
    }

    // map one public status
    private fun status(value: String): ForecastStatus = when (value) {
        "adjusted" -> ForecastStatus.ADJUSTED
        "mixed" -> ForecastStatus.MIXED
        "raw" -> ForecastStatus.RAW
        "unavailable" -> ForecastStatus.UNAVAILABLE
        else -> throw IllegalArgumentException("unsupported forecast status")
    }

    // derive the public aggregate mode
    internal fun summarize(modes: List<ForecastMode>): ForecastStatus {
        val unique = modes.toSet()
        // preserve one homogeneous mode
        if (unique.size == 1) {
            return when (unique.single()) {
                ForecastMode.ADJUSTED -> ForecastStatus.ADJUSTED
                ForecastMode.RAW -> ForecastStatus.RAW
                ForecastMode.UNAVAILABLE -> ForecastStatus.UNAVAILABLE
            }
        }
        return ForecastStatus.MIXED
    }
}
