package farm.ballydidean.weather

import android.content.Context
import android.content.Intent

internal object HostedTestConfiguration {
    const val EXTRA_FIXTURE_ORIGIN = "farm.ballydidean.weather.debug.FIXTURE_ORIGIN"
    private const val PREFERENCES = "hosted-shell-debug-fixture"
    private const val ORIGIN = "origin"

    // retain only an explicit valid debug fixture origin
    fun canonicalOrigin(context: Context, intent: Intent?, fallback: String): String {
        val requested = intent?.getStringExtra(EXTRA_FIXTURE_ORIGIN)
        // persist the test origin for immutable widget intents
        if (requested != null && HostedNavigationPolicy.isCanonical(requested, requested)) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(ORIGIN, requested).commit()
            return requested
        }
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(ORIGIN, fallback) ?: fallback
    }
}
