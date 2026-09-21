package farm.ballydidean.weather

import java.net.URI
import java.net.URISyntaxException

internal object HostedNavigationPolicy {
    private const val CANONICAL_ORIGIN = "https://weather.ballydidean.farm"
    private const val CANONICAL_HOST = "weather.ballydidean.farm"

    // match the exact production origin
    fun isCanonical(value: String, canonicalOrigin: String = CANONICAL_ORIGIN): Boolean {
        val uri = parse(value) ?: return false
        val canonical = parse(canonicalOrigin) ?: return false
        return validCanonicalOrigin(canonical) &&
            validHttpsAuthority(uri, allowNonDefaultPort = true) &&
            uri.host.equals(canonical.host, ignoreCase = true) &&
            effectivePort(uri) == effectivePort(canonical)
    }

    // allow credential-free external https in the system browser
    fun isSafeExternal(value: String, canonicalOrigin: String = CANONICAL_ORIGIN): Boolean {
        val uri = parse(value) ?: return false
        val canonical = parse(canonicalOrigin) ?: return false
        return validHttpsAuthority(uri, allowNonDefaultPort = false) &&
            !isCanonical(value, canonicalOrigin) &&
            !isLookalike(uri, canonical)
    }

    // require an ordinary default-port https authority
    private fun validHttpsAuthority(uri: URI, allowNonDefaultPort: Boolean): Boolean {
        return !uri.isOpaque &&
            uri.scheme.equals("https", ignoreCase = true) &&
            uri.host != null &&
            uri.userInfo == null &&
            (allowNonDefaultPort || uri.port == -1 || uri.port == 443)
    }

    // require a bare compiled origin
    private fun validCanonicalOrigin(uri: URI): Boolean {
        return validHttpsAuthority(uri, allowNonDefaultPort = true) &&
            (uri.path.isNullOrEmpty() || uri.path == "/") &&
            uri.query == null &&
            uri.fragment == null
    }

    // normalize omitted https ports
    private fun effectivePort(uri: URI): Int {
        return if (uri.port == -1) 443 else uri.port
    }

    // reject parent and child host lookalikes
    private fun isLookalike(uri: URI, canonical: URI): Boolean {
        val host = uri.host.lowercase()
        val canonicalHost = canonical.host.lowercase()
        return host.startsWith("$canonicalHost.") ||
            host.endsWith(".$canonicalHost") ||
            host.startsWith("$CANONICAL_HOST.") ||
            host.endsWith(".$CANONICAL_HOST")
    }

    // fail closed on parser errors
    private fun parse(value: String): URI? {
        return try {
            URI(value)
        } catch (_: URISyntaxException) {
            null
        } catch (_: RuntimeException) {
            null
        }
    }
}
