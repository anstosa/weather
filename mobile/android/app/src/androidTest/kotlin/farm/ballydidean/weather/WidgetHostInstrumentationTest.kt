package farm.ballydidean.weather

import android.app.Instrumentation
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.RectF
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.View.MeasureSpec
import android.widget.TextView
import androidx.test.platform.app.InstrumentationRegistry
import farm.ballydidean.weather.debug.FixtureHostActivity
import farm.ballydidean.weather.widget.FixtureVariant
import java.io.File
import java.io.FileOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WidgetHostInstrumentationTest {
    private val instrumentation: Instrumentation
        get() = InstrumentationRegistry.getInstrumentation()

    // verify portrait maximum content on a real host view
    @Test
    fun testMaximumPortrait() {
        verifyRenderedWidget(
            FixtureHostActivity.PORTRAIT_WIDTH_DP,
            FixtureHostActivity.PORTRAIT_HEIGHT_DP,
            FixtureVariant.MAXIMUM,
            expectedGroups = 7,
            expectedBedtime = false,
        )
    }

    // verify landscape maximum content on a real host view
    @Test
    fun testMaximumLandscape() {
        verifyRenderedWidget(
            FixtureHostActivity.LANDSCAPE_WIDTH_DP,
            FixtureHostActivity.LANDSCAPE_HEIGHT_DP,
            FixtureVariant.MAXIMUM,
            expectedGroups = 7,
            expectedBedtime = false,
        )
    }

    // verify near-cutoff weather and bedtime together
    @Test
    fun testNearCutoffPortrait() {
        verifyRenderedWidget(
            FixtureHostActivity.PORTRAIT_WIDTH_DP,
            FixtureHostActivity.PORTRAIT_HEIGHT_DP,
            FixtureVariant.NEAR_CUTOFF,
            expectedGroups = 1,
            expectedBedtime = true,
        )
    }

    // verify all post-cutoff space stays non-weather
    @Test
    fun testAllBedtimeLandscape() {
        verifyRenderedWidget(
            FixtureHostActivity.LANDSCAPE_WIDTH_DP,
            FixtureHostActivity.LANDSCAPE_HEIGHT_DP,
            FixtureVariant.ALL_BEDTIME,
            expectedGroups = 0,
            expectedBedtime = true,
        )
    }

    // verify stale provenance keeps full weather and credit
    @Test
    fun testStalePortrait() {
        verifyRenderedWidget(
            FixtureHostActivity.PORTRAIT_WIDTH_DP,
            FixtureHostActivity.PORTRAIT_HEIGHT_DP,
            FixtureVariant.STALE,
            expectedGroups = 7,
            expectedBedtime = false,
        )
    }

    // verify mixed raw provenance stays visible
    @Test
    fun testRawMixedPortrait() {
        verifyRenderedWidget(
            FixtureHostActivity.PORTRAIT_WIDTH_DP,
            FixtureHostActivity.PORTRAIT_HEIGHT_DP,
            FixtureVariant.RAW_MIXED,
            expectedGroups = 7,
            expectedBedtime = false,
        )
    }

    // verify celsius preserves the same dense geometry
    @Test
    fun testCelsiusPortrait() {
        verifyRenderedWidget(
            FixtureHostActivity.PORTRAIT_WIDTH_DP,
            FixtureHostActivity.PORTRAIT_HEIGHT_DP,
            FixtureVariant.CELSIUS,
            expectedGroups = 7,
            expectedBedtime = false,
        )
    }

    // prove the glyph oracle rejects a clipped descender
    @Test
    fun testGlyphBoundaryDetectorRejectsClippedDescender() {
        val textView = TextView(instrumentation.targetContext).apply {
            text = "5–7p"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            includeFontPadding = false
            gravity = Gravity.CENTER
            maxLines = 1
        }
        val density = instrumentation.targetContext.resources.displayMetrics.density
        textView.measure(
            MeasureSpec.makeMeasureSpec((80 * density).toInt(), MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec((10 * density).toInt(), MeasureSpec.EXACTLY),
        )
        textView.layout(0, 0, textView.measuredWidth, textView.measuredHeight)
        assertTrue("clipped descender escaped the glyph oracle", glyphsCrossVerticalBoundary(textView))
    }

    // inspect the inflated remoteviews hierarchy
    private fun verifyRenderedWidget(
        widthDp: Int,
        heightDp: Int,
        variant: FixtureVariant,
        expectedGroups: Int,
        expectedBedtime: Boolean,
    ) {
        val landscape = heightDp == FixtureHostActivity.LANDSCAPE_HEIGHT_DP
        setOrientation(instrumentation, landscape)
        adoptWidgetBinding(instrumentation)
        val intent = Intent(instrumentation.targetContext, FixtureHostActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(FixtureHostActivity.EXTRA_WIDTH_DP, widthDp)
            putExtra(FixtureHostActivity.EXTRA_HEIGHT_DP, heightDp)
            putExtra(FixtureHostActivity.EXTRA_VARIANT, variant.name)
        }
        val activity = instrumentation.startActivitySync(intent) as FixtureHostActivity
        try {
            val hostView = waitForHostView(activity, variant, landscape)
            val allViews = mutableListOf<View>()
            collectViews(hostView, allViews)
            val density = activity.resources.displayMetrics.density
            assertEquals((widthDp * density).toInt(), hostView.width)
            assertEquals((heightDp * density).toInt(), hostView.height)
            val groupDescriptions = allViews.mapNotNull { it.contentDescription?.toString() }
                .filter { it.contains("through") || it.contains("repeated") }
            assertEquals(expectedGroups, groupDescriptions.size)
            // match the size-specific visible interval labels
            val expectedHourLabels = farm.ballydidean.weather.widget.WidgetFixture.forVariant(variant)
                .groups.map { if (landscape) it.landscapeLabel else it.hourLabel }.toSet()
            val visibleHourLabels = allViews.filterIsInstance<TextView>().map { it.text.toString() }
                .filter { it in expectedHourLabels }.toSet()
            assertEquals(expectedHourLabels, visibleHourLabels)
            assertVisibleTextWithinHost(hostView, allViews)
            val bedtimeVisible = allViews.filterIsInstance<TextView>().any { it.text.toString() == "go to bed" }
            assertEquals(expectedBedtime, bedtimeVisible)
            // require visible credit whenever weather exists
            if (expectedGroups > 0) {
                val visibleText = allViews.filterIsInstance<TextView>().filter { it.visibility == View.VISIBLE }
                    .joinToString(" ") { it.text }
                assertTrue(visibleText.contains("Open-Meteo"))
                assertTrue(visibleText.contains("CC BY 4.0"))
            }
            val fontScale = activity.resources.configuration.fontScale.toString().replace('.', '_')
            val nightMode = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            // name the active day or night palette
            val appearance = if (nightMode == Configuration.UI_MODE_NIGHT_YES) "dark" else "light"
            captureScreenshot(activity, "${variant.name.lowercase()}-${widthDp}x${heightDp}-font${fontScale}-${appearance}")
            assertNoTextClipping(allViews)
        } finally {
            // release the host allocation between cases
            instrumentation.runOnMainSync(activity::finish)
            instrumentation.waitForIdleSync()
            instrumentation.uiAutomation.dropShellPermissionIdentity()
        }
    }

    // wait for appwidgethost to receive provider remoteviews
    private fun waitForHostView(
        activity: FixtureHostActivity,
        variant: FixtureVariant,
        landscape: Boolean,
    ): View {
        var lastText = ""
        // wait through bounded host callbacks
        repeat(50) {
            instrumentation.waitForIdleSync()
            val candidate = activity.renderedHostView
            // retain the last hierarchy for actionable failures
            if (candidate != null) {
                val allViews = mutableListOf<View>()
                collectViews(candidate, allViews)
                lastText = allViews.filterIsInstance<TextView>().joinToString(" | ") { it.text }
            }
            // return after the provider view arrives
            if (candidate != null && candidate.childCount > 0 && matchesVariant(candidate, variant, landscape)) {
                return candidate
            }
            SystemClock.sleep(100)
        }
        fail("AppWidgetHost did not render expected provider RemoteViews: $lastText")
        error("unreachable")
    }

    // reject the provider's initial maximum update for alternate fixtures
    private fun matchesVariant(view: View, variant: FixtureVariant, landscape: Boolean): Boolean {
        val allViews = mutableListOf<View>()
        collectViews(view, allViews)
        val text = allViews.filterIsInstance<TextView>().joinToString(" ") { it.text }
        return when (variant) {
            FixtureVariant.MAXIMUM -> text.contains(if (landscape) "12·1ᵃᵇ 38–41" else "12·1a·1b")
            FixtureVariant.NEAR_CUTOFF -> text.contains(if (landscape) "6–8 48–51" else "6–8p")
            FixtureVariant.ALL_BEDTIME -> text.contains("go to bed")
            FixtureVariant.STALE -> text.contains("stale")
            FixtureVariant.RAW_MIXED -> text.contains("mixed")
            FixtureVariant.CELSIUS -> text.contains("°C")
        }
    }

    // flatten the host hierarchy for semantic inspection
    private fun collectViews(view: View, destination: MutableList<View>) {
        destination += view
        // visit every inflated child
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                collectViews(view.getChildAt(index), destination)
            }
        }
    }

    // reject ellipsized or visibly clipped text and sub-12sp normal text
    private fun assertNoTextClipping(views: List<View>) {
        val scaledDensity = instrumentation.targetContext.resources.displayMetrics.scaledDensity
        val textViews = views.filterIsInstance<TextView>().filter { it.visibility == View.VISIBLE && it.text.isNotEmpty() }
        // inspect every visible text node
        for (textView in textViews) {
            val layout = textView.layout
            // reject incomplete line layout
            if (layout != null) {
                for (line in 0 until layout.lineCount) {
                    assertEquals("ellipsized: ${textView.text}", 0, layout.getEllipsisCount(line))
                    val availableWidth = textView.width - textView.paddingLeft - textView.paddingRight
                    assertTrue(
                        "horizontally clipped: ${textView.text}",
                        layout.getLineWidth(line) <= availableWidth + 0.5f,
                    )
                }
            }
            assertTrue(
                "vertically clipped glyph: ${textView.text} bounds=${glyphBounds(textView)} height=${textView.height}",
                !glyphsCrossVerticalBoundary(textView),
            )
            assertTrue("below 12sp: ${textView.text}", textView.textSize / scaledDensity >= 11.99f)
            assertTrue("zero-size text: ${textView.text}", textView.width > 0 && textView.height > 0)
        }
    }

    // compare real font outlines with the allocated text rectangle
    private fun glyphsCrossVerticalBoundary(textView: TextView): Boolean {
        val bounds = glyphBounds(textView) ?: return false
        return bounds.top < 1f || bounds.bottom > textView.height - 1f
    }

    // combine every real glyph outline in local view coordinates
    private fun glyphBounds(textView: TextView): RectF? {
        val layout = textView.layout ?: return null
        val value = textView.text.toString()
        var combined: RectF? = null
        // inspect every laid-out line outline
        for (line in 0 until layout.lineCount) {
            val path = Path()
            textView.paint.getTextPath(
                value,
                layout.getLineStart(line),
                layout.getLineEnd(line),
                layout.getLineLeft(line) + textView.totalPaddingLeft,
                layout.getLineBaseline(line).toFloat() + textView.totalPaddingTop,
                path,
            )
            val bounds = RectF()
            path.computeBounds(bounds, true)
            // retain only visible glyph geometry
            if (!bounds.isEmpty) {
                val existing = combined
                // merge later line bounds into the first
                if (existing == null) {
                    combined = bounds
                } else {
                    existing.union(bounds)
                }
            }
        }
        return combined
    }

    // keep every visible text rectangle inside the real host allocation
    private fun assertVisibleTextWithinHost(hostView: View, views: List<View>) {
        val hostLocation = IntArray(2).also(hostView::getLocationOnScreen)
        val hostLeft = hostLocation[0]
        val hostTop = hostLocation[1]
        val hostRight = hostLeft + hostView.width
        val hostBottom = hostTop + hostView.height
        val textViews = views.filterIsInstance<TextView>().filter { it.visibility == View.VISIBLE && it.text.isNotEmpty() }
        // inspect every visible text rectangle
        for (textView in textViews) {
            val location = IntArray(2).also(textView::getLocationOnScreen)
            assertTrue("left overflow: ${textView.text}", location[0] >= hostLeft)
            assertTrue("top overflow: ${textView.text}", location[1] >= hostTop)
            assertTrue("right overflow: ${textView.text}", location[0] + textView.width <= hostRight)
            assertTrue("bottom overflow: ${textView.text}", location[1] + textView.height <= hostBottom)
            assertTextWithinClippingAncestors(hostView, textView, location)
        }
    }

    // keep each text rectangle inside every clipping parent
    private fun assertTextWithinClippingAncestors(hostView: View, textView: TextView, textLocation: IntArray) {
        val textRight = textLocation[0] + textView.width
        val textBottom = textLocation[1] + textView.height
        var ancestor = textView.parent as? View
        // inspect parents through the real host boundary
        while (ancestor != null) {
            val location = IntArray(2).also(ancestor::getLocationOnScreen)
            val ancestorRight = location[0] + ancestor.width
            val ancestorBottom = location[1] + ancestor.height
            assertTrue(
                "ancestor left clip: ${textView.text} text=${textLocation[0]} parent=${location[0]}",
                textLocation[0] >= location[0],
            )
            assertTrue("ancestor top clip: ${textView.text}", textLocation[1] >= location[1])
            assertTrue(
                "ancestor right clip: ${textView.text} text=$textRight parent=$ancestorRight",
                textRight <= ancestorRight,
            )
            assertTrue("ancestor bottom clip: ${textView.text}", textBottom <= ancestorBottom)
            // stop after checking the allocation boundary
            if (ancestor === hostView) {
                break
            }
            ancestor = ancestor.parent as? View
        }
    }

    // preserve host evidence inside app external cache
    private fun captureScreenshot(activity: FixtureHostActivity, name: String) {
        val bitmap: Bitmap = instrumentation.uiAutomation.takeScreenshot()
        val directory = File(activity.externalCacheDir, "widget-host-evidence").apply { mkdirs() }
        FileOutputStream(File(directory, "$name.png")).use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        }
    }

    companion object {
        // set the actual device orientation for the requested minimum
        private fun setOrientation(instrumentation: Instrumentation, landscape: Boolean) {
            // choose portrait or landscape rotation
            val rotation = if (landscape) 1 else 0
            val fixedRotation = instrumentation.uiAutomation.executeShellCommand("wm fixed-to-user-rotation enabled")
            ParcelFileDescriptor.AutoCloseInputStream(fixedRotation).use { it.readBytes() }
            val userRotation = instrumentation.uiAutomation.executeShellCommand("wm user-rotation lock $rotation")
            ParcelFileDescriptor.AutoCloseInputStream(userRotation).use { it.readBytes() }
            SystemClock.sleep(1_500)
        }

        // adopt test-only binding authority for binder calls
        private fun adoptWidgetBinding(instrumentation: Instrumentation) {
            instrumentation.uiAutomation.adoptShellPermissionIdentity(android.Manifest.permission.BIND_APPWIDGET)
        }
    }
}
