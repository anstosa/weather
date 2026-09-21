package farm.ballydidean.weather.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import farm.ballydidean.weather.R
import java.time.Instant

class WidgetConfigurationActivity : Activity() {
    private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    // show one bounded per-widget preference
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        appWidgetId = intent?.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID,
        ) ?: AppWidgetManager.INVALID_APPWIDGET_ID
        // reject missing or forged widget identities
        val provider = AppWidgetManager.getInstance(this).getAppWidgetInfo(appWidgetId)?.provider
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID ||
            provider != ComponentName(this, WeatherWidgetProvider::class.java)
        ) {
            finish()
            return
        }
        val radioGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }
        val fahrenheit = RadioButton(this).apply {
            id = ViewGroup.generateViewId()
            text = getString(R.string.widget_unit_fahrenheit)
        }
        val celsius = RadioButton(this).apply {
            id = ViewGroup.generateViewId()
            text = getString(R.string.widget_unit_celsius)
        }
        radioGroup.addView(fahrenheit)
        radioGroup.addView(celsius)
        val current = WidgetPreferences.unit(this, appWidgetId)
        radioGroup.check(if (current == TemperatureUnit.CELSIUS) celsius.id else fahrenheit.id)
        val save = Button(this).apply {
            text = getString(R.string.widget_unit_save)
            // persist and recompute through the production path
            setOnClickListener {
                val unit = if (radioGroup.checkedRadioButtonId == celsius.id) {
                    TemperatureUnit.CELSIUS
                } else {
                    TemperatureUnit.FAHRENHEIT
                }
                WidgetPreferences.setUnit(this@WidgetConfigurationActivity, appWidgetId, unit)
                val manager = AppWidgetManager.getInstance(this@WidgetConfigurationActivity)
                WidgetController.updateWidget(
                    this@WidgetConfigurationActivity,
                    manager,
                    appWidgetId,
                    now = Instant.now(),
                )
                WidgetWorkScheduler.ensure(this@WidgetConfigurationActivity)
                val result = Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
                setResult(RESULT_OK, result)
                finish()
            }
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            addView(TextView(this@WidgetConfigurationActivity).apply {
                text = getString(R.string.widget_unit_title)
                textSize = 20f
            })
            addView(radioGroup)
            addView(save)
        }
        setContentView(root)
    }
}
