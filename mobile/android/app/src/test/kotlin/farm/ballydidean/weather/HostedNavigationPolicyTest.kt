package farm.ballydidean.weather

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostedNavigationPolicyTest {
    // retain exact production-origin routes
    @Test
    fun canonicalOriginAllowsOnlyDefaultPortHttps() {
        assertTrue(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm/forecast"))
        assertTrue(HostedNavigationPolicy.isCanonical("https://WEATHER.BALLYDIDEAN.FARM:443/settings"))
        assertFalse(HostedNavigationPolicy.isCanonical("http://weather.ballydidean.farm/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm:444/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm.evil.test/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://user@weather.ballydidean.farm/forecast"))
    }

    // reject unsafe schemes and credentialed external links
    @Test
    fun externalPolicyRejectsUnsafeNavigation() {
        assertTrue(HostedNavigationPolicy.isSafeExternal("https://open-meteo.com/"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("javascript:alert(1)"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("file:///etc/passwd"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("content://settings/system"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("https://user@example.com/"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("https://example.com:8443/"))
    }
}
