package farm.ballydidean.weather.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import farm.ballydidean.weather.BuildConfig
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock

internal sealed interface WidgetFetchResult {
    data class Success(val bytes: ByteArray) : WidgetFetchResult
    data class Failure(val outcome: WidgetAttemptOutcome, val retry: Boolean) : WidgetFetchResult
}

internal class WidgetForecastClient(
    private val deadlineMillis: Long = TOTAL_DEADLINE_MS,
    private val blockingFetch: (() -> WidgetFetchResult)? = null,
) {
    // fetch the fixed cookiefree public endpoint
    fun fetch(): WidgetFetchResult {
        val activeConnection = AtomicReference<HttpURLConnection?>()
        val executor = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "weather-widget-fetch").apply { isDaemon = true }
        }
        val future = executor.submit<WidgetFetchResult> {
            blockingFetch?.invoke() ?: performFetch(activeConnection)
        }
        return try {
            future.get(deadlineMillis, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            activeConnection.get()?.disconnect()
            future.cancel(true)
            WidgetFetchResult.Failure(WidgetAttemptOutcome.TIMEOUT, retry = true)
        } catch (_: Exception) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.NETWORK, retry = true)
        } finally {
            executor.shutdownNow()
        }
    }

    // perform one blocking request inside the overall deadline
    private fun performFetch(activeConnection: AtomicReference<HttpURLConnection?>): WidgetFetchResult {
        val startedAt = System.nanoTime()
        val connection = try {
            URL(ENDPOINT).openConnection() as HttpURLConnection
        } catch (_: IOException) {
            return WidgetFetchResult.Failure(WidgetAttemptOutcome.NETWORK, retry = true)
        }
        activeConnection.set(connection)
        return try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            connection.connectTimeout = remainingMillis(startedAt)
            connection.readTimeout = remainingMillis(startedAt)
            val status = connection.responseCode
            // reject redirects and non-success responses without bodies
            if (status != HttpURLConnection.HTTP_OK) {
                return WidgetFetchResult.Failure(WidgetAttemptOutcome.HTTP, retry = status >= 500)
            }
            val contentType = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            // require the public json media type
            if (contentType != "application/json") {
                return WidgetFetchResult.Failure(WidgetAttemptOutcome.INVALID, retry = false)
            }
            val contentLength = connection.contentLengthLong
            // reject known oversized bodies before allocation
            if (contentLength > WidgetForecastDecoder.MAX_BYTES) {
                return WidgetFetchResult.Failure(WidgetAttemptOutcome.TOO_LARGE, retry = false)
            }
            connection.inputStream.use { stream ->
                val bytes = readBounded(stream, contentLength, startedAt) { connection.readTimeout = it }
                validate(bytes)
            }
        } catch (_: TooLargeException) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.TOO_LARGE, retry = false)
        } catch (_: DeadlineExceededException) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.TIMEOUT, retry = true)
        } catch (_: SocketTimeoutException) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.TIMEOUT, retry = true)
        } catch (_: IOException) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.NETWORK, retry = true)
        } finally {
            activeConnection.compareAndSet(connection, null)
            connection.disconnect()
        }
    }

    // read through a strict total deadline and byte ceiling
    internal fun readBounded(
        stream: InputStream,
        contentLength: Long,
        startedAt: Long,
        updateReadTimeout: (Int) -> Unit = {},
    ): ByteArray {
        val initialSize = if (contentLength in 1..WidgetForecastDecoder.MAX_BYTES.toLong()) contentLength.toInt() else 8_192
        val output = java.io.ByteArrayOutputStream(initialSize)
        val buffer = ByteArray(8_192)
        // stop only at a clean end of stream
        while (true) {
            updateReadTimeout(remainingMillis(startedAt))
            val count = stream.read(buffer)
            // finish on end of stream
            if (count < 0) {
                break
            }
            // reject streaming overflow with a sanitized category
            if (output.size() + count > WidgetForecastDecoder.MAX_BYTES) {
                throw TooLargeException()
            }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    // classify public-contract decode failures without leaking parser errors
    internal fun validate(bytes: ByteArray): WidgetFetchResult {
        return try {
            WidgetForecastDecoder.decode(bytes)
            WidgetFetchResult.Success(bytes)
        } catch (_: IllegalArgumentException) {
            WidgetFetchResult.Failure(WidgetAttemptOutcome.INVALID, retry = false)
        }
    }

    // return the remaining total request budget
    private fun remainingMillis(startedAt: Long): Int {
        val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
        val remaining = deadlineMillis - elapsedMillis
        // fail rather than extending the total deadline
        if (remaining <= 0) {
            throw DeadlineExceededException()
        }
        return remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

    private class DeadlineExceededException : IOException()
    private class TooLargeException : IOException()

    companion object {
        const val ENDPOINT = "https://weather.ballydidean.farm/api/v1/sites/ballydidean/widget-forecast"
        private const val TOTAL_DEADLINE_MS = 8_000L
    }
}

class WidgetRefreshWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : Worker(appContext, parameters) {
    // fetch once and preserve last-good bytes on failure
    override fun doWork(): Result {
        // stop work after the final widget is gone
        if (!WidgetWorkScheduler.hasWidgets(applicationContext)) {
            WidgetWorkScheduler.cancel(applicationContext)
            return Result.success()
        }
        // prevent ordinary debug and host-test traffic from reaching production
        if (BuildConfig.DEBUG) {
            return Result.success()
        }
        // coalesce immediate and periodic workers through one process lock
        if (!WidgetRefreshCoordinator.tryAcquire()) {
            return Result.success()
        }
        try {
            val startedAt = Instant.now()
            val storage = WidgetStorage(applicationContext)
            // avoid back-to-back fetches from the two unique work names
            if (!WidgetRefreshCoordinator.shouldFetch(storage.readAttempt(), startedAt)) {
                WidgetController.updateAll(applicationContext, startedAt)
                WidgetWorkScheduler.scheduleBoundary(applicationContext, storage.readSnapshot(), startedAt)
                return Result.success()
            }
            val result = WidgetForecastClient().fetch()
            val outcome = when (result) {
                is WidgetFetchResult.Success -> WidgetAttemptOutcome.SUCCESS
                is WidgetFetchResult.Failure -> result.outcome
            }
            var writeFailed = false
            var snapshotIdentity: String? = null
            // preserve weather and metadata independently
            if (result is WidgetFetchResult.Success) {
                try {
                    snapshotIdentity = storage.writeSnapshot(result.bytes)
                } catch (_: Exception) {
                    writeFailed = true
                }
                // never label an ignored rollback callback successful
                if (!writeFailed && snapshotIdentity == null) {
                    val renderAt = Instant.now()
                    WidgetController.updateAll(applicationContext, renderAt)
                    WidgetWorkScheduler.scheduleBoundary(applicationContext, storage.readSnapshot(), renderAt)
                    return Result.success()
                }
            }
            val completedAt = Instant.now()
            val currentAttempt = WidgetAttempt(completedAt, outcome, snapshotIdentity)
            try {
                storage.writeAttempt(if (writeFailed) WidgetAttempt(completedAt, WidgetAttemptOutcome.INVALID) else currentAttempt)
            } catch (_: Exception) {
                writeFailed = true
            }
            val renderAt = Instant.now()
            val visibleAttempt = if (writeFailed) WidgetAttempt(completedAt, WidgetAttemptOutcome.INVALID) else currentAttempt
            WidgetController.updateAll(applicationContext, renderAt, visibleAttempt)
            WidgetWorkScheduler.scheduleBoundary(applicationContext, storage.readSnapshot(), renderAt)
            return when {
                writeFailed -> Result.failure()
                result is WidgetFetchResult.Failure && result.retry -> Result.retry()
                result is WidgetFetchResult.Failure -> Result.failure()
                else -> Result.success()
            }
        } finally {
            WidgetRefreshCoordinator.release()
        }
    }
}

internal object WidgetRefreshCoordinator {
    private val lock = ReentrantLock()

    // acquire without queueing another fetch
    fun tryAcquire(): Boolean = lock.tryLock()

    // release the shared network lane
    fun release() {
        lock.unlock()
    }

    // suppress back-to-back immediate and periodic attempts
    fun shouldFetch(attempt: WidgetAttempt?, now: Instant): Boolean {
        val attemptedAt = attempt?.attemptedAt ?: return true
        val age = Duration.between(attemptedAt, now)
        return age.isNegative || age >= Duration.ofMinutes(1)
    }
}

class WidgetBoundaryWorker(
    appContext: Context,
    parameters: WorkerParameters,
) : Worker(appContext, parameters) {
    // repaint cached values without network access
    override fun doWork(): Result {
        // cancel after the last instance
        if (!WidgetWorkScheduler.hasWidgets(applicationContext)) {
            WidgetWorkScheduler.cancel(applicationContext)
            return Result.success()
        }
        val now = Instant.now()
        WidgetController.updateAll(applicationContext, now)
        WidgetWorkScheduler.scheduleBoundary(applicationContext, WidgetStorage(applicationContext).readSnapshot(), now)
        return Result.success()
    }
}

object WidgetBoundaryPlanner {
    // choose the earliest future presentation boundary
    fun earliest(snapshot: WidgetForecastSnapshot, now: Instant): Instant? {
        val candidates = mutableListOf<Instant>()
        candidates += snapshot.calendar.cutoff
        candidates += snapshot.calendar.dayEnd
        candidates += snapshot.receivedAt.plus(Duration.ofMinutes(90)).plusMillis(1)
        candidates += snapshot.receivedAt.plus(Duration.ofHours(24))
        // capture every hour and correction boundary
        for (hour in snapshot.hours) {
            candidates += hour.end
            for (field in listOf(hour.temperatureC, hour.rainMmPerHour)) {
                field.selectedUntil?.let(candidates::add)
                for (source in listOfNotNull(field.rawSource, field.selectedSource)) {
                    candidates += source.receivedAt.plus(Duration.ofHours(12)).plusMillis(1)
                    source.runAt?.plus(Duration.ofHours(12))?.plusMillis(1)?.let(candidates::add)
                }
            }
        }
        return candidates.filter { it > now }.minOrNull()
    }
}

object WidgetWorkScheduler {
    internal const val IMMEDIATE_WORK = "weather-widget-immediate-v1"
    internal const val PERIODIC_WORK = "weather-widget-periodic-v1"
    internal const val BOUNDARY_WORK = "weather-widget-boundary-v1"

    // coalesce immediate and periodic network refreshes
    fun ensure(context: Context) {
        // remove all work without widget instances
        if (!hasWidgets(context)) {
            cancel(context)
            return
        }
        val workManager = WorkManager.getInstance(context)
        val network = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        val immediate = OneTimeWorkRequest.Builder(WidgetRefreshWorker::class.java)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()
        val periodic = PeriodicWorkRequest.Builder(WidgetRefreshWorker::class.java, 30, TimeUnit.MINUTES)
            .setConstraints(network)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()
        workManager.enqueueUniqueWork(IMMEDIATE_WORK, ExistingWorkPolicy.KEEP, immediate)
        workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, periodic)
        scheduleBoundary(context, WidgetStorage(context).readSnapshot(), Instant.now())
    }

    // request one cache-only repaint at the next boundary
    fun scheduleBoundary(context: Context, snapshot: WidgetForecastSnapshot?, now: Instant) {
        val workManager = WorkManager.getInstance(context)
        val boundary = snapshot?.let { WidgetBoundaryPlanner.earliest(it, now) }
        // cancel when no future boundary remains
        if (boundary == null) {
            workManager.cancelUniqueWork(BOUNDARY_WORK)
            return
        }
        val delayMillis = maxOf(1, Duration.between(now, boundary).toMillis())
        val work = OneTimeWorkRequest.Builder(WidgetBoundaryWorker::class.java)
            .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
            .build()
        workManager.enqueueUniqueWork(BOUNDARY_WORK, ExistingWorkPolicy.REPLACE, work)
    }

    // cancel every widget-owned work name
    fun cancel(context: Context) {
        val manager = WorkManager.getInstance(context)
        manager.cancelUniqueWork(IMMEDIATE_WORK)
        manager.cancelUniqueWork(PERIODIC_WORK)
        manager.cancelUniqueWork(BOUNDARY_WORK)
    }

    // inspect active provider allocations
    fun hasWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context)
        val component = ComponentName(context, WeatherWidgetProvider::class.java)
        return manager.getAppWidgetIds(component).isNotEmpty()
    }
}
