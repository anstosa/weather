package farm.ballydidean.weather.widget

import java.time.Duration
import java.time.Instant

internal object WidgetRowGeometry {
    const val MIN_WEATHER_SEGMENTS = 5

    // fit six panels at 384dp while keeping narrower weather panels within one fifth
    fun capacity(widthDp: Int): Int = maxOf(MIN_WEATHER_SEGMENTS, widthDp / 64)

    // share dense rows equally and reserve unused fifths for overnight
    fun weatherFraction(presentation: WidgetPresentation): Double {
        return 1.0 / maxOf(MIN_WEATHER_SEGMENTS, presentation.groups.size)
    }

    // mark interior hours without duplicating the segment's existing edge dividers
    fun hourTickFractions(start: Instant, end: Instant): List<Double> {
        val durationMillis = Duration.between(start, end).toMillis()
        val hourMillis = Duration.ofHours(1).toMillis()
        // leave single-hour and invalid ranges unmarked
        if (durationMillis <= hourMillis) return emptyList()
        // use elapsed hours so overnight ranges include dst transitions correctly
        return (hourMillis until durationMillis step hourMillis).map { offset ->
            offset.toDouble() / durationMillis
        }
    }

    // shade only the post-sunset fraction of future weather panels
    fun postSunsetStartFraction(group: WidgetGroup, sunset: Instant?): Double? {
        // keep now white and wholly daytime forecasts light
        if (group.isNow || sunset == null || sunset >= group.end) return null
        // shade the entire panel when sunset has already passed
        if (sunset <= group.start) return 0.0
        return Duration.between(group.start, sunset).toMillis().toDouble() /
            Duration.between(group.start, group.end).toMillis()
    }
}
