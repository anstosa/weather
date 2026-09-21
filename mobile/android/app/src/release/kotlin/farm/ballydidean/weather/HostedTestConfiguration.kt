package farm.ballydidean.weather

import android.content.Context
import android.content.Intent

internal object HostedTestConfiguration {
    // ignore every runtime origin override in release
    fun canonicalOrigin(context: Context, intent: Intent?, fallback: String): String {
        return fallback
    }
}
