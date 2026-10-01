package farm.ballydidean.weather

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostedNavigationPolicyTest {
    // allow only the exact published privacy link
    @Test
    fun privacyContactAllowsOnlyExactPublishedMailto() {
        assertTrue(HostedNavigationPolicy.isPrivacyContact("mailto:sanctuary@ballydidean.farm"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("mailto:privacy@ballydidean.farm"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("mailto:sanctuary@ballydidean.farm?subject=Privacy"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("mailto:sanctuary@ballydidean.farm#request"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("mailto://sanctuary@ballydidean.farm"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("MAILTO:sanctuary@ballydidean.farm"))
        assertFalse(HostedNavigationPolicy.isPrivacyContact("https://ballydidean.farm"))
    }

    // retain exact production-origin routes
    @Test
    fun canonicalOriginAllowsOnlyDefaultPortHttps() {
        assertTrue(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm/forecast"))
        assertTrue(HostedNavigationPolicy.isCanonical("https://WEATHER.BALLYDIDEAN.FARM:443/settings"))
        assertFalse(HostedNavigationPolicy.isCanonical("http://weather.ballydidean.farm/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm:444/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm.evil.test/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://user@weather.ballydidean.farm/forecast"))
        assertFalse(HostedNavigationPolicy.isCanonical("https://weather.ballydidean.farm/%zz"))
        assertFalse(HostedNavigationPolicy.isCanonical(" https://weather.ballydidean.farm/forecast"))
        val fixture = "https://10.0.2.2:18443"
        assertTrue(HostedNavigationPolicy.isCanonical("https://10.0.2.2:18443/settings", fixture))
        assertFalse(HostedNavigationPolicy.isCanonical("https://10.0.2.2:18444/settings", fixture))
        assertFalse(HostedNavigationPolicy.isCanonical("https://10.0.2.20:18443/settings", fixture))
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
        assertFalse(HostedNavigationPolicy.isSafeExternal("https://weather.ballydidean.farm.evil.test/"))
        assertFalse(HostedNavigationPolicy.isSafeExternal("https://admin.weather.ballydidean.farm/"))
        assertFalse(
            HostedNavigationPolicy.isSafeExternal(
                "https://weather.ballydidean.farm.evil.test/",
                "https://10.0.2.2:18443",
            ),
        )
        assertFalse(HostedNavigationPolicy.isSafeExternal("https://example.com/%zz"))
    }
}
