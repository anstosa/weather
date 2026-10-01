package farm.ballydidean.weather.widget

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetHourTicksTest {
    // omit ticks when no interior elapsed-hour boundary exists
    @Test
    fun oneHourAndInvalidRangesHaveNoTicks() {
        val start = Instant.parse("2026-09-12T14:00:00Z")
        assertEquals(emptyList<Double>(), WidgetRowGeometry.hourTickFractions(start, start.plusSeconds(3_600)))
        assertEquals(emptyList<Double>(), WidgetRowGeometry.hourTickFractions(start, start.plusSeconds(3_599)))
        assertEquals(emptyList<Double>(), WidgetRowGeometry.hourTickFractions(start, start))
        assertEquals(emptyList<Double>(), WidgetRowGeometry.hourTickFractions(start, start.minusSeconds(1)))
    }

    // divide whole multi-hour ranges at each interior elapsed hour
    @Test
    fun twoAndThreeHourRangesUseEvenInteriorFractions() {
        val start = Instant.parse("2026-09-12T14:00:00Z")
        assertEquals(listOf(0.5), WidgetRowGeometry.hourTickFractions(start, start.plusSeconds(7_200)))
        assertEquals(
            listOf(1.0 / 3.0, 2.0 / 3.0),
            WidgetRowGeometry.hourTickFractions(start, start.plusSeconds(10_800)),
        )
    }

    // retain elapsed-hour spacing inside a range with an uneven final remainder
    @Test
    fun partialFinalHourUsesProportionalPositions() {
        val start = Instant.parse("2026-09-12T14:00:00Z")
        val ticks = WidgetRowGeometry.hourTickFractions(start, start.plusSeconds(9_000))
        assertEquals(2, ticks.size)
        assertEquals(0.4, ticks[0], 0.000_001)
        assertEquals(0.8, ticks[1], 0.000_001)
        assertTrue(ticks.all { it > 0.0 && it < 1.0 })
    }

    // count real elapsed overnight hours across both daylight-saving transitions
    @Test
    fun overnightTicksFollowRealElapsedDstHours() {
        val zone = ZoneId.of("America/Los_Angeles")
        // cover ordinary spring-forward and fall-back nights
        for ((date, elapsedHours) in listOf(
            LocalDate.parse("2026-09-12") to 11,
            LocalDate.parse("2026-03-07") to 10,
            LocalDate.parse("2026-10-31") to 12,
        )) {
            val start = date.atTime(LocalTime.of(20, 0)).atZone(zone).toInstant()
            val end = date.plusDays(1).atTime(LocalTime.of(7, 0)).atZone(zone).toInstant()
            val ticks = WidgetRowGeometry.hourTickFractions(start, end)
            assertEquals(elapsedHours - 1, ticks.size)
            // keep every tick strictly inside the overnight segment
            for ((index, fraction) in ticks.withIndex()) {
                assertEquals((index + 1).toDouble() / elapsedHours, fraction, 0.000_001)
                assertTrue(fraction > 0.0 && fraction < 1.0)
            }
        }
    }
}
