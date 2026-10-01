package farm.ballydidean.weather

import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.graphics.Insets
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.FrameLayout
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@TargetApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
@SdkSuppress(minSdkVersion = 35)
// verify the real hosted shell at the forced edge-to-edge boundary
class HostedShellInsetsInstrumentationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val handledInsets = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()

    // protect both the hosted page and the native retry overlay on a real window
    @Test
    fun visibleContentStaysInsideSystemBarsAndCutouts() {
        withShell { root ->
            awaitLayout(root)
            instrumentation.runOnMainSync {
                val safeArea = root.rootWindowInsets.getInsets(handledInsets)
                assertTrue("test device must expose a top system inset", safeArea.top > 0)
                assertPadding(root, safeArea)
                // check whichever production layer is visible without depending on network access
                for (index in 0 until root.childCount) {
                    val child = root.getChildAt(index)
                    // ignore the inactive retry or browser layer
                    if (child.visibility == View.VISIBLE) {
                        assertTrue("content overlaps the status bar", child.top >= safeArea.top)
                        assertTrue("content overlaps the navigation bar", child.bottom <= root.height - safeArea.bottom)
                    }
                }
            }
        }
    }

    // keep rotated cutouts safe without accumulating padding or swallowing keyboard updates
    @Test
    fun repeatedInsetsReplacePaddingAndPreserveImeForChildren() {
        withShell { root ->
            instrumentation.runOnMainSync {
                var forwarded: WindowInsets? = null
                val observer = View(context).apply {
                    // observe the inset contract after the native shell has handled system bars
                    setOnApplyWindowInsetsListener { _, insets ->
                        forwarded = insets
                        insets
                    }
                }
                root.addView(observer, FrameLayout.LayoutParams(1, 1))
                val keyboard = Insets.of(0, 0, 0, 420)
                val incoming = WindowInsets.Builder()
                    .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, 80, 0, 0))
                    .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, 48))
                    .setInsets(WindowInsets.Type.displayCutout(), Insets.of(100, 0, 20, 0))
                    .setInsets(WindowInsets.Type.ime(), keyboard)
                    .build()
                root.dispatchApplyWindowInsets(incoming)
                root.dispatchApplyWindowInsets(incoming)
                assertPadding(root, Insets.of(100, 80, 20, 48))
                assertEquals(Insets.NONE, checkNotNull(forwarded).getInsets(handledInsets))
                assertEquals(keyboard, checkNotNull(forwarded).getInsets(WindowInsets.Type.ime()))
                val portrait = WindowInsets.Builder(incoming)
                    .setInsets(WindowInsets.Type.displayCutout(), Insets.NONE)
                    .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, 120, 0, 0))
                    .build()
                root.dispatchApplyWindowInsets(portrait)
                assertPadding(root, Insets.of(0, 120, 0, 48))
                root.removeView(observer)
            }
        }
    }

    // launch an offline fixture without touching hosted cookies or production analytics
    private fun withShell(check: (FrameLayout) -> Unit) {
        val preferences = context.getSharedPreferences("hosted-shell-debug-fixture", Context.MODE_PRIVATE)
        val previousOrigin = preferences.getString("origin", null)
        var activity: MainActivity? = null
        try {
            val intent = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                putExtra(HostedTestConfiguration.EXTRA_FIXTURE_ORIGIN, "https://127.0.0.1:1")
            }
            val launched = instrumentation.startActivitySync(intent) as MainActivity
            activity = launched
            val content = launched.findViewById<ViewGroup>(android.R.id.content)
            check(content.getChildAt(0) as FrameLayout)
        } finally {
            // finish only the activity created by this test
            activity?.let { launched -> instrumentation.runOnMainSync(launched::finish) }
            instrumentation.waitForIdleSync()
            preferences.edit().putString("origin", previousOrigin).commit()
        }
    }

    // wait for actual platform inset dispatch and layout rather than a fixed delay
    private fun awaitLayout(root: FrameLayout) {
        val deadline = SystemClock.uptimeMillis() + 10_000
        // bound device scheduling delays while keeping geometry reads on the ui thread
        while (SystemClock.uptimeMillis() < deadline) {
            var ready = false
            instrumentation.runOnMainSync {
                ready = root.isLaidOut && !root.isLayoutRequested && root.rootWindowInsets != null
            }
            // return only after a completed layout
            if (ready) return
            SystemClock.sleep(25)
        }
        throw AssertionError("hosted shell did not receive window insets and layout")
    }

    // assert every edge so landscape cutouts and navigation bars stay protected
    private fun assertPadding(root: FrameLayout, expected: Insets) {
        assertEquals("left inset", expected.left, root.paddingLeft)
        assertEquals("top inset", expected.top, root.paddingTop)
        assertEquals("right inset", expected.right, root.paddingRight)
        assertEquals("bottom inset", expected.bottom, root.paddingBottom)
    }
}
