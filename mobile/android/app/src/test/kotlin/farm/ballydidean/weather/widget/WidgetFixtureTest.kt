package farm.ballydidean.weather.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetFixtureTest {
    // prove maximum density preserves all real intervals
    @Test
    fun maximumDensityCoversTwentyOneIntervalsExactlyOnce() {
        val fixture = WidgetFixture.forVariant(FixtureVariant.MAXIMUM)
        assertEquals((0..20).toList(), fixture.coveredIntervals())
        assertEquals(7, fixture.groups.size)
        assertTrue(fixture.groups.all { it.intervalIndexes.size in 1..3 })
        assertTrue(fixture.groups.first().hourLabel.contains("1a"))
        assertTrue(fixture.groups.first().hourLabel.contains("1b"))
    }

    // prove near-cutoff weather keeps bedtime space
    @Test
    fun nearCutoffKeepsWeatherAndBedtime() {
        val fixture = WidgetFixture.forVariant(FixtureVariant.NEAR_CUTOFF)
        assertEquals(listOf(18, 19), fixture.coveredIntervals())
        assertTrue(fixture.showBedtime)
        assertTrue(fixture.showCredit)
    }

    // prove post-cutoff state contains no invented weather
    @Test
    fun allBedtimeContainsNoWeather() {
        val fixture = WidgetFixture.forVariant(FixtureVariant.ALL_BEDTIME)
        assertTrue(fixture.groups.isEmpty())
        assertTrue(fixture.showBedtime)
        assertFalse(fixture.showCredit)
    }

    // prove all three rain classes remain represented
    @Test
    fun maximumDensityIncludesEveryRainCondition() {
        val conditions = WidgetFixture.forVariant(FixtureVariant.MAXIMUM).groups.map { it.condition }.toSet()
        assertEquals(RainCondition.entries.toSet(), conditions)
    }

    // prove celsius keeps the same timeline
    @Test
    fun celsiusRetainsMaximumCoverage() {
        val fahrenheit = WidgetFixture.forVariant(FixtureVariant.MAXIMUM)
        val celsius = WidgetFixture.forVariant(FixtureVariant.CELSIUS)
        assertEquals(fahrenheit.coveredIntervals(), celsius.coveredIntervals())
        assertTrue(celsius.groups.all { it.temperatureLabel.endsWith("°") })
    }
}
