package farm.ballydidean.weather

import java.net.URI

internal object HostedNavigationPolicy {
    private const val CANONICAL_HOST = "weather.ballydidean.farm"

    // match the exact production origin
    fun isCanonical(value: String): Boolean {
        val uri = parse(value) ?: return false
        return validHttpsAuthority(uri) && uri.host.equals(CANONICAL_HOST, ignoreCase = true)
    }

    // allow credential-free external https in the system browser
    fun isSafeExternal(value: String): Boolean {
        val uri = parse(value) ?: return false
        return validHttpsAuthority(uri) && !uri.host.equals(CANONICAL_HOST, ignoreCase = true)
    }

    // require an ordinary default-port https authority
    private fun validHttpsAuthority(uri: URI): Boolean {
        return !uri.isOpaque &&
            uri.scheme.equals("https", ignoreCase = true) &&
            uri.host != null &&
            uri.userInfo == null &&
            (uri.port == -1 || uri.port == 443)
    }

    // fail closed on parser errors
    private fun parse(value: String): URI? {
        return try {
            URI(value)
        } catch (_: RuntimeException) {
            null
        }
    }
}
