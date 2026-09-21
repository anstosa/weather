package farm.ballydidean.weather.debug

import farm.ballydidean.weather.widget.ForecastStatus
import farm.ballydidean.weather.widget.RainCondition
import farm.ballydidean.weather.widget.TemperatureUnit
import farm.ballydidean.weather.widget.WidgetGroup
import farm.ballydidean.weather.widget.WidgetPresentation
import farm.ballydidean.weather.widget.WidgetPresentationMode
import java.time.Instant

enum class FixtureVariant {
    MAXIMUM,
    NEAR_CUTOFF,
    ALL_BEDTIME,
    STALE,
    RAW_MIXED,
    CELSIUS;

    companion object {
        // parse only named debug fixtures
        fun fromWireName(value: String?): FixtureVariant {
            return entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: MAXIMUM
        }
    }
}

data class DebugWidgetFixture(
    val presentation: WidgetPresentation,
    val coveredIntervals: List<Int>,
)

object DebugWidgetFixtures {
    private val dayStart = Instant.parse("2026-11-01T07:00:00Z")

    // return one debug-only host fixture
    fun fixture(variant: FixtureVariant): DebugWidgetFixture {
        return when (variant) {
            FixtureVariant.MAXIMUM -> maximum(ForecastStatus.ADJUSTED, false, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.STALE -> maximum(ForecastStatus.ADJUSTED, true, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.RAW_MIXED -> maximum(ForecastStatus.MIXED, false, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.CELSIUS -> maximum(ForecastStatus.ADJUSTED, false, TemperatureUnit.CELSIUS, celsiusGroups())
            FixtureVariant.NEAR_CUTOFF -> build(
                groups = listOf(group("6–8p", "6–8 48–51", "6 PM through 8 PM", "48–51°", RainCondition.SPRINKLE, listOf(18, 19))),
                status = ForecastStatus.ADJUSTED,
                stale = false,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "go to bed",
                footer = "7:18 · adj · 0m · °F",
            )
            FixtureVariant.ALL_BEDTIME -> build(
                groups = emptyList(),
                status = ForecastStatus.ADJUSTED,
                stale = false,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "go to bed",
                footer = "7:18 · adj · 0m · °F",
                mode = WidgetPresentationMode.BEDTIME,
            )
        }
    }

    // combine the maximum-density debug case
    private fun maximum(
        status: ForecastStatus,
        stale: Boolean,
        unit: TemperatureUnit,
        groups: List<Pair<WidgetGroup, List<Int>>>,
    ): DebugWidgetFixture {
        val freshness = if (stale) "stale" else "0m"
        val provenance = when (status) {
            ForecastStatus.ADJUSTED -> "adj"
            ForecastStatus.MIXED -> "mix"
            ForecastStatus.RAW -> "raw"
            ForecastStatus.UNAVAILABLE -> "n/a"
        }
        return build(
            groups = groups,
            status = status,
            stale = stale,
            unit = unit,
            message = null,
            footer = "7:18 · $provenance · $freshness · ${unit.symbol}",
        )
    }

    // construct one complete debug presentation
    private fun build(
        groups: List<Pair<WidgetGroup, List<Int>>>,
        status: ForecastStatus,
        stale: Boolean,
        unit: TemperatureUnit,
        message: String?,
        footer: String,
        mode: WidgetPresentationMode = WidgetPresentationMode.WEATHER,
    ): DebugWidgetFixture {
        return DebugWidgetFixture(
            presentation = WidgetPresentation(
                date = "2026-11-01",
                groups = groups.map { it.first },
                status = status,
                stale = stale,
                hardExpired = false,
                mode = mode,
                showBedtime = message != null,
                message = message,
                footer = footer,
                sunset = Instant.parse("2026-11-02T00:50:59Z"),
                generatedAt = dayStart,
                unit = unit,
            ),
            coveredIntervals = groups.flatMap { it.second },
        )
    }

    // build one layout group and its coverage oracle
    private fun group(
        hourLabel: String,
        landscapeLabel: String,
        accessibleHours: String,
        temperatureLabel: String,
        condition: RainCondition,
        indexes: List<Int>,
    ): Pair<WidgetGroup, List<Int>> {
        val values = Regex("-?[0-9]+").findAll(temperatureLabel).map { it.value.toInt() }.toList()
        return WidgetGroup(
            start = dayStart.plusSeconds(indexes.first().toLong() * 3_600),
            end = dayStart.plusSeconds((indexes.last() + 1).toLong() * 3_600),
            hourCount = indexes.size,
            isNow = indexes.first() == 0,
            status = ForecastStatus.ADJUSTED,
            minimumTemperature = values.firstOrNull(),
            maximumTemperature = values.lastOrNull(),
            temperatureLabel = temperatureLabel,
            condition = condition,
            hourLabel = hourLabel,
            landscapeLabel = landscapeLabel,
            accessibleHours = accessibleHours,
        ) to indexes
    }

    // cover the 21 real fall-back intervals once
    private fun fahrenheitGroups(): List<Pair<WidgetGroup, List<Int>>> {
        return listOf(
            group("12·1a·1b", "12·1ᵃᵇ 38–41", "12 AM, first 1 AM, and repeated 1 AM", "38–41°", RainCondition.DRY, listOf(0, 1, 2)),
            group("2–4a", "2–4 37–40", "2 AM through 5 AM", "37–40°", RainCondition.SPRINKLE, listOf(3, 4, 5)),
            group("5–7a", "5–7 39–44", "5 AM through 8 AM", "39–44°", RainCondition.RAIN, listOf(6, 7, 8)),
            group("8–10a", "8–10 45–52", "8 AM through 11 AM", "45–52°", RainCondition.DRY, listOf(9, 10, 11)),
            group("11a–1p", "11–1 53–61", "11 AM through 2 PM", "53–61°", RainCondition.SPRINKLE, listOf(12, 13, 14)),
            group("2–4p", "2–4 57–63", "2 PM through 5 PM", "57–63°", RainCondition.RAIN, listOf(15, 16, 17)),
            group("5–7p", "5–7 48–56", "5 PM through 8 PM", "48–56°", RainCondition.DRY, listOf(18, 19, 20)),
        )
    }

    // retain the same intervals in celsius
    private fun celsiusGroups(): List<Pair<WidgetGroup, List<Int>>> {
        return listOf(
            group("12·1a·1b", "12·1ᵃᵇ 3–5", "12 AM, first 1 AM, and repeated 1 AM", "3–5°", RainCondition.DRY, listOf(0, 1, 2)),
            group("2–4a", "2–4 3–4", "2 AM through 5 AM", "3–4°", RainCondition.SPRINKLE, listOf(3, 4, 5)),
            group("5–7a", "5–7 4–7", "5 AM through 8 AM", "4–7°", RainCondition.RAIN, listOf(6, 7, 8)),
            group("8–10a", "8–10 7–11", "8 AM through 11 AM", "7–11°", RainCondition.DRY, listOf(9, 10, 11)),
            group("11a–1p", "11–1 12–16", "11 AM through 2 PM", "12–16°", RainCondition.SPRINKLE, listOf(12, 13, 14)),
            group("2–4p", "2–4 14–17", "2 PM through 5 PM", "14–17°", RainCondition.RAIN, listOf(15, 16, 17)),
            group("5–7p", "5–7 9–13", "5 PM through 8 PM", "9–13°", RainCondition.DRY, listOf(18, 19, 20)),
        )
    }
}
