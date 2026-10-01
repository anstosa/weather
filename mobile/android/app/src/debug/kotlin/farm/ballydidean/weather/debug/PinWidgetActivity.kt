package farm.ballydidean.weather.debug

import android.app.Activity
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import farm.ballydidean.weather.widget.WeatherWidgetProvider

class PinWidgetActivity : Activity() {
    // request genuine launcher placement for M0 evidence
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, WeatherWidgetProvider::class.java)
        val callback = PendingIntent.getBroadcast(
            this,
            0,
            Intent(ACTION_PINNED).setPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        manager.requestPinAppWidget(provider, null, callback)
        finish()
    }

    companion object {
        private const val ACTION_PINNED = "farm.ballydidean.weather.debug.WIDGET_PINNED"
    }
}
