package farm.ballydidean.weather

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream
import kotlin.math.ceil
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetIconInstrumentationTest {
    // access both instrumentation and target packages
    private val instrumentation: Instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    // map one packaged bitmap to its handoff reference
    private data class IconSpec(
        val label: String,
        val resourceId: Int,
        val referenceName: String,
    )

    // label one native raster inside review sheets
    private data class SheetEntry(val label: String, val bitmap: Bitmap)

    // verify exact handoff pixels and native-size rendering together
    @Test
    fun packagedWidgetIconsMatchHandoffAndRenderAtNativeSizes() {
        val context = instrumentation.targetContext
        val icons = listOf(
            IconSpec("sunny", R.drawable.ic_weather_sunny, "01-sunny.png"),
            IconSpec("sunny wind", R.drawable.ic_weather_sunny_wind, "02-sunny-wind.png"),
            IconSpec("partly cloudy", R.drawable.ic_weather_partly, "03-partly-cloudy.png"),
            IconSpec("partly cloudy wind", R.drawable.ic_weather_partly_wind, "04-partly-cloudy-wind.png"),
            IconSpec("cloudy", R.drawable.ic_weather_cloudy, "05-cloudy.png"),
            IconSpec("cloudy wind", R.drawable.ic_weather_cloudy_wind, "06-cloudy-wind.png"),
            IconSpec("light rain", R.drawable.ic_weather_light_rain, "07-light-rain.png"),
            IconSpec("light rain wind", R.drawable.ic_weather_light_rain_wind, "08-light-rain-wind.png"),
            IconSpec("heavy rain", R.drawable.ic_weather_heavy_rain, "09-heavy-rain.png"),
            IconSpec("heavy rain wind", R.drawable.ic_weather_heavy_rain_wind, "10-heavy-rain-wind.png"),
            IconSpec("bedtime", R.drawable.ic_weather_moon, "11-bedtime.png"),
            IconSpec("unavailable", R.drawable.ic_unavailable, "12-unavailable.png"),
            IconSpec("clear night", R.drawable.ic_weather_clear_night, "13-clear-night.png"),
            IconSpec("clear night wind", R.drawable.ic_weather_clear_night_wind, "14-clear-night-wind.png"),
            IconSpec("partly cloudy night", R.drawable.ic_weather_partly_night, "15-partly-cloudy-night.png"),
            IconSpec(
                "partly cloudy night wind",
                R.drawable.ic_weather_partly_night_wind,
                "16-partly-cloudy-night-wind.png",
            ),
        )
        // compare every packaged nodpi bitmap with its supplied reference
        for (icon in icons) {
            val drawable = context.getDrawable(icon.resourceId)
            assertTrue("${icon.label} is not a BitmapDrawable", drawable is BitmapDrawable)
            val reference = decodeReference(icon.referenceName)
            val actual = decodeResource(icon.resourceId)
            assertCanonicalBitmap("${icon.label} reference", reference)
            assertCanonicalBitmap("${icon.label} resource", actual)
            assertTrue("${icon.label} pixels differ from the handoff", reference.sameAs(actual))
        }
        val density = context.resources.displayMetrics.density
        val sheet40 = icons.map { icon ->
            SheetEntry(icon.label, renderResource(icon, 40, density, checkBounds = true))
        }
        val sheet20 = icons.map { icon ->
            SheetEntry(icon.label, renderResource(icon, 20, density, checkBounds = true))
        }
        val sheet112 = icons.map { icon ->
            SheetEntry(icon.label, renderResource(icon, 112, density, checkBounds = false))
        }
        val directory = File(context.cacheDir, "widget-icon-evidence").apply { mkdirs() }
        writePng(File(directory, "widget-icons-40dp.png"), contactSheet(sheet40, density, enlarged = false))
        writePng(File(directory, "widget-icons-20dp.png"), contactSheet(sheet20, density, enlarged = false))
        writePng(
            File(directory, "widget-icons-enlarged.png"),
            contactSheet(sheet112, density, enlarged = true),
        )
    }

    // decode one test-package handoff bitmap without density scaling
    private fun decodeReference(referenceName: String): Bitmap =
        instrumentation.context.assets.open("widget-icons-reference/$referenceName").use { input ->
            checkNotNull(BitmapFactory.decodeStream(input, null, bitmapOptions())) {
                "failed to decode reference $referenceName"
            }
        }

    // decode one target-package bitmap without density scaling
    private fun decodeResource(resourceId: Int): Bitmap =
        checkNotNull(
            BitmapFactory.decodeResource(
                instrumentation.targetContext.resources,
                resourceId,
                bitmapOptions(),
            ),
        ) { "failed to decode resource $resourceId" }

    // request stable unscaled comparison pixels
    private fun bitmapOptions(): BitmapFactory.Options = BitmapFactory.Options().apply {
        inScaled = false
        inPreferredConfig = Bitmap.Config.ARGB_8888
    }

    // require the canonical transparent handoff canvas
    private fun assertCanonicalBitmap(label: String, bitmap: Bitmap) {
        assertEquals("$label width", SOURCE_SIZE_PX, bitmap.width)
        assertEquals("$label height", SOURCE_SIZE_PX, bitmap.height)
        assertEquals("$label config", Bitmap.Config.ARGB_8888, bitmap.config)
        assertTrue("$label has no alpha channel", bitmap.hasAlpha())
        val bounds = opaqueBounds(bitmap)
        assertTrue("$label is empty", bounds.width() > 0 && bounds.height() > 0)
    }

    // draw one packaged bitmap at an exact native square size
    private fun renderResource(icon: IconSpec, sizeDp: Int, density: Float, checkBounds: Boolean): Bitmap {
        val sizePx = (sizeDp * density).roundToInt()
        val drawable = instrumentation.targetContext.getDrawable(icon.resourceId)
        assertTrue("${icon.label} is not a BitmapDrawable", drawable is BitmapDrawable)
        val bitmapDrawable = drawable as BitmapDrawable
        val guarded = Bitmap.createBitmap(
            sizePx + GUARD_PIXELS * 2,
            sizePx + GUARD_PIXELS * 2,
            Bitmap.Config.ARGB_8888,
        )
        bitmapDrawable.setBounds(0, 0, sizePx, sizePx)
        val canvas = Canvas(guarded)
        canvas.save()
        canvas.translate(GUARD_PIXELS.toFloat(), GUARD_PIXELS.toFloat())
        bitmapDrawable.draw(canvas)
        canvas.restore()
        val bounds = opaqueBounds(guarded)
        assertTrue("${icon.label} rendered empty at ${sizeDp}dp", bounds.width() > 0 && bounds.height() > 0)
        // reject bitmap paint outside the requested drawable rectangle
        if (checkBounds) {
            assertTrue("${icon.label} paints left of ${sizeDp}dp bounds", bounds.left >= GUARD_PIXELS)
            assertTrue("${icon.label} paints above ${sizeDp}dp bounds", bounds.top >= GUARD_PIXELS)
            assertTrue(
                "${icon.label} paints right of ${sizeDp}dp bounds",
                bounds.right <= GUARD_PIXELS + sizePx,
            )
            assertTrue(
                "${icon.label} paints below ${sizeDp}dp bounds",
                bounds.bottom <= GUARD_PIXELS + sizePx,
            )
        }
        val rendered = Bitmap.createBitmap(guarded, GUARD_PIXELS, GUARD_PIXELS, sizePx, sizePx)
        val renderedBounds = opaqueBounds(rendered)
        assertTrue(
            "${icon.label} has no in-bounds pixels at ${sizeDp}dp",
            renderedBounds.width() > 0 && renderedBounds.height() > 0,
        )
        return rendered
    }

    // find the nontransparent native raster boundary
    private fun opaqueBounds(bitmap: Bitmap): Rect {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        var minimumX = bitmap.width
        var minimumY = bitmap.height
        var maximumX = -1
        var maximumY = -1
        // retain every antialiased bitmap pixel
        pixels.forEachIndexed { index, color ->
            // expand the boundary only for visible pixels
            if (Color.alpha(color) > 0) {
                val x = index % bitmap.width
                val y = index / bitmap.width
                minimumX = minOf(minimumX, x)
                minimumY = minOf(minimumY, y)
                maximumX = maxOf(maximumX, x)
                maximumY = maxOf(maximumY, y)
            }
        }
        return Rect(minimumX, minimumY, maximumX + 1, maximumY + 1)
    }

    // arrange native raster outputs with plain descriptive labels
    private fun contactSheet(entries: List<SheetEntry>, density: Float, enlarged: Boolean): Bitmap {
        // use four columns only for the enlarged comparison
        val columns = if (enlarged) 4 else 2
        val padding = (6f * density).roundToInt()
        val displaySize = entries.maxOf { it.bitmap.width }
        val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(67, 46, 59)
            textSize = 10f * density
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
            textAlign = Paint.Align.CENTER
        }
        val labelHeight = ceil(labelPaint.fontMetrics.bottom - labelPaint.fontMetrics.top).toInt()
        val labelWidth = ceil(entries.maxOf { labelPaint.measureText(it.label) }).toInt()
        val cellWidth = maxOf(displaySize + padding * 2, labelWidth + padding * 2)
        val cellHeight = displaySize + labelHeight + padding * 3
        val rows = (entries.size + columns - 1) / columns
        val sheet = Bitmap.createBitmap(cellWidth * columns, cellHeight * rows, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(sheet).apply { drawColor(Color.WHITE) }
        val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { isFilterBitmap = false }
        // draw each preserved native raster and its label
        entries.forEachIndexed { index, entry ->
            val column = index % columns
            val row = index / columns
            val cellLeft = column * cellWidth
            val cellTop = row * cellHeight
            val iconLeft = cellLeft + (cellWidth - displaySize) / 2
            val iconTop = cellTop + padding
            canvas.drawBitmap(
                entry.bitmap,
                null,
                Rect(iconLeft, iconTop, iconLeft + displaySize, iconTop + displaySize),
                bitmapPaint,
            )
            val baseline = iconTop + displaySize + padding - labelPaint.fontMetrics.top
            canvas.drawText(entry.label, cellLeft + cellWidth / 2f, baseline, labelPaint)
        }
        return sheet
    }

    // persist one lossless review artifact in the app cache
    private fun writePng(file: File, bitmap: Bitmap) {
        FileOutputStream(file).use { output ->
            assertTrue("failed to write ${file.name}", bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        }
        assertTrue("empty icon evidence ${file.name}", file.length() > 0)
    }

    // retain exact handoff dimensions and render guard
    private companion object {
        const val SOURCE_SIZE_PX = 512
        const val GUARD_PIXELS = 4
    }
}
