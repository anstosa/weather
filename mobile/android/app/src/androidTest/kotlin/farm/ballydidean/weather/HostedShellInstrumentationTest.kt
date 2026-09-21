package farm.ballydidean.weather

import android.webkit.CookieManager
import androidx.test.platform.app.InstrumentationRegistry
import farm.ballydidean.weather.widget.WidgetStorage
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostedShellInstrumentationTest {
    private val context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    // remove only test-owned web cookies
    @After
    fun clearCookies() {
        val latch = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            CookieManager.getInstance().removeAllCookies { latch.countDown() }
        }
        latch.await(5, TimeUnit.SECONDS)
        CookieManager.getInstance().flush()
    }

    // preserve first-party web cookies without copying them to widget storage
    @Test
    fun persistentFirstPartyCookieStaysOutsideWidgetCache() {
        val manager = CookieManager.getInstance()
        manager.setAcceptCookie(true)
        val latch = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            manager.setCookie(
                "https://weather.ballydidean.farm",
                "weather_android_test=present; Path=/; Secure; HttpOnly; SameSite=Lax",
            ) { latch.countDown() }
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        manager.flush()
        assertTrue(manager.getCookie("https://weather.ballydidean.farm").contains("weather_android_test=present"))
        val storage = WidgetStorage(context)
        val cachedBytes = storage.readSnapshotBytes()?.toString(Charsets.UTF_8).orEmpty()
        assertFalse(cachedBytes.contains("weather_android_test"))
    }
}
