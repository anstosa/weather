package farm.ballydidean.weather.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.time.Instant

enum class WidgetAttemptOutcome {
    SUCCESS,
    TIMEOUT,
    NETWORK,
    HTTP,
    INVALID,
    TOO_LARGE
}

data class WidgetAttempt(
    val attemptedAt: Instant,
    val outcome: WidgetAttemptOutcome,
)

class WidgetStorage(context: Context) {
    private val snapshotFile = AtomicFile(File(context.filesDir, SNAPSHOT_FILE))
    private val attemptFile = AtomicFile(File(context.filesDir, ATTEMPT_FILE))

    // return only a currently valid cached snapshot
    fun readSnapshot(): WidgetForecastSnapshot? = synchronized(lock) {
        try {
            val bytes = readBounded(snapshotFile, WidgetForecastDecoder.MAX_BYTES)
            WidgetForecastDecoder.decode(bytes)
        } catch (_: Exception) {
            snapshotFile.delete()
            null
        }
    }

    // return the exact cached bytes for diagnostics tests
    internal fun readSnapshotBytes(): ByteArray? = synchronized(lock) {
        try {
            readBounded(snapshotFile, WidgetForecastDecoder.MAX_BYTES).also(WidgetForecastDecoder::decode)
        } catch (_: Exception) {
            snapshotFile.delete()
            null
        }
    }

    // atomically replace only with a valid public snapshot
    fun writeSnapshot(bytes: ByteArray): Boolean = synchronized(lock) {
        val incoming = WidgetForecastDecoder.decode(bytes)
        val existing = try {
            WidgetForecastDecoder.decode(readBounded(snapshotFile, WidgetForecastDecoder.MAX_BYTES))
        } catch (_: Exception) {
            null
        }
        // never replace a newer acquisition with an older callback
        if (existing != null && incoming.receivedAt < existing.receivedAt) {
            return@synchronized false
        }
        write(snapshotFile, bytes)
        true
    }

    // read bounded sanitized attempt metadata
    fun readAttempt(): WidgetAttempt? = synchronized(lock) {
        try {
            decodeAttempt(readBounded(attemptFile, MAX_ATTEMPT_BYTES))
        } catch (_: Exception) {
            attemptFile.delete()
            null
        }
    }

    // atomically replace attempt metadata independently
    fun writeAttempt(attempt: WidgetAttempt) = synchronized(lock) {
        val payload = "{\"attemptedAt\":\"${attempt.attemptedAt}\",\"outcome\":\"${attempt.outcome.name.lowercase()}\"}"
            .toByteArray(Charsets.UTF_8)
        require(payload.size <= MAX_ATTEMPT_BYTES) { "attempt metadata is oversized" }
        write(attemptFile, payload)
    }

    // remove all persisted widget data
    fun clear() = synchronized(lock) {
        snapshotFile.delete()
        attemptFile.delete()
    }

    // commit through atomicfile's fsync and rename path
    private fun write(file: AtomicFile, bytes: ByteArray) {
        val stream = file.startWrite()
        try {
            stream.write(bytes)
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    // read without allocating an attacker-sized corrupt file
    private fun readBounded(file: AtomicFile, maximumBytes: Int): ByteArray {
        file.openRead().use { stream ->
            val output = java.io.ByteArrayOutputStream(minOf(8_192, maximumBytes))
            val buffer = ByteArray(minOf(8_192, maximumBytes + 1))
            // stop at a clean end of file
            while (true) {
                val count = stream.read(buffer)
                // finish at eof
                if (count < 0) {
                    return output.toByteArray()
                }
                require(output.size() + count <= maximumBytes) { "cached widget file is oversized" }
                output.write(buffer, 0, count)
            }
        }
    }

    // accept only the two attempt metadata members
    private fun decodeAttempt(bytes: ByteArray): WidgetAttempt {
        require(bytes.size <= MAX_ATTEMPT_BYTES) { "attempt metadata is oversized" }
        val value = StrictJson.parse(bytes).closedObject(setOf("attemptedAt", "outcome"), "attempt")
        val attemptedAt = Instant.parse(value.string("attemptedAt"))
        val outcome = WidgetAttemptOutcome.entries.firstOrNull {
            it.name.equals(value.string("outcome"), ignoreCase = true)
        } ?: throw IllegalArgumentException("unknown attempt outcome")
        return WidgetAttempt(attemptedAt, outcome)
    }

    companion object {
        private const val SNAPSHOT_FILE = "weather-widget-v1.json"
        private const val ATTEMPT_FILE = "weather-widget-attempt-v1.json"
        private const val MAX_ATTEMPT_BYTES = 512
        private val lock = Any()
    }
}

object WidgetPreferences {
    private const val FILE_NAME = "weather-widget-preferences"
    private const val KEY_PREFIX = "unit."

    // load one widget's independent unit
    fun unit(context: Context, appWidgetId: Int): TemperatureUnit {
        val value = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .getString(KEY_PREFIX + appWidgetId, null)
        return if (value == TemperatureUnit.CELSIUS.name) TemperatureUnit.CELSIUS else TemperatureUnit.FAHRENHEIT
    }

    // persist one widget's selected unit
    fun setUnit(context: Context, appWidgetId: Int, unit: TemperatureUnit) {
        require(appWidgetId != AppWidgetManager.INVALID_APPWIDGET_ID) { "invalid widget id" }
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_PREFIX + appWidgetId, unit.name)
            .apply()
    }

    // remove deleted widget configuration
    fun remove(context: Context, appWidgetId: Int) {
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_PREFIX + appWidgetId)
            .apply()
    }
}
