package farm.ballydidean.weather.widget

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetForecastTest {
    private val fixtureNames = listOf(
        "adjusted-standard",
        "fall-back-25",
        "midnight-race",
        "missing-raw-at-expiry",
        "spring-forward-23",
        "stale-old-source",
    )

    // preserve legacy data calendars expiry and provenance through the redesigned row
    @Test
    fun sharedFixturesPreserveCalendarFreshnessAndCompleteCoverage() {
        // compare all frozen cross-platform cases
        for (name in fixtureNames) {
            val snapshot = WidgetForecastDecoder.decode(resource("fixtures/$name/snapshot.json"))
            val expected = StrictJson.parse(resource("fixtures/$name/expected.json")) as JsonObject
            val unit = when (expected.string("unit")) {
                "celsius" -> TemperatureUnit.CELSIUS
                else -> TemperatureUnit.FAHRENHEIT
            }
            val now = Instant.parse(expected.string("now"))
            val presentation = WidgetSemanticRenderer.render(snapshot, now, unit)
            assertEquals(name, expected.string("date"), presentation.date)
            assertEquals(name, expected.string("status"), presentation.status.wireName())
            assertEquals(name, expected.string("presentation"), presentation.mode.name.lowercase())
            assertEquals(name, (expected.values.getValue("stale") as JsonBoolean).value, presentation.stale)
            assertEquals(name, (expected.values.getValue("hardExpired") as JsonBoolean).value, presentation.hardExpired)
            val expectedGroups = expected.array("groups").map { it as JsonObject }
            assertTrue(name, presentation.groups.size <= 5)
            assertEquals(name, expectedGroups.sumOf { it.number("hourCount").toInt() }, presentation.groups.sumOf { it.hourCount })
            assertEquals(name, expectedGroups.firstOrNull()?.string("start"), presentation.groups.firstOrNull()?.start.toStringWithMillis())
            assertEquals(name, expectedGroups.lastOrNull()?.string("end"), presentation.groups.lastOrNull()?.end.toStringWithMillis())
            val expectedFooter = expected.objectValue("footer")
            assertEquals(name, expectedFooter.string("status"), presentation.status.wireName())
            val expectedSunset = expectedFooter.values.getValue("sunset")
            // compare the hard-expiry sunset boundary
            if (expectedSunset === JsonNull) {
                assertNull(name, presentation.sunset)
            } else {
                assertEquals(name, (expectedSunset as JsonString).value, presentation.sunset.toStringWithMillis())
            }
        }
    }

    // reject malformed closed-contract inputs
    @Test
    fun decoderFailsClosedForUnknownDuplicateAndOversizedJson() {
        val valid = resource("fixtures/adjusted-standard/snapshot.json")
        val text = valid.toString(Charsets.UTF_8)
        val unknown = text.replaceFirst("{", "{\"privateId\":\"secret\",")
        val duplicate = text.replaceFirst("{", "{\"schemaVersion\":\"weather-widget/v1\",")
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(unknown.toByteArray()) }
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(duplicate.toByteArray()) }
        assertThrows(IllegalArgumentException::class.java) {
            WidgetForecastDecoder.decode(ByteArray(WidgetForecastDecoder.MAX_BYTES + 1) { ' '.code.toByte() })
        }
    }

    // reject malformed utf-8 and bounded-depth attacks
    @Test
    fun decoderRejectsMalformedUtf8AndDeepNesting() {
        val malformedUtf8 = byteArrayOf('{'.code.toByte(), '"'.code.toByte(), 0xC3.toByte(), '"'.code.toByte(), '}'.code.toByte())
        val deeplyNested = "[".repeat(40) + "null" + "]".repeat(40)
        assertThrows(Exception::class.java) { WidgetForecastDecoder.decode(malformedUtf8) }
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(deeplyNested.toByteArray()) }
    }

    // reject calendar and mode invariant changes
    @Test
    fun decoderRejectsRolloverStatusAndRawPairingChanges() {
        val text = resource("fixtures/adjusted-standard/snapshot.json").toString(Charsets.UTF_8)
        val rollover = text.replace("2026-09-12T07:00:00.000Z", "2026-02-30T07:00:00.000Z")
        val status = text.replaceFirst("\"status\": \"adjusted\"", "\"status\": \"raw\"")
        val brokenPair = text.replaceFirst(Regex("\"rawSource\": \\{[^}]+}"), "\"rawSource\": null")
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(rollover.toByteArray()) }
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(status.toByteArray()) }
        assertThrows(IllegalArgumentException::class.java) { WidgetForecastDecoder.decode(brokenPair.toByteArray()) }
    }

    // demote value and provenance together at equality
    @Test
    fun correctionExpiryEqualityDemotesOrBecomesUnavailable() {
        val snapshot = WidgetForecastDecoder.decode(resource("fixtures/missing-raw-at-expiry/snapshot.json"))
        val field = snapshot.hours[9].temperatureC
        val before = WidgetSemanticRenderer.effective(field, Instant.parse("2026-09-12T15:59:59.999Z"), false)
        val equality = WidgetSemanticRenderer.effective(field, Instant.parse("2026-09-12T16:00:00.000Z"), false)
        assertEquals(ForecastMode.ADJUSTED, before.mode)
        assertEquals(field.selectedSource, before.source)
        assertEquals(ForecastMode.UNAVAILABLE, equality.mode)
        assertNull(equality.source)
    }

    // make persisted attempt clocks conservative without altering pure golden mode
    @Test
    fun failedMissingAndImpossibleAttemptsAreStale() {
        val snapshot = WidgetForecastDecoder.decode(resource("fixtures/adjusted-standard/snapshot.json"))
        val now = Instant.parse("2026-09-12T07:00:01.000Z")
        assertFalse(WidgetSemanticRenderer.render(snapshot, now, TemperatureUnit.FAHRENHEIT).stale)
        assertTrue(
            WidgetSemanticRenderer.render(
                snapshot,
                now,
                TemperatureUnit.FAHRENHEIT,
                WidgetAttempt(now, WidgetAttemptOutcome.NETWORK),
            ).stale,
        )
        assertTrue(
            WidgetSemanticRenderer.render(
                snapshot,
                now,
                TemperatureUnit.FAHRENHEIT,
                WidgetAttempt(now.plusSeconds(1), WidgetAttemptOutcome.SUCCESS),
            ).stale,
        )
        assertTrue(
            WidgetSemanticRenderer.render(
                snapshot,
                now,
                TemperatureUnit.FAHRENHEIT,
                WidgetAttempt(snapshot.receivedAt.minusMillis(1), WidgetAttemptOutcome.SUCCESS),
            ).stale,
        )
    }

    // decode real condition fields without relaxing either version's closed shape
    @Test
    fun v2RequiresBoundedCloudAndWindWithCorrectAggregateStatus() {
        val source = resource("fixtures/adjusted-standard/snapshot.json").toString(Charsets.UTF_8)
        val field = """{"mode":"raw","raw":25,"rawSource":{"runAt":null,"receivedAt":"2026-09-12T06:00:00.000Z"},"reason":"raw_forecast","selected":25,"selectedSource":null,"selectedUntil":null}"""
        val v2 = source.replace("weather-widget/v1", "weather-widget/v2")
            .replace("\"temperatureC\":", "\"cloudCoverPercent\":$field,\"windSpeedMps\":$field,\"temperatureC\":")
            .replaceFirst("\"status\": \"adjusted\"", "\"status\": \"mixed\"")
        val snapshot = WidgetForecastDecoder.decode(v2.toByteArray())
        assertEquals(25.0, snapshot.hours.first().cloudCoverPercent!!.raw!!, 0.0)
        assertEquals(25.0, snapshot.hours.first().windSpeedMps!!.raw!!, 0.0)
        assertEquals(ForecastStatus.MIXED, snapshot.status)
        assertThrows(IllegalArgumentException::class.java) {
            WidgetForecastDecoder.decode(v2.replace("weather-widget/v2", "weather-widget/v1").toByteArray())
        }
        assertThrows(IllegalArgumentException::class.java) {
            WidgetForecastDecoder.decode(source.replace("weather-widget/v1", "weather-widget/v2").toByteArray())
        }
        assertThrows(IllegalArgumentException::class.java) {
            WidgetForecastDecoder.decode(v2.replace("\"raw\":25", "\"raw\":101").toByteArray())
        }
    }

    // load one frozen test resource
    private fun resource(path: String): ByteArray {
        return checkNotNull(javaClass.classLoader?.getResourceAsStream(path)) { "missing resource $path" }.use { it.readBytes() }
    }

    // retain the public millisecond spelling
    private fun Instant?.toStringWithMillis(): String? {
        return this?.let {
            val value = it.toString()
            if (value.length == 20) value.replace("Z", ".000Z") else value
        }
    }
}
