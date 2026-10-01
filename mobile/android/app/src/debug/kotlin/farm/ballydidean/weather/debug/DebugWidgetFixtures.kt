package farm.ballydidean.weather.debug

import farm.ballydidean.weather.widget.ForecastStatus
import farm.ballydidean.weather.widget.RainCondition
import farm.ballydidean.weather.widget.TemperatureUnit
import farm.ballydidean.weather.widget.WeatherCondition
import farm.ballydidean.weather.widget.WidgetGroup
import farm.ballydidean.weather.widget.WidgetPresentation
import farm.ballydidean.weather.widget.WidgetPresentationMode
import farm.ballydidean.weather.widget.WidgetTemperatureTone
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class FixtureVariant {
    MAXIMUM,
    NEAR_CUTOFF,
    OVERNIGHT_FIFTH,
    ALL_BEDTIME,
    STALE,
    RAW_MIXED,
    RAW,
    UNAVAILABLE,
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
    private val fixtureSunset = Instant.parse("2026-11-02T03:30:00Z")
    private val fixtureCutoff = Instant.parse("2026-11-02T04:00:00Z")
    private val fixtureOvernightEnd = Instant.parse("2026-11-02T15:00:00Z")
    private val siteZone = ZoneId.of("America/Los_Angeles")
    private val timeFormatter = DateTimeFormatter.ofPattern("h:mm", Locale.US)
    private val hourFormatter = DateTimeFormatter.ofPattern("ha", Locale.US)

    // return one debug-only host fixture
    fun fixture(variant: FixtureVariant): DebugWidgetFixture {
        return when (variant) {
            FixtureVariant.MAXIMUM -> maximum(ForecastStatus.ADJUSTED, false, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.STALE -> maximum(ForecastStatus.ADJUSTED, true, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.RAW_MIXED -> maximum(
                ForecastStatus.MIXED,
                false,
                TemperatureUnit.FAHRENHEIT,
                mixedToneGroups(),
            )
            FixtureVariant.RAW -> maximum(ForecastStatus.RAW, false, TemperatureUnit.FAHRENHEIT, fahrenheitGroups())
            FixtureVariant.CELSIUS -> maximum(ForecastStatus.ADJUSTED, false, TemperatureUnit.CELSIUS, celsiusGroups())
            FixtureVariant.OVERNIGHT_FIFTH -> build(
                groups = listOf(
                    group("Now, 4 PM through 5 PM", "51°", RainCondition.DRY,
                        WeatherCondition.CLOUDY, listOf(17), WidgetTemperatureTone.NEUTRAL, isNow = true),
                    group("5 PM through 6 PM", "52°", RainCondition.DRY,
                        WeatherCondition.PARTLY_CLOUDY, listOf(18), WidgetTemperatureTone.NEUTRAL),
                    group("6 PM through 7 PM", "54°", RainCondition.DRY,
                        WeatherCondition.SUNNY, listOf(19), WidgetTemperatureTone.NEUTRAL),
                    group("7 PM through 8 PM", "55°", RainCondition.DRY,
                        WeatherCondition.PARTLY_CLOUDY, listOf(20), WidgetTemperatureTone.NEUTRAL),
                ),
                status = ForecastStatus.ADJUSTED,
                stale = false,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "43°",
                footer = footer(fixtureSunset, ForecastStatus.ADJUSTED, false, TemperatureUnit.FAHRENHEIT),
            )
            FixtureVariant.NEAR_CUTOFF -> build(
                groups = listOf(
                    group(
                        accessibleHours = "Now, 7 PM through 8 PM",
                        temperatureLabel = "49°",
                        condition = RainCondition.SPRINKLE,
                        weatherCondition = WeatherCondition.LIGHT_RAIN,
                        indexes = listOf(20),
                        isNow = true,
                        temperatureTone = WidgetTemperatureTone.COLD,
                    ),
                ),
                status = ForecastStatus.ADJUSTED,
                stale = false,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "43°",
                footer = footer(fixtureSunset, ForecastStatus.ADJUSTED, false, TemperatureUnit.FAHRENHEIT),
            )
            FixtureVariant.ALL_BEDTIME -> build(
                groups = emptyList(),
                status = ForecastStatus.ADJUSTED,
                stale = false,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "43°",
                footer = footer(fixtureSunset, ForecastStatus.ADJUSTED, false, TemperatureUnit.FAHRENHEIT),
                mode = WidgetPresentationMode.BEDTIME,
            )
            FixtureVariant.UNAVAILABLE -> build(
                groups = emptyList(),
                status = ForecastStatus.UNAVAILABLE,
                stale = true,
                unit = TemperatureUnit.FAHRENHEIT,
                message = "refresh needed",
                footer = "unavailable · °F",
                mode = WidgetPresentationMode.UNAVAILABLE,
                hardExpired = true,
                showBedtime = false,
                sunset = null,
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
        return build(
            groups = groups,
            status = status,
            stale = stale,
            unit = unit,
            message = null,
            footer = footer(fixtureSunset, status, stale, unit),
        )
    }

    // format retained fixture metadata from structured values
    private fun footer(
        sunset: Instant,
        status: ForecastStatus,
        stale: Boolean,
        unit: TemperatureUnit,
    ): String {
        val sunsetText = sunset.atZone(siteZone).format(timeFormatter)
        val freshness = if (stale) "stale" else "0m"
        val provenance = when (status) {
            ForecastStatus.ADJUSTED -> "adj"
            ForecastStatus.MIXED -> "mix"
            ForecastStatus.RAW -> "raw"
            ForecastStatus.UNAVAILABLE -> "n/a"
        }
        return "$sunsetText · $provenance · $freshness · ${unit.symbol}"
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
        hardExpired: Boolean = false,
        showBedtime: Boolean = message != null,
        sunset: Instant? = fixtureSunset,
        bedtimeStart: Instant? = fixtureCutoff,
        bedtimeEnd: Instant? = fixtureOvernightEnd,
    ): DebugWidgetFixture {
        return DebugWidgetFixture(
            presentation = WidgetPresentation(
                date = "2026-11-01",
                groups = groups.map { it.first.copy(status = status) },
                status = status,
                stale = stale,
                hardExpired = hardExpired,
                mode = mode,
                showBedtime = showBedtime,
                message = message,
                footer = footer,
                sunset = sunset,
                generatedAt = dayStart,
                unit = unit,
                bedtimeStart = bedtimeStart,
                bedtimeEnd = bedtimeEnd,
                // use a real weather summary rather than the former bedtime illustration
                overnight = if (showBedtime) group(
                    "Overnight, 8 PM PST through 7 AM PST, low", "43°", RainCondition.DRY,
                    WeatherCondition.PARTLY_CLOUDY, (21..31).toList(), WidgetTemperatureTone.COLD,
                    highWind = true, isNow = false,
                ).first.copy(hourLabel = "Overnight", isNight = true, status = status) else null,
            ),
            coveredIntervals = groups.flatMap { it.second },
        )
    }

    // build one layout group and its coverage oracle
    private fun group(
        accessibleHours: String,
        temperatureLabel: String,
        condition: RainCondition,
        weatherCondition: WeatherCondition,
        indexes: List<Int>,
        temperatureTone: WidgetTemperatureTone,
        highWind: Boolean = false,
        isNow: Boolean = indexes.first() == 0,
    ): Pair<WidgetGroup, List<Int>> {
        val start = dayStart.plusSeconds(indexes.first().toLong() * 3_600)
        // derive clock labels across the fall-back transition
        val hourLabel = if (isNow) "Now" else start.atZone(siteZone).format(hourFormatter).lowercase(Locale.US)
        val values = Regex("-?[0-9]+").findAll(temperatureLabel).map { it.value.toInt() }.toList()
        return WidgetGroup(
            start = start,
            end = dayStart.plusSeconds((indexes.last() + 1).toLong() * 3_600),
            hourCount = indexes.size,
            isNow = isNow,
            status = ForecastStatus.ADJUSTED,
            minimumTemperature = values.firstOrNull(),
            maximumTemperature = values.lastOrNull(),
            temperatureLabel = temperatureLabel,
            condition = condition,
            hourLabel = hourLabel,
            landscapeLabel = hourLabel,
            accessibleHours = accessibleHours,
            weatherCondition = weatherCondition,
            highWind = highWind,
            temperatureTone = temperatureTone,
        ) to indexes
    }

    // cover the 21 real fall-back intervals in five full-height groups
    private fun fahrenheitGroups(): List<Pair<WidgetGroup, List<Int>>> {
        return listOf(
            group("Now, 12 AM through 1 AM", "39°", RainCondition.DRY,
                WeatherCondition.SUNNY, listOf(0), isNow = true, temperatureTone = WidgetTemperatureTone.COLD),
            group("first 1 AM through 4 AM, including repeated 1 AM", "40°", RainCondition.DRY,
                WeatherCondition.PARTLY_CLOUDY, (1..4).toList(), highWind = true,
                temperatureTone = WidgetTemperatureTone.COLD),
            group("4 AM through 7 AM", "42°", RainCondition.SPRINKLE,
                WeatherCondition.LIGHT_RAIN, (5..7).toList(), temperatureTone = WidgetTemperatureTone.COLD),
            group("7 AM through 2 PM", "53°", RainCondition.DRY,
                WeatherCondition.CLOUDY, (8..14).toList(), temperatureTone = WidgetTemperatureTone.NEUTRAL),
            group("2 PM through 8 PM", "58°", RainCondition.RAIN,
                WeatherCondition.HEAVY_RAIN, (15..20).toList(), temperatureTone = WidgetTemperatureTone.NEUTRAL),
        )
    }

    // expose warm and hot native color fixtures without changing interval coverage
    private fun mixedToneGroups(): List<Pair<WidgetGroup, List<Int>>> {
        return listOf(
            group("Now, 12 AM through 1 AM", "39°", RainCondition.DRY,
                WeatherCondition.SUNNY, listOf(0), isNow = true, temperatureTone = WidgetTemperatureTone.COLD),
            group("first 1 AM through 4 AM, including repeated 1 AM", "49°", RainCondition.DRY,
                WeatherCondition.PARTLY_CLOUDY, (1..4).toList(), highWind = true,
                temperatureTone = WidgetTemperatureTone.COLD),
            group("4 AM through 7 AM", "65°", RainCondition.SPRINKLE,
                WeatherCondition.LIGHT_RAIN, (5..7).toList(),
                temperatureTone = WidgetTemperatureTone.NEUTRAL),
            group("7 AM through 2 PM", "75°", RainCondition.DRY,
                WeatherCondition.CLOUDY, (8..14).toList(), temperatureTone = WidgetTemperatureTone.WARM),
            group("2 PM through 8 PM", "85°", RainCondition.RAIN,
                WeatherCondition.HEAVY_RAIN, (15..20).toList(), temperatureTone = WidgetTemperatureTone.HOT),
        )
    }

    // retain the same intervals in celsius
    private fun celsiusGroups(): List<Pair<WidgetGroup, List<Int>>> {
        return listOf(
            group("Now, 12 AM through 1 AM", "4°", RainCondition.DRY,
                WeatherCondition.SUNNY, listOf(0), isNow = true, temperatureTone = WidgetTemperatureTone.COLD),
            group("first 1 AM through 4 AM, including repeated 1 AM", "4°", RainCondition.DRY,
                WeatherCondition.PARTLY_CLOUDY, (1..4).toList(), highWind = true,
                temperatureTone = WidgetTemperatureTone.COLD),
            group("4 AM through 7 AM", "6°", RainCondition.SPRINKLE,
                WeatherCondition.LIGHT_RAIN, (5..7).toList(), temperatureTone = WidgetTemperatureTone.COLD),
            group("7 AM through 2 PM", "12°", RainCondition.DRY,
                WeatherCondition.CLOUDY, (8..14).toList(), temperatureTone = WidgetTemperatureTone.NEUTRAL),
            group("2 PM through 8 PM", "14°", RainCondition.RAIN,
                WeatherCondition.HEAVY_RAIN, (15..20).toList(), temperatureTone = WidgetTemperatureTone.NEUTRAL),
        )
    }
}
