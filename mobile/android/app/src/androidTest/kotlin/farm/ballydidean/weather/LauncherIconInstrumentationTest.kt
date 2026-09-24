package farm.ballydidean.weather

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.AdaptiveIconDrawable
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// verify the packaged icon leaves all shape decisions to android
class LauncherIconInstrumentationTest {
    // resolve both application and launcher icons through the package manager
    @Test
    fun applicationAndLauncherUseSystemMaskedIcons() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.packageManager
        assertTrue(manager.getApplicationIcon(context.packageName) is AdaptiveIconDrawable)
        val launch = checkNotNull(manager.getLaunchIntentForPackage(context.packageName))
        assertTrue(manager.getActivityIcon(launch) is AdaptiveIconDrawable)
        assertTrue(context.getDrawable(R.mipmap.ic_launcher) is AdaptiveIconDrawable)
    }

    // reject transparent corners or any pre-applied raster shape
    @Test
    fun sourceArtworkRemainsAnOpaqueSquare() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val options = BitmapFactory.Options().apply { inScaled = false }
        val bitmap = checkNotNull(BitmapFactory.decodeResource(context.resources, R.drawable.ic_launcher_artwork, options))
        assertEquals(512, bitmap.width)
        assertEquals(512, bitmap.height)
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        // retain opaque pixels over the entire unmasked canvas
        for (pixel in pixels) {
            assertEquals(255, Color.alpha(pixel))
        }
    }

    // cover the full layer even when the launcher moves the foreground
    @Test
    fun adaptiveBackgroundHasNoInsetOrRoundedCorners() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val icon = context.getDrawable(R.mipmap.ic_launcher) as AdaptiveIconDrawable
        val bitmap = Bitmap.createBitmap(108, 108, Bitmap.Config.ARGB_8888)
        icon.background.setBounds(0, 0, bitmap.width, bitmap.height)
        icon.background.draw(Canvas(bitmap))
        val expected = context.getColor(R.color.launcher_icon_background)
        assertEquals(expected, bitmap.getPixel(0, 0))
        assertEquals(expected, bitmap.getPixel(107, 0))
        assertEquals(expected, bitmap.getPixel(0, 107))
        assertEquals(expected, bitmap.getPixel(107, 107))
        assertEquals(expected, bitmap.getPixel(54, 54))
    }
}
