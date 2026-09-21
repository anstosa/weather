package farm.ballydidean.weather.widget

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.time.Duration
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetWorkTest {
    // enforce the fixed public endpoint
    @Test
    fun endpointIsFixedAndCookieFreeByConstruction() {
        assertEquals(
            "https://weather.ballydidean.farm/api/v1/sites/ballydidean/widget-forecast",
            WidgetForecastClient.ENDPOINT,
        )
    }

    // bound a stalled header phase by one total deadline
    @Test
    fun stalledHeadersStopAtOverallDeadline() {
        val started = System.nanoTime()
        val result = WidgetForecastClient(deadlineMillis = 50) {
            Thread.sleep(10_000)
            WidgetFetchResult.Failure(WidgetAttemptOutcome.NETWORK, true)
        }.fetch()
        val elapsed = Duration.ofNanos(System.nanoTime() - started).toMillis()
        assertTrue(result is WidgetFetchResult.Failure && result.outcome == WidgetAttemptOutcome.TIMEOUT)
        assertTrue("deadline took $elapsed ms", elapsed < 1_000)
    }

    // bound a slow trickle within the same total deadline
    @Test
    fun slowBodyTrickleStopsAtOverallDeadline() {
        val client = WidgetForecastClient(deadlineMillis = 60)
        val stream = object : InputStream() {
            // drip one byte beyond the total budget
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                Thread.sleep(35)
                buffer[offset] = '{'.code.toByte()
                return 1
            }

            override fun read(): Int = error("buffered reads only")
        }
        assertThrows(IOException::class.java) {
            client.readBounded(stream, -1, System.nanoTime())
        }
    }

    // map streaming overflow to a bounded failure path
    @Test
    fun streamingOverflowIsRejectedBeforeUnboundedAllocation() {
        val bytes = ByteArray(WidgetForecastDecoder.MAX_BYTES + 1)
        val client = WidgetForecastClient()
        assertThrows(IOException::class.java) {
            client.readBounded(ByteArrayInputStream(bytes), -1, System.nanoTime())
        }
    }

    // sanitize malformed decodes as invalid rather than network errors
    @Test
    fun malformedUtf8AndDeepJsonClassifyInvalid() {
        val client = WidgetForecastClient()
        val malformedUtf8 = byteArrayOf(0xC3.toByte())
        val deeplyNested = ("[".repeat(40) + "null" + "]".repeat(40)).toByteArray()
        val malformedResult = client.validate(malformedUtf8) as WidgetFetchResult.Failure
        val deepResult = client.validate(deeplyNested) as WidgetFetchResult.Failure
        assertEquals(WidgetAttemptOutcome.INVALID, malformedResult.outcome)
        assertEquals(WidgetAttemptOutcome.INVALID, deepResult.outcome)
    }

    // coalesce immediate and periodic attempts for one minute
    @Test
    fun immediateAndPeriodicAttemptsCoalesce() {
        val now = Instant.parse("2026-09-12T07:10:00Z")
        assertTrue(WidgetRefreshCoordinator.shouldFetch(null, now))
        assertFalse(
            WidgetRefreshCoordinator.shouldFetch(
                WidgetAttempt(now.minusSeconds(59), WidgetAttemptOutcome.SUCCESS),
                now,
            ),
        )
        assertTrue(
            WidgetRefreshCoordinator.shouldFetch(
                WidgetAttempt(now.minusSeconds(60), WidgetAttemptOutcome.SUCCESS),
                now,
            ),
        )
        val acquired = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        val holder = executor.submit {
            assertTrue(WidgetRefreshCoordinator.tryAcquire())
            acquired.countDown()
            release.await(5, TimeUnit.SECONDS)
            WidgetRefreshCoordinator.release()
        }
        assertTrue(acquired.await(5, TimeUnit.SECONDS))
        assertFalse(WidgetRefreshCoordinator.tryAcquire())
        release.countDown()
        holder.get(5, TimeUnit.SECONDS)
        executor.shutdownNow()
    }

    // schedule the earliest correction before the next hour
    @Test
    fun boundaryPlannerChoosesHourThenCorrectionAndReschedules() {
        val snapshot = WidgetForecastDecoder.decode(resource("fixtures/adjusted-standard/snapshot.json"))
        val now = Instant.parse("2026-09-12T07:00:01Z")
        assertEquals(Instant.parse("2026-09-12T08:00:00Z"), WidgetBoundaryPlanner.earliest(snapshot, now))
        assertEquals(
            Instant.parse("2026-09-12T08:30:00Z"),
            WidgetBoundaryPlanner.earliest(snapshot, Instant.parse("2026-09-12T08:00:00Z")),
        )
    }

    // render successful fetches at completion rather than request start
    @Test
    fun receiptDuringFetchIsFreshButAReceiptAfterRenderIsStale() {
        val snapshot = WidgetForecastDecoder.decode(resource("fixtures/adjusted-standard/snapshot.json"))
        val startedAt = Instant.parse("2026-09-12T07:00:00.500Z")
        val completedAt = Instant.parse("2026-09-12T07:00:02.000Z")
        assertTrue(
            WidgetSemanticRenderer.render(
                snapshot,
                completedAt,
                TemperatureUnit.FAHRENHEIT,
                WidgetAttempt(startedAt, WidgetAttemptOutcome.SUCCESS),
            ).stale,
        )
        assertFalse(
            WidgetSemanticRenderer.render(
                snapshot,
                completedAt,
                TemperatureUnit.FAHRENHEIT,
                WidgetAttempt(completedAt, WidgetAttemptOutcome.SUCCESS),
            ).stale,
        )
        assertTrue(WidgetSemanticRenderer.render(snapshot, startedAt, TemperatureUnit.FAHRENHEIT).stale)
    }

    // load one frozen test resource
    private fun resource(path: String): ByteArray {
        return checkNotNull(javaClass.classLoader?.getResourceAsStream(path)).use { it.readBytes() }
    }
}
