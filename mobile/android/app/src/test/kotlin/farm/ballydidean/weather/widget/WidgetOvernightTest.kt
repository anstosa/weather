package farm.ballydidean.weather.widget

import farm.ballydidean.weather.R
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatterBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetOvernightTest {
    private val zone = ZoneId.of("America/Los_Angeles")
    private val instantFormat = DateTimeFormatterBuilder().appendInstant(3).toFormatter()

    // include the next morning low but exclude seven am and the daytime coldest hour
    @Test
    fun overnightUsesTheWholeWindowMinimumInBothUnits() {
        val base = snapshot()
        val forecast = base.copy(hours = base.hours.map { hour ->
            val local = hour.start.atZone(zone).hour
            hour.copy(temperatureC = raw(when (local) { 5 -> 4.0; 7 -> -20.0; 12 -> -30.0; else -> 15.0 }))
        })
        val fahrenheit = render(forecast, 19)
        val celsius = render(forecast, 19, TemperatureUnit.CELSIUS)
        assertEquals("Overnight", fahrenheit.overnight!!.hourLabel)
        assertEquals("39°", fahrenheit.message)
        assertEquals("4°", celsius.message)
        assertEquals(11, fahrenheit.overnight!!.hourCount)
        assertEquals(WidgetTemperatureTone.COLD, fahrenheit.overnight!!.temperatureTone)
        assertTrue(fahrenheit.overnight!!.accessibilityLabel().contains("low, 39°"))
        assertTrue(fahrenheit.showCredit)
    }

    // apply the daytime cold cutoff to overnight lows before rounding
    @Test
    fun overnightUsesThe55FColorBoundaryInBothUnits() {
        val base = snapshot()
        // distinguish identical rounded labels on either side of the cutoff
        for ((fahrenheit, tone) in listOf(54.9 to WidgetTemperatureTone.COLD, 55.0 to WidgetTemperatureTone.NEUTRAL)) {
            val temperatureC = (fahrenheit - 32.0) * 5.0 / 9.0
            val forecast = base.copy(hours = base.hours.map { hour ->
                hour.copy(temperatureC = raw(temperatureC))
            })
            // retain the same physical threshold in fahrenheit and celsius
            for (unit in TemperatureUnit.entries) {
                val summary = render(forecast, 20, unit).overnight!!
                assertEquals(tone, summary.temperatureTone)
                assertEquals(if (unit == TemperatureUnit.FAHRENHEIT) "55°" else "13°", summary.temperatureLabel)
            }
        }
    }

    // start the blue remainder at four pm and retain it until seven am
    @Test
    fun visibilityAndCacheSurviveMidnightUntilSeven() {
        val forecast = snapshot()
        assertFalse(render(forecast, 15).showBedtime)
        assertTrue(render(forecast, 16).showBedtime)
        assertNotNull(render(forecast, 16).overnight)
        // retain the complete night before and after the calendar rollover
        for (hour in listOf(20, 23, 24, 30)) {
            val presentation = render(forecast, hour)
            assertTrue(presentation.groups.isEmpty())
            assertFalse(presentation.hardExpired)
            assertEquals("59°", presentation.message)
            assertNotNull(presentation.overnight)
        }
        assertTrue(render(forecast, 31).hardExpired)
        assertEquals("refresh needed", render(forecast, 31).message)
        assertEquals(forecast.calendar.overnightEnd, WidgetBoundaryPlanner.earliest(forecast, at(forecast, 30).plusSeconds(1)))
    }

    // summarize the wettest hour mean sky and any strong wind across the complete night
    @Test
    fun summaryIncludesNextMorningRainAndWind() {
        val base = snapshot()
        val forecast = base.copy(hours = base.hours.map { hour ->
            // hide the strongest event in the final overnight hour
            if (hour.end == base.calendar.overnightEnd) {
                hour.copy(rainMmPerHour = raw(2.5), windSpeedMps = raw(9.0))
            } else hour
        })
        val summary = render(forecast, 20).overnight!!
        assertEquals(WeatherCondition.HEAVY_RAIN, summary.weatherCondition)
        assertTrue(summary.highWind)
        assertTrue(summary.isNight)
        assertEquals(R.drawable.ic_weather_heavy_rain_wind, WeatherWidgetRenderer.conditionIcon(summary.weatherCondition, summary.highWind, summary.isNight))
    }

    // keep cloud and missing-rain semantics identical to daytime summaries
    @Test
    fun overnightCloudsAndMissingFieldsAreHonest() {
        val base = snapshot()
        // cover fair partly cloudy and fully cloudy means
        for ((cloud, condition) in listOf(0.0 to WeatherCondition.SUNNY, 50.0 to WeatherCondition.PARTLY_CLOUDY, 90.0 to WeatherCondition.CLOUDY)) {
            val forecast = base.copy(hours = base.hours.map { it.copy(cloudCoverPercent = raw(cloud)) })
            assertEquals(condition, render(forecast, 20).overnight!!.weatherCondition)
        }
        val missing = ForecastField(ForecastMode.UNAVAILABLE, null, null, "missing", null, null, null)
        val partial = base.copy(hours = base.hours.map { hour ->
            // one missing next-morning hour invalidates the full-window claims
            if (hour.end == base.calendar.overnightEnd) hour.copy(temperatureC = missing, rainMmPerHour = missing) else hour
        })
        val summary = render(partial, 20).overnight!!
        assertEquals("—", summary.temperatureLabel)
        assertEquals(WeatherCondition.UNAVAILABLE, summary.weatherCondition)
        assertEquals(WidgetTemperatureTone.NEUTRAL, summary.temperatureTone)
        // absent wind is not evidence for the non-wind illustration
        val unknownWind = base.copy(hours = base.hours.map { it.copy(windSpeedMps = missing) })
        assertEquals(WeatherCondition.UNAVAILABLE, render(unknownWind, 20).overnight!!.weatherCondition)
        val partialWind = base.copy(hours = base.hours.map { hour ->
            // remove one otherwise calm next-morning hour
            if (hour.end == base.calendar.overnightEnd) hour.copy(windSpeedMps = missing) else hour
        })
        assertEquals(WeatherCondition.UNAVAILABLE, render(partialWind, 20).overnight!!.weatherCondition)
        val provenWind = unknownWind.copy(hours = unknownWind.hours.map { hour ->
            // one positive high-wind reading proves the any-hour threshold
            if (hour.end == base.calendar.overnightEnd) hour.copy(windSpeedMps = raw(9.0)) else hour
        })
        assertEquals(WeatherCondition.SUNNY, render(provenWind, 20).overnight!!.weatherCondition)
        assertTrue(render(provenWind, 20).overnight!!.highWind)
    }

    // expire overnight adjustments to their captured raw values without extending freshness
    @Test
    fun overnightUsesAdjustedValuesOnlyBeforeTheirDeadline() {
        val base = snapshot()
        val deadline = at(base, 21)
        val adjusted = base.copy(hours = base.hours.map { hour ->
            hour.copy(temperatureC = raw(15.0).copy(
                mode = ForecastMode.ADJUSTED, selected = 5.0, selectedSource = raw(15.0).rawSource,
                selectedUntil = deadline, reason = "independent_adjustment",
            ))
        })
        assertEquals("41°", render(adjusted, 20).message)
        assertEquals("59°", render(adjusted, 21).message)
        assertEquals(deadline, WidgetBoundaryPlanner.earliest(adjusted, at(base, 20).plusSeconds(1)))
    }

    // preserve real elapsed intervals across both dst changes
    @Test
    fun calendarDecodesBothDstNightsAndEarlyMorningAnchors() {
        // include the preceding local evening on each transition
        for ((date, hours) in listOf("2026-03-07" to 10, "2026-10-31" to 12, "2026-09-12" to 11)) {
            val forecast = snapshot(date)
            val presentation = WidgetSemanticRenderer.render(forecast, forecast.calendar.cutoff, TemperatureUnit.FAHRENHEIT)
            assertEquals(hours, presentation.overnight!!.hourCount)
            assertEquals(hours + 20, forecast.hours.size)
            assertEquals(7, forecast.calendar.overnightEnd!!.atZone(zone).hour)
            val early = WidgetForecastDecoder.decode(json(date, forecast.calendar.overnightEnd!!.minusSeconds(3600)).toByteArray())
            assertEquals(forecast.calendar.date, early.calendar.date)
            assertFalse(WidgetSemanticRenderer.render(early, early.generatedAt, TemperatureUnit.FAHRENHEIT).hardExpired)
        }
    }

    // reject malformed new bounds without loosening closed old contracts
    @Test
    fun decoderRejectsIncorrectOvernightCalendarAndTruncatedGrid() {
        val valid = json("2026-09-12")
        val wrongEnd = valid.replace("2026-09-13T14:00:00.000Z", "2026-09-13T15:00:00.000Z")
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(wrongEnd.toByteArray()) }
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(valid.replace("weather-widget/v3", "weather-widget/v2").toByteArray()) }
        val late = json("2026-09-12", Instant.parse("2026-09-13T14:00:00Z"))
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(late.toByteArray()) }
        val truncated = valid.replace(Regex(",\\{\"start\":\"2026-09-13T13:00:00.000Z\".*(?=])"), "")
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(truncated.toByteArray()) }
    }

    // choose all four supplied crescent variants and reuse sun-free cloud and rain art
    @Test
    fun nightIconMappingUsesMoonsOnlyWhereNeeded() {
        assertEquals(R.drawable.ic_weather_clear_night, WeatherWidgetRenderer.conditionIcon(WeatherCondition.SUNNY, false, true))
        assertEquals(R.drawable.ic_weather_clear_night_wind, WeatherWidgetRenderer.conditionIcon(WeatherCondition.SUNNY, true, true))
        assertEquals(R.drawable.ic_weather_partly_night, WeatherWidgetRenderer.conditionIcon(WeatherCondition.PARTLY_CLOUDY, false, true))
        assertEquals(R.drawable.ic_weather_partly_night_wind, WeatherWidgetRenderer.conditionIcon(WeatherCondition.PARTLY_CLOUDY, true, true))
        // preserve daytime assets and every weather state without a sun
        for (wind in listOf(false, true)) {
            for (condition in listOf(WeatherCondition.CLOUDY, WeatherCondition.LIGHT_RAIN, WeatherCondition.HEAVY_RAIN, WeatherCondition.UNAVAILABLE)) {
                assertEquals(WeatherWidgetRenderer.conditionIcon(condition, wind), WeatherWidgetRenderer.conditionIcon(condition, wind, true))
            }
        }
        assertEquals(R.drawable.ic_weather_sunny, WeatherWidgetRenderer.conditionIcon(WeatherCondition.SUNNY, false))
    }

    // retain moon semantics in post-sunset regular forecast tiles too
    @Test
    fun eveningTilesUseNightIconsWithoutChangingNowBackground() {
        val base = snapshot()
        val forecast = base.copy(calendar = base.calendar.copy(sunset = at(base, 18)))
        val groups = render(forecast, 18).groups
        assertTrue(groups.first().isNow)
        assertTrue(groups.all { it.isNight })
        assertTrue(groups.first().accessibilityLabel().contains("clear"))
        assertFalse(groups.first().accessibilityLabel().contains("sunny"))
    }

    // decode the same strict wire data used for boundary rejection tests
    private fun snapshot(date: String = "2026-09-12"): WidgetForecastSnapshot = WidgetForecastDecoder.decode(json(date).toByteArray())

    // render an elapsed fixture hour in a chosen display unit
    private fun render(snapshot: WidgetForecastSnapshot, hour: Int, unit: TemperatureUnit = TemperatureUnit.FAHRENHEIT): WidgetPresentation =
        WidgetSemanticRenderer.render(snapshot, at(snapshot, hour), unit)

    // avoid assuming twenty-four-hour calendar days in fixture calculations
    private fun at(snapshot: WidgetForecastSnapshot, hour: Int): Instant = snapshot.calendar.dayStart.plusSeconds(hour * 3600L)

    // provide paired raw source metadata for semantic-only fixture edits
    private fun raw(value: Double): ForecastField = ForecastField(
        ForecastMode.RAW, value, ForecastSource(Instant.parse("2026-09-12T14:00:00Z"), Instant.parse("2026-09-12T14:00:00Z")),
        "raw_forecast", value, null, null,
    )

    // construct a closed v3 response with genuine site-calendar boundaries
    private fun json(dateText: String, generated: Instant? = null): String {
        val date = LocalDate.parse(dateText)
        val start = date.atStartOfDay(zone).toInstant()
        val end = date.plusDays(1).atTime(7, 0).atZone(zone).toInstant()
        val generatedAt = generated ?: date.atTime(12, 0).atZone(zone).toInstant()
        val clock = instantFormat.format(generatedAt)
        // bind each numeric field to the real generation clock
        fun field(value: Int): String = """{"mode":"raw","raw":$value,"rawSource":{"runAt":"$clock","receivedAt":"$clock"},"reason":"raw_forecast","selected":$value,"selectedSource":null,"selectedUntil":null}"""
        val hours = (0 until Duration.between(start, end).toHours()).joinToString(",") { hour ->
            val from = instantFormat.format(start.plusSeconds(hour * 3600))
            val to = instantFormat.format(start.plusSeconds((hour + 1) * 3600))
            """{"start":"$from","end":"$to","temperatureC":${field(15)},"rainMmPerHour":${field(0)},"cloudCoverPercent":${field(0)},"windSpeedMps":${field(1)}}"""
        }
        return """{"schemaVersion":"weather-widget/v3","generatedAt":"$clock","receivedAt":"$clock","calendar":{"date":"$dateText","dayStart":"${instantFormat.format(start)}","dayEnd":"${instantFormat.format(date.plusDays(1).atStartOfDay(zone).toInstant())}","cutoff":"${instantFormat.format(date.atTime(20, 0).atZone(zone).toInstant())}","sunset":null,"overnightEnd":"${instantFormat.format(end)}"},"hours":[$hours],"status":"raw","attribution":{"label":"Open-Meteo · CC BY 4.0","licenseUrl":"https://creativecommons.org/licenses/by/4.0/","providerUrl":"https://open-meteo.com/"},"site":{"latitude":47.950429954185445,"longitude":-122.42797012608193,"name":"Ballydidean","slug":"ballydidean","timezone":"America/Los_Angeles"}}"""
    }
}
