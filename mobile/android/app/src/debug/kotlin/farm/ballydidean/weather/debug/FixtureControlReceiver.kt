package farm.ballydidean.weather.debug

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import farm.ballydidean.weather.widget.WidgetAttempt
import farm.ballydidean.weather.widget.WidgetAttemptOutcome
import farm.ballydidean.weather.widget.WidgetStorage
import farm.ballydidean.weather.widget.WeatherWidgetProvider
import java.time.Instant

class FixtureControlReceiver : BroadcastReceiver() {
    // select deterministic M0 evidence only
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_SET_FIXTURE -> {
                val variant = FixtureVariant.fromWireName(intent.getStringExtra(EXTRA_VARIANT))
                WeatherWidgetProvider.updateAll(context, DebugWidgetFixtures.fixture(variant).presentation)
            }
            ACTION_SEED_PERSISTENCE -> seedPersistence(context)
            ACTION_VERIFY_PERSISTENCE -> verifyPersistence(context)
            else -> return
        }
    }

    // seed one failed-attempt restart probe
    private fun seedPersistence(context: Context) {
        val storage = WidgetStorage(context)
        val bytes = context.assets.open("fixtures/adjusted-standard/snapshot.json").use { it.readBytes() }
        val snapshotWritten = storage.writeSnapshot(bytes)
        storage.writeAttempt(
            WidgetAttempt(Instant.parse("2026-09-12T07:01:00Z"), WidgetAttemptOutcome.NETWORK),
        )
        setResultCode(if (snapshotWritten != null) Activity.RESULT_OK else Activity.RESULT_CANCELED)
        setResultData(if (snapshotWritten != null) "seeded" else "seed-failed")
    }

    // verify persisted state in a restarted process
    private fun verifyPersistence(context: Context) {
        val storage = WidgetStorage(context)
        val valid = storage.readSnapshotBytes() != null &&
            storage.readAttempt()?.outcome == WidgetAttemptOutcome.NETWORK
        setResultCode(if (valid) Activity.RESULT_OK else Activity.RESULT_CANCELED)
        setResultData(if (valid) "restart-ok" else "restart-failed")
    }

    companion object {
        const val ACTION_SET_FIXTURE = "farm.ballydidean.weather.debug.SET_FIXTURE"
        const val ACTION_SEED_PERSISTENCE = "farm.ballydidean.weather.debug.SEED_PERSISTENCE"
        const val ACTION_VERIFY_PERSISTENCE = "farm.ballydidean.weather.debug.VERIFY_PERSISTENCE"
        const val EXTRA_VARIANT = "variant"
    }
}
