package farm.ballydidean.weather.widget

enum class RainCondition(val accessibleName: String) {
    DRY("dry"),
    SPRINKLE("sprinkle"),
    RAIN("rain")
}

data class FixtureGroup(
    val hourLabel: String,
    val landscapeLabel: String,
    val accessibleHours: String,
    val temperatureLabel: String,
    val condition: RainCondition,
    val intervalIndexes: List<Int>
) {
    // describe every visible group semantic
    fun accessibilityLabel(): String {
        return "$accessibleHours, $temperatureLabel, ${condition.accessibleName}"
    }
}

enum class FixtureVariant {
    MAXIMUM,
    NEAR_CUTOFF,
    ALL_BEDTIME,
    STALE,
    RAW_MIXED,
    CELSIUS;

    companion object {
        // parse only named fixture variants
        fun fromWireName(value: String?): FixtureVariant {
            return entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: MAXIMUM
        }
    }
}

data class WidgetFixture(
    val groups: List<FixtureGroup>,
    val footer: String,
    val showBedtime: Boolean,
    val showCredit: Boolean = groups.isNotEmpty()
) {
    // flatten real-hour coverage for the test oracle
    fun coveredIntervals(): List<Int> {
        return groups.flatMap { it.intervalIndexes }
    }

    companion object {
        // return the requested deterministic spike
        fun forVariant(variant: FixtureVariant): WidgetFixture {
            return when (variant) {
                FixtureVariant.MAXIMUM -> maximumDensity("adjusted · °F", fahrenheitGroups())
                FixtureVariant.STALE -> maximumDensity("stale · °F", fahrenheitGroups())
                FixtureVariant.RAW_MIXED -> maximumDensity("mixed · °F", fahrenheitGroups())
                FixtureVariant.CELSIUS -> maximumDensity("adjusted · °C", celsiusGroups())
                FixtureVariant.NEAR_CUTOFF -> WidgetFixture(
                    groups = listOf(
                        FixtureGroup("6–8p", "6–8 48–51", "6 PM through 8 PM", "48–51°", RainCondition.SPRINKLE, listOf(18, 19))
                    ),
                    footer = "Sun 7:18 · current",
                    showBedtime = true
                )
                FixtureVariant.ALL_BEDTIME -> WidgetFixture(
                    groups = emptyList(),
                    footer = "Sun 7:18 · after 8 PM",
                    showBedtime = true,
                    showCredit = false
                )
            }
        }

        // join status to the fixed sunset
        private fun maximumDensity(status: String, groups: List<FixtureGroup>): WidgetFixture {
            return WidgetFixture(groups, "Sun 7:18 · $status", showBedtime = false)
        }

        // cover the 21 real fall-back intervals once
        private fun fahrenheitGroups(): List<FixtureGroup> {
            return listOf(
                FixtureGroup("12·1a·1b", "12·1ᵃᵇ 38–41", "12 AM, first 1 AM, and repeated 1 AM", "38–41°", RainCondition.DRY, listOf(0, 1, 2)),
                FixtureGroup("2–4a", "2–4 37–40", "2 AM through 5 AM", "37–40°", RainCondition.SPRINKLE, listOf(3, 4, 5)),
                FixtureGroup("5–7a", "5–7 39–44", "5 AM through 8 AM", "39–44°", RainCondition.RAIN, listOf(6, 7, 8)),
                FixtureGroup("8–10a", "8–10 45–52", "8 AM through 11 AM", "45–52°", RainCondition.DRY, listOf(9, 10, 11)),
                FixtureGroup("11a–1p", "11–1 53–61", "11 AM through 2 PM", "53–61°", RainCondition.SPRINKLE, listOf(12, 13, 14)),
                FixtureGroup("2–4p", "2–4 57–63", "2 PM through 5 PM", "57–63°", RainCondition.RAIN, listOf(15, 16, 17)),
                FixtureGroup("5–7p", "5–7 48–56", "5 PM through 8 PM", "48–56°", RainCondition.DRY, listOf(18, 19, 20))
            )
        }

        // retain the same intervals in celsius
        private fun celsiusGroups(): List<FixtureGroup> {
            return listOf(
                FixtureGroup("12·1a·1b", "12·1ᵃᵇ 3–5", "12 AM, first 1 AM, and repeated 1 AM", "3–5°", RainCondition.DRY, listOf(0, 1, 2)),
                FixtureGroup("2–4a", "2–4 3–4", "2 AM through 5 AM", "3–4°", RainCondition.SPRINKLE, listOf(3, 4, 5)),
                FixtureGroup("5–7a", "5–7 4–7", "5 AM through 8 AM", "4–7°", RainCondition.RAIN, listOf(6, 7, 8)),
                FixtureGroup("8–10a", "8–10 7–11", "8 AM through 11 AM", "7–11°", RainCondition.DRY, listOf(9, 10, 11)),
                FixtureGroup("11a–1p", "11–1 12–16", "11 AM through 2 PM", "12–16°", RainCondition.SPRINKLE, listOf(12, 13, 14)),
                FixtureGroup("2–4p", "2–4 14–17", "2 PM through 5 PM", "14–17°", RainCondition.RAIN, listOf(15, 16, 17)),
                FixtureGroup("5–7p", "5–7 9–13", "5 PM through 8 PM", "9–13°", RainCondition.DRY, listOf(18, 19, 20))
            )
        }
    }
}
