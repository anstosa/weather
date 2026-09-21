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

    // decode and reproduce every shared semantic golden
    @Test
    fun sharedFixturesMatchNativeSemantics() {
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
            assertEquals(name, (expected.values.getValue("bedtime") as JsonBoolean).value, presentation.showBedtime)
            assertEquals(name, (expected.values.getValue("stale") as JsonBoolean).value, presentation.stale)
            assertEquals(name, (expected.values.getValue("hardExpired") as JsonBoolean).value, presentation.hardExpired)
            assertGroups(name, expected.array("groups"), presentation.groups)
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

    // verify one normalized group list
    private fun assertGroups(name: String, expected: List<JsonValue>, actual: List<WidgetGroup>) {
        assertEquals(name, expected.size, actual.size)
        // compare every public semantic member
        for (index in expected.indices) {
            val expectedGroup = expected[index] as JsonObject
            val actualGroup = actual[index]
            assertEquals(name, expectedGroup.string("start"), actualGroup.start.toStringWithMillis())
            assertEquals(name, expectedGroup.string("end"), actualGroup.end.toStringWithMillis())
            assertEquals(name, expectedGroup.number("hourCount").toInt(), actualGroup.hourCount)
            assertEquals(name, (expectedGroup.values.getValue("isNow") as JsonBoolean).value, actualGroup.isNow)
            assertEquals(name, expectedGroup.string("status"), actualGroup.status.wireName())
            assertEquals(name, expectedGroup.string("condition"), actualGroup.condition.name.lowercase())
            val expectedTemperature = expectedGroup.values.getValue("temperature")
            // preserve missing group temperature explicitly
            if (expectedTemperature === JsonNull) {
                assertNull(name, actualGroup.minimumTemperature)
                assertNull(name, actualGroup.maximumTemperature)
                assertEquals(name, "—", actualGroup.temperatureLabel)
            } else {
                val range = expectedTemperature as JsonObject
                assertEquals(name, range.number("minimum").toInt(), actualGroup.minimumTemperature)
                assertEquals(name, range.number("maximum").toInt(), actualGroup.maximumTemperature)
                assertEquals(name, range.string("label"), actualGroup.temperatureLabel.removeSuffix("°"))
            }
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
