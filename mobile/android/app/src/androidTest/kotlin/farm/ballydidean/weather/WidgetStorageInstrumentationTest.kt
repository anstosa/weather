package farm.ballydidean.weather

import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.NetworkType
import androidx.work.WorkManager
import farm.ballydidean.weather.widget.TemperatureUnit
import farm.ballydidean.weather.widget.WidgetAttempt
import farm.ballydidean.weather.widget.WidgetAttemptOutcome
import farm.ballydidean.weather.widget.WidgetController
import farm.ballydidean.weather.widget.WidgetForecastDecoder
import farm.ballydidean.weather.widget.WidgetFetchResult
import farm.ballydidean.weather.widget.WidgetPreferences
import farm.ballydidean.weather.widget.WidgetRefreshCompletion
import farm.ballydidean.weather.widget.WidgetRefreshPersistence
import farm.ballydidean.weather.widget.WidgetSemanticRenderer
import farm.ballydidean.weather.widget.WidgetStorage
import farm.ballydidean.weather.widget.WidgetWorkScheduler
import java.io.File
import java.time.Instant
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
        assertNotNull(storage.writeSnapshot(bytes))
        storage.writeAttempt(WidgetAttempt(Instant.parse("2026-09-12T07:01:00Z"), WidgetAttemptOutcome.NETWORK))
        val restarted = WidgetStorage(context)
        assertArrayEquals(bytes, restarted.readSnapshotBytes())
        assertEquals(WidgetAttemptOutcome.NETWORK, restarted.readAttempt()?.outcome)
    }

    // persist rejected callbacks as stale across restart
    @Test
    fun olderSnapshotCannotReplaceNewerAcquisition() {
        val newer = asset("fixtures/adjusted-standard/snapshot.json")
        val older = asset("fixtures/spring-forward-23/snapshot.json")
        val identity = checkNotNull(storage.writeSnapshot(newer))
        storage.writeAttempt(
            WidgetAttempt(
                Instant.parse("2026-09-12T07:01:00Z"),
                WidgetAttemptOutcome.SUCCESS,
                identity,
            ),
        )
        val rollback = WidgetRefreshPersistence.persist(
            storage,
            WidgetFetchResult.Success(older),
            Instant.parse("2026-09-12T07:02:00Z"),
        )
        assertEquals(WidgetRefreshCompletion.FAILURE, rollback.completion)
        val restartedAfterRollback = WidgetStorage(context)
        assertArrayEquals(newer, restartedAfterRollback.readSnapshotBytes())
        assertEquals(WidgetAttemptOutcome.INVALID, restartedAfterRollback.readAttempt()?.outcome)
        val storedAfterRollback = checkNotNull(restartedAfterRollback.readStoredSnapshot())
        assertTrue(
            WidgetSemanticRenderer.render(
                storedAfterRollback.snapshot,
                Instant.parse("2026-09-12T07:02:01Z"),
                TemperatureUnit.FAHRENHEIT,
                WidgetController.boundAttempt(
                    restartedAfterRollback.readAttempt(),
                    storedAfterRollback,
                    Instant.parse("2026-09-12T07:02:01Z"),
                ),
            ).stale,
        )

        storage.writeAttempt(
            WidgetAttempt(
                Instant.parse("2026-09-12T07:03:00Z"),
                WidgetAttemptOutcome.SUCCESS,
                identity,
            ),
        )
        val conflict = newer.toString(Charsets.UTF_8)
            .replaceFirst("15.555555555555555", "15.0")
            .toByteArray()
        val equalReceiptConflict = WidgetRefreshPersistence.persist(
            storage,
            WidgetFetchResult.Success(conflict),
            Instant.parse("2026-09-12T07:04:00Z"),
        )
        assertEquals(WidgetRefreshCompletion.FAILURE, equalReceiptConflict.completion)
        val restartedAfterConflict = WidgetStorage(context)
        val stored = checkNotNull(restartedAfterConflict.readStoredSnapshot())
        assertArrayEquals(newer, restartedAfterConflict.readSnapshotBytes())
        assertEquals(identity, stored.identity)
        assertEquals(WidgetAttemptOutcome.INVALID, restartedAfterConflict.readAttempt()?.outcome)
        assertNull(restartedAfterConflict.readAttempt()?.snapshotIdentity)
        assertTrue(
            WidgetSemanticRenderer.render(
                stored.snapshot,
                Instant.parse("2026-09-12T07:04:01Z"),
                TemperatureUnit.FAHRENHEIT,
                WidgetController.boundAttempt(
                    restartedAfterConflict.readAttempt(),
                    stored,
                    Instant.parse("2026-09-12T07:04:01Z"),
                ),
            ).stale,
        )

        storage.writeAttempt(
            WidgetAttempt(
                Instant.parse("2026-09-12T07:05:00Z"),
                WidgetAttemptOutcome.SUCCESS,
                identity,
            ),
        )
        assertEquals(
            WidgetAttemptOutcome.SUCCESS,
            WidgetController.boundAttempt(
                WidgetStorage(context).readAttempt(),
                stored,
                Instant.parse("2026-09-12T07:05:01Z"),
            ).outcome,
        )

        val rollbackIdentity = WidgetStorage.snapshotIdentity(asset("fixtures/spring-forward-23/snapshot.json"))
        storage.writeAttempt(
            WidgetAttempt(
                Instant.parse("2026-09-12T07:06:00Z"),
                WidgetAttemptOutcome.SUCCESS,
                rollbackIdentity,
            ),
        )
        val restartedAfterInterruptedWrite = WidgetStorage(context)
        val mismatched = checkNotNull(restartedAfterInterruptedWrite.readAttempt())
        assertFalse(mismatched.snapshotIdentity == stored.identity)
        assertEquals(
            WidgetAttemptOutcome.INVALID,
            WidgetController.boundAttempt(
                mismatched,
                stored,
                Instant.parse("2026-09-12T07:06:01Z"),
            ).outcome,
        )
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
        val workManager = WorkManager.getInstance(context)
        WidgetWorkScheduler.scheduleBoundary(context, snapshot, Instant.parse("2026-09-12T07:00:01Z"))
        val first = workManager
            .getWorkInfosForUniqueWork("weather-widget-boundary-v1")
            .get(5, TimeUnit.SECONDS).single { !it.state.isFinished }
        assertEquals(NetworkType.NOT_REQUIRED, first.constraints.requiredNetworkType)
        assertEquals(3_599_000L, first.initialDelayMillis)
        WidgetWorkScheduler.scheduleBoundary(context, snapshot, Instant.parse("2026-09-12T07:30:01Z"))
        val replacement = workManager
            .getWorkInfosForUniqueWork("weather-widget-boundary-v1")
            .get(5, TimeUnit.SECONDS).single { !it.state.isFinished }
        assertFalse(first.id == replacement.id)
        assertEquals(1_799_000L, replacement.initialDelayMillis)
        workManager.cancelUniqueWork("weather-widget-boundary-v1")
    }

    // clear per-widget state and work after final disable
    @Test
    fun finalDisableCleansConfigurationCacheAndWork() {
        val bytes = asset("fixtures/adjusted-standard/snapshot.json")
        assertNotNull(storage.writeSnapshot(bytes))
        WidgetPreferences.setUnit(context, 451, TemperatureUnit.CELSIUS)
        WidgetWorkScheduler.scheduleBoundary(
            context,
            checkNotNull(storage.readSnapshot()),
            Instant.parse("2026-09-12T07:00:01Z"),
        )
        val provider = farm.ballydidean.weather.widget.WeatherWidgetProvider()
        provider.onDeleted(context, intArrayOf(451))
        assertEquals(TemperatureUnit.FAHRENHEIT, WidgetPreferences.unit(context, 451))
        provider.onDisabled(context)
        assertNull(storage.readSnapshot())
        assertNull(storage.readAttempt())
    }

    // read one packaged shared fixture
    private fun asset(path: String): ByteArray {
        return InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }
    }
}
