package farm.ballydidean.weather

import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import farm.ballydidean.weather.widget.TemperatureUnit
import farm.ballydidean.weather.widget.WidgetAttempt
import farm.ballydidean.weather.widget.WidgetAttemptOutcome
import farm.ballydidean.weather.widget.WidgetForecastDecoder
import farm.ballydidean.weather.widget.WidgetPreferences
import farm.ballydidean.weather.widget.WidgetStorage
import farm.ballydidean.weather.widget.WidgetWorkScheduler
import java.io.File
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class WidgetStorageInstrumentationTest {
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val storage
        get() = WidgetStorage(context)

    // clear persistent state around each cache case
    @Before
    fun setUp() {
        storage.clear()
    }

    // clear persistent state around each cache case
    @After
    fun tearDown() {
        storage.clear()
    }

    // preserve last-good bytes independently from a failed attempt
    @Test
    fun failedAttemptPersistsWithoutReplacingSnapshot() {
        val bytes = asset("fixtures/adjusted-standard/snapshot.json")
        assertTrue(storage.writeSnapshot(bytes))
        storage.writeAttempt(WidgetAttempt(Instant.parse("2026-09-12T07:01:00Z"), WidgetAttemptOutcome.NETWORK))
        val restarted = WidgetStorage(context)
        assertArrayEquals(bytes, restarted.readSnapshotBytes())
        assertEquals(WidgetAttemptOutcome.NETWORK, restarted.readAttempt()?.outcome)
    }

    // reject older callbacks without replacing newer cache data
    @Test
    fun olderSnapshotCannotReplaceNewerAcquisition() {
        val newer = asset("fixtures/adjusted-standard/snapshot.json")
        val older = asset("fixtures/spring-forward-23/snapshot.json")
        assertTrue(storage.writeSnapshot(newer))
        assertFalse(storage.writeSnapshot(older))
        assertArrayEquals(newer, storage.readSnapshotBytes())
    }

    // delete corrupt and oversized cache files safely
    @Test
    fun corruptAndOversizedFilesFailClosed() {
        File(context.filesDir, "weather-widget-v1.json").writeBytes(
            ByteArray(WidgetForecastDecoder.MAX_BYTES + 1) { 'x'.code.toByte() },
        )
        File(context.filesDir, "weather-widget-attempt-v1.json").writeText("{bad")
        assertNull(storage.readSnapshot())
        assertNull(storage.readAttempt())
        assertFalse(File(context.filesDir, "weather-widget-v1.json").exists())
        assertFalse(File(context.filesDir, "weather-widget-attempt-v1.json").exists())
    }

    // keep each widget unit independent and removable
    @Test
    fun widgetUnitPersistsAndCleansUp() {
        WidgetPreferences.setUnit(context, 451, TemperatureUnit.CELSIUS)
        assertEquals(TemperatureUnit.CELSIUS, WidgetPreferences.unit(context, 451))
        WidgetPreferences.remove(context, 451)
        assertEquals(TemperatureUnit.FAHRENHEIT, WidgetPreferences.unit(context, 451))
    }

    // enqueue one independent cache-only boundary repaint
    @Test
    fun boundaryWorkIsUniqueAndNetworkIndependent() {
        val bytes = asset("fixtures/adjusted-standard/snapshot.json")
        storage.writeSnapshot(bytes)
        val snapshot = checkNotNull(storage.readSnapshot())
        WidgetWorkScheduler.scheduleBoundary(context, snapshot, Instant.parse("2026-09-12T07:00:01Z"))
        val infos = WorkManager.getInstance(context)
            .getWorkInfosForUniqueWork("weather-widget-boundary-v1")
            .get(5, TimeUnit.SECONDS)
        assertEquals(1, infos.size)
        WorkManager.getInstance(context).cancelUniqueWork("weather-widget-boundary-v1")
    }

    // read one packaged shared fixture
    private fun asset(path: String): ByteArray {
        return InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }
    }
}
