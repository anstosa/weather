package farm.ballydidean.weather.widget

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetRedesignTest {
    // admit six panels at the tighter width without dropping any forecast hours
    @Test
    fun fullWidthPixelAllocationFitsSixPanels() {
        assertEquals(5, WidgetRowGeometry.capacity(276))
        assertEquals(5, WidgetRowGeometry.capacity(383))
        assertEquals(6, WidgetRowGeometry.capacity(384))
        assertEquals(6, WidgetRowGeometry.capacity(387))
        val capacity = WidgetRowGeometry.capacity(387)
        val morning = WidgetSemanticRenderer.render(snapshot(), at(7), TemperatureUnit.FAHRENHEIT, maxSegments = capacity)
        assertEquals(listOf("Now", "8am", "11am", "2pm", "5pm", "7pm"), morning.groups.map { it.hourLabel })
        assertEquals(13, morning.groups.sumOf { it.hourCount })
        assertEquals(1.0 / 6, WidgetRowGeometry.weatherFraction(morning), 0.0)
        assertFalse(morning.showBedtime)
        val afternoon = WidgetSemanticRenderer.render(snapshot(), at(14), TemperatureUnit.FAHRENHEIT, maxSegments = capacity)
        assertEquals(listOf("Now", "3pm", "4pm", "5pm", "6pm", "7pm"), afternoon.groups.map { it.hourLabel })
        assertTrue(afternoon.groups.all { it.hourCount == 1 })
    }

    // cover every hour and width without wrapping or oversized panels
    @Test
    fun groupingKeepsNowSeparateAndEveryFutureHourExactlyOnce() {
        val snapshot = snapshot()
        // exercise narrow through tablet-sized rows
        for (requestedCapacity in 1..10) {
            val capacity = maxOf(5, requestedCapacity)
            // cover the complete pre-cutoff day
            for (hour in 0..19) {
                val presentation = WidgetSemanticRenderer.render(
                    snapshot, at(hour), TemperatureUnit.FAHRENHEIT, maxSegments = requestedCapacity,
                )
                val groups = presentation.groups
                assertEquals("Now", groups.first().hourLabel)
                assertEquals(1, groups.first().hourCount)
                assertEquals(at(hour), groups.first().start)
                assertEquals(at(20), groups.last().end)
                assertEquals(20 - hour, groups.sumOf { it.hourCount })
                assertEquals(minOf(20 - hour, capacity), groups.size)
                assertEquals(hour >= 16, presentation.showBedtime)
                assertTrue(WidgetRowGeometry.weatherFraction(presentation) <= 0.2)
                // reject gaps and overlapping membership
                for ((left, right) in groups.zipWithNext()) {
                    assertEquals(left.end, right.start)
                }
                // ensure no smaller future range would have fit
                val duration = groups.drop(1).firstOrNull()?.hourCount ?: 1
                if (duration > 1) {
                    val narrowerCount = 1 + kotlin.math.ceil((19 - hour).toDouble() / (duration - 1)).toInt()
                    assertTrue(narrowerCount > capacity)
                }
            }
        }
    }

    // show overnight at four pm and grow it by one fifth every following hour
    @Test
    fun overnightFirstAppearsAtFourPmAndFillsUnusedFifths() {
        val snapshot = snapshot()
        // preserve the exact boundary across minimum pixel and wide allocations
        for (capacity in listOf(4, 5, 6, 8)) {
            val before = WidgetSemanticRenderer.render(snapshot, at(16).minusSeconds(1), TemperatureUnit.FAHRENHEIT, maxSegments = capacity)
            assertFalse(before.showBedtime)
            assertEquals(listOf("Now", "4pm", "5pm", "6pm", "7pm"), before.groups.map { it.hourLabel })
            // keep each daytime hour separate once overnight starts growing
            for (hour in 16..19) {
                val presentation = WidgetSemanticRenderer.render(snapshot, at(hour), TemperatureUnit.FAHRENHEIT, maxSegments = capacity)
                assertTrue(presentation.showBedtime)
                assertEquals(listOf("Now") + (hour + 1..19).map { "${it - 12}pm" }, presentation.groups.map { it.hourLabel })
                assertTrue(presentation.groups.all { it.hourCount == 1 })
                val fraction = WidgetRowGeometry.weatherFraction(presentation)
                assertEquals(0.2, fraction, 0.0)
                assertEquals((hour - 15) / 5.0, 1 - presentation.groups.size * fraction, 0.0001)
            }
        }
        val bedtime = WidgetSemanticRenderer.render(snapshot, at(20), TemperatureUnit.FAHRENHEIT)
        assertEquals(WidgetPresentationMode.BEDTIME, bedtime.mode)
        assertTrue(bedtime.groups.isEmpty())
        assertEquals("—", bedtime.message)
    }

    // choose extrema and tone from one unrounded celsius value regardless of display unit
    @Test
    fun temperatureSelectsHighLowOrMeanBeforeToneAndRounding() {
        // use two-hour future blocks at noon
        for ((values, labels, expectedTone) in listOf(
            Triple(listOf(64.0, 68.0), "68°" to "20°", WidgetTemperatureTone.NEUTRAL),
            Triple(listOf(48.0, 50.0), "48°" to "9°", WidgetTemperatureTone.COLD),
            Triple(listOf(60.0, 64.0), "62°" to "17°", WidgetTemperatureTone.NEUTRAL),
            Triple(listOf(49.0, 51.0), "50°" to "10°", WidgetTemperatureTone.COLD),
            Triple(listOf(54.8, 55.0), "55°" to "13°", WidgetTemperatureTone.COLD),
            Triple(listOf(54.0, 56.0), "55°" to "13°", WidgetTemperatureTone.NEUTRAL),
            Triple(listOf(66.0, 82.0), "82°" to "28°", WidgetTemperatureTone.HOT),
            Triple(listOf(40.0, 58.0), "40°" to "4°", WidgetTemperatureTone.COLD),
            Triple(listOf(64.0, 66.0), "65°" to "18°", WidgetTemperatureTone.NEUTRAL),
            Triple(listOf(70.2, 70.4), "70°" to "21°", WidgetTemperatureTone.WARM),
            Triple(listOf(80.2, 80.4), "80°" to "27°", WidgetTemperatureTone.HOT),
        )) {
            val snapshot = snapshot().let { original ->
                original.copy(hours = original.hours.mapIndexed { index, hour ->
                    hour.copy(temperatureC = raw((values[(index - 13).mod(2)] - 32) * 5 / 9))
                })
            }
            val fahrenheit = WidgetSemanticRenderer.render(snapshot, at(12), TemperatureUnit.FAHRENHEIT, maxSegments = 5)
            val celsius = WidgetSemanticRenderer.render(snapshot, at(12), TemperatureUnit.CELSIUS, maxSegments = 5)
            assertEquals("1pm", fahrenheit.groups[1].hourLabel)
            assertEquals(2, fahrenheit.groups[1].hourCount)
            assertEquals(labels.first, fahrenheit.groups[1].temperatureLabel)
            assertEquals(labels.second, celsius.groups[1].temperatureLabel)
            assertEquals(expectedTone, fahrenheit.groups[1].temperatureTone)
            assertEquals(expectedTone, celsius.groups[1].temperatureTone)
        }
    }

    // match the 55f website cutoff before rounding in either display unit
    @Test
    fun temperatureToneUsesInclusiveNeutralAndWarmBoundaries() {
        assertEquals(WidgetTemperatureTone.NEUTRAL, WidgetTemperatureTone.fromCelsius(null))
        // classify finite values only after exact fahrenheit-to-celsius conversion
        for ((fahrenheit, expected) in listOf(
            Double.NEGATIVE_INFINITY to WidgetTemperatureTone.NEUTRAL,
            49.999 to WidgetTemperatureTone.COLD,
            50.0 to WidgetTemperatureTone.COLD,
            54.999 to WidgetTemperatureTone.COLD,
            55.0 to WidgetTemperatureTone.NEUTRAL,
            55.001 to WidgetTemperatureTone.NEUTRAL,
            70.0 to WidgetTemperatureTone.NEUTRAL,
            70.001 to WidgetTemperatureTone.WARM,
            80.0 to WidgetTemperatureTone.WARM,
            80.001 to WidgetTemperatureTone.HOT,
            Double.POSITIVE_INFINITY to WidgetTemperatureTone.NEUTRAL,
            Double.NaN to WidgetTemperatureTone.NEUTRAL,
        )) {
            assertEquals(expected, WidgetTemperatureTone.fromCelsius((fahrenheit - 32.0) * 5.0 / 9.0))
        }
    }

    // classify real sky rain and wind independently without sunny fallback
    @Test
    fun conditionsCoverCloudRainWindAndUnknownData() {
        // exercise every icon boundary
        for ((cloud, rain, expected) in listOf(
            Triple(0.0, 0.0, WeatherCondition.SUNNY),
            Triple(25.0, 0.0, WeatherCondition.PARTLY_CLOUDY),
            Triple(75.0, 0.0, WeatherCondition.CLOUDY),
            Triple(0.0, 0.01, WeatherCondition.LIGHT_RAIN),
            Triple(0.0, 2.5, WeatherCondition.HEAVY_RAIN),
        )) {
            val snapshot = snapshot().let { original ->
                original.copy(hours = original.hours.map { hour ->
                    hour.copy(cloudCoverPercent = raw(cloud), rainMmPerHour = raw(rain), windSpeedMps = raw(8.9408))
                })
            }
            val group = WidgetSemanticRenderer.render(snapshot, at(12), TemperatureUnit.FAHRENHEIT).groups.first()
            assertEquals(expected, group.weatherCondition)
            assertTrue(group.highWind)
        }
        val unknown = snapshot().let { original ->
            original.copy(hours = original.hours.map { it.copy(cloudCoverPercent = null, windSpeedMps = null) })
        }
        val group = WidgetSemanticRenderer.render(unknown, at(12), TemperatureUnit.FAHRENHEIT).groups.first()
        assertEquals(WeatherCondition.UNAVAILABLE, group.weatherCondition)
        assertFalse(group.highWind)
    }

    // shade only non-current forecast time in a five-panel multi-hour row
    @Test
    fun postSunsetShadingStartsAtTheExactNonNowGroupFraction() {
        val presentation = WidgetSemanticRenderer.render(snapshot(), at(14), TemperatureUnit.FAHRENHEIT, maxSegments = 5)
        val current = presentation.groups.first()
        val spanning = presentation.groups[1]
        val afterSunset = presentation.groups[2]
        assertEquals(at(15), spanning.start)
        assertEquals(at(17), spanning.end)
        // never darken the current segment
        assertNull(WidgetRowGeometry.postSunsetStartFraction(current, at(14).plusSeconds(1_800)))
        // keep absent and post-block sunsets unshaded
        assertNull(WidgetRowGeometry.postSunsetStartFraction(spanning, null))
        assertNull(WidgetRowGeometry.postSunsetStartFraction(spanning, spanning.end))
        assertNull(WidgetRowGeometry.postSunsetStartFraction(spanning, spanning.end.plusSeconds(1)))
        // darken the whole forecast segment after an earlier sunset
        assertEquals(0.0, WidgetRowGeometry.postSunsetStartFraction(afterSunset, at(16))!!, 0.0)
        assertEquals(0.0, WidgetRowGeometry.postSunsetStartFraction(spanning, spanning.start)!!, 0.0)
        // begin fractional shading at the real instant within a multi-hour block
        assertEquals(0.5, WidgetRowGeometry.postSunsetStartFraction(spanning, at(16))!!, 0.0001)
    }

    // expire adjusted icon and temperature inputs without extending their deadline
    @Test
    fun weatherCorrectionsExpireAndScheduleTheirOwnRepaint() {
        val deadline = at(12).plusSeconds(30)
        val snapshot = snapshot().let { original ->
            original.copy(hours = original.hours.map { hour ->
                hour.copy(
                    temperatureC = raw(0.0).copy(
                        mode = ForecastMode.ADJUSTED,
                        selected = 30.0,
                        selectedSource = ForecastSource(at(0), at(0)),
                        selectedUntil = deadline,
                        reason = "generic_adjustment",
                    ),
                    windSpeedMps = raw(1.0).copy(
                        mode = ForecastMode.ADJUSTED,
                        selected = 12.0,
                        selectedSource = ForecastSource(at(0), at(0)),
                        selectedUntil = deadline,
                        reason = "generic_adjustment",
                    ),
                )
            })
        }
        val adjusted = WidgetSemanticRenderer.render(snapshot, at(12), TemperatureUnit.FAHRENHEIT).groups.first()
        val expired = WidgetSemanticRenderer.render(snapshot, deadline, TemperatureUnit.FAHRENHEIT).groups.first()
        assertTrue(adjusted.highWind)
        assertEquals(WidgetTemperatureTone.HOT, adjusted.temperatureTone)
        assertFalse(expired.highWind)
        assertEquals(WidgetTemperatureTone.COLD, expired.temperatureTone)
        assertEquals(deadline, WidgetBoundaryPlanner.earliest(snapshot, at(12).plusSeconds(1)))
    }

    // keep missing temperature honest even when a block otherwise has readings
    @Test
    fun partialTemperaturesDoNotProduceMisleadingAverages() {
        val snapshot = snapshot().let { original ->
            original.copy(hours = original.hours.mapIndexed { index, hour ->
                // remove one hour inside the first rolled-up future block
                if (index == 14) hour.copy(temperatureC = ForecastField(
                    ForecastMode.UNAVAILABLE, null, null, "missing", null, null, null,
                )) else hour
            })
        }
        val group = WidgetSemanticRenderer.render(snapshot, at(12), TemperatureUnit.FAHRENHEIT, maxSegments = 5).groups[1]
        assertEquals("—", group.temperatureLabel)
        assertEquals(WidgetTemperatureTone.NEUTRAL, group.temperatureTone)
        assertNull(group.minimumTemperature)
        assertNull(group.maximumTemperature)
    }

    // construct a current-day raw snapshot with known condition inputs
    private fun snapshot(): WidgetForecastSnapshot {
        val source = checkNotNull(javaClass.classLoader?.getResourceAsStream("fixtures/adjusted-standard/snapshot.json"))
        val original = source.use { WidgetForecastDecoder.decode(it.readBytes()) }
        return original.copy(hours = original.hours.map { hour ->
            hour.copy(temperatureC = raw(18.0), rainMmPerHour = raw(0.0), cloudCoverPercent = raw(0.0), windSpeedMps = raw(1.0))
        }, status = ForecastStatus.RAW)
    }

    // use paired values and source clocks
    private fun raw(value: Double): ForecastField {
        return ForecastField(ForecastMode.RAW, value, ForecastSource(at(0), at(0)), "raw_forecast", value, null, null)
    }

    // use the fixture's summer local midnight
    private fun at(hour: Int): Instant = Instant.parse("2026-09-12T07:00:00Z").plusSeconds(hour * 3600L)
}
