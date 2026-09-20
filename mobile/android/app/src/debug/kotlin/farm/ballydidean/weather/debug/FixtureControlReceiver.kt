package farm.ballydidean.weather.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import farm.ballydidean.weather.widget.FixtureVariant
import farm.ballydidean.weather.widget.WeatherWidgetProvider

class FixtureControlReceiver : BroadcastReceiver() {
    // select deterministic M0 evidence only
    override fun onReceive(context: Context, intent: Intent) {
        // reject unrelated debug broadcasts
        if (intent.action != ACTION_SET_FIXTURE) {
            return
        }
        val variant = FixtureVariant.fromWireName(intent.getStringExtra(EXTRA_VARIANT))
        WeatherWidgetProvider.updateAll(context, variant)
    }

    companion object {
        const val ACTION_SET_FIXTURE = "farm.ballydidean.weather.debug.SET_FIXTURE"
        const val EXTRA_VARIANT = "variant"
    }
}
