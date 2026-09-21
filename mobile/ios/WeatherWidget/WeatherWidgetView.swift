import SwiftUI
import WidgetKit

struct WeatherWidgetEntry: TimelineEntry {
    let date: Date
    let display: WeatherWidgetDisplay
}

struct WeatherWidgetEntryView: View {
    static let providerURL = URL(string: "https://open-meteo.com/")!
    static let licenseURL = URL(string: "https://creativecommons.org/licenses/by/4.0/")!
    static let forecastURL = URL(string: "ballydidean-weather://forecast")!

    @Environment(\.widgetRenderingMode) private var renderingMode

    let entry: WeatherWidgetEntry

    // render one fixed medium widget
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            header
            forecast

            // show credit whenever weather appears
            if entry.display.showsWeather {
                attribution
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .foregroundStyle(contentColor)
        .containerBackground(for: .widget) {
            blushBackground
        }
        .widgetURL(Self.forecastURL)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(entry.display.accessibilitySummary))
    }

    // keep state and sunset visible
    private var header: some View {
        HStack(spacing: 6) {
            Text(entry.display.statusLabel)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            // retain sunset only while the cached day is valid
            if let sunsetLabel = entry.display.sunsetLabel {
                Text(sunsetLabel)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(compactFont(weight: .medium))
    }

    // choose the density-specific arrangement
    @ViewBuilder
    private var forecast: some View {
        // use both rows for dense forecasts
        if entry.display.groups.count >= 4 {
            denseForecastGrid
        } else {
            // fill all post-cutoff space
            if let unavailableMessage = entry.display.unavailableMessage {
                Text(unavailableMessage)
                    .font(compactFont(weight: .bold))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let bedtimeMessage = entry.display.bedtimeMessage {
                HStack(spacing: 5) {
                    ForEach(entry.display.groups) { group in
                        groupTile(group)
                            .frame(width: 72)
                    }
                    Text(bedtimeMessage)
                        .font(compactFont(weight: .bold))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel(Text(bedtimeMessage))
                }
                .frame(maxHeight: .infinity)
            } else {
                EmptyView()
            }
        }
    }

    // place every dense group without scrolling
    private var denseForecastGrid: some View {
        VStack(spacing: 3) {
            HStack(spacing: 4) {
                ForEach(Array(entry.display.groups.prefix(4))) { group in
                    groupTile(group)
                }
            }
            HStack(spacing: 4) {
                ForEach(Array(entry.display.groups.dropFirst(4))) { group in
                    groupTile(group)
                }
                // fill the approved spare slot with the exact message
                if let bedtimeMessage = entry.display.bedtimeMessage {
                    Text(bedtimeMessage)
                        .font(compactFont(weight: .bold))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel(Text(bedtimeMessage))
                }
                Spacer(minLength: 0)
            }
        }
        .frame(maxHeight: .infinity)
    }

    // show range and wettest icon
    private func groupTile(_ group: WeatherWidgetDisplayGroup) -> some View {
        VStack(spacing: 1) {
            Text(group.timeLabel)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 2) {
                Image(systemName: group.condition.symbolName)
                    .imageScale(.small)
                Text(group.temperatureLabel)
                    .fontWeight(.semibold)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(compactFont())
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 2)
        .background(tileBackground, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(group.accessibilityLabel))
    }

    // expose compile-time provider destinations
    private var attribution: some View {
        HStack(spacing: 2) {
            Link("Open-Meteo", destination: Self.providerURL)
                .accessibilityLabel("Weather provider Open-Meteo")
            Text("·")
                .accessibilityHidden(true)
            Link("CC BY 4.0", destination: Self.licenseURL)
                .accessibilityLabel("Weather data license CC BY 4.0")
        }
        .font(compactFont(weight: .medium))
        .fixedSize(horizontal: false, vertical: true)
    }

    // preserve the reviewed dense visual size
    private func compactFont(weight: Font.Weight = .regular) -> Font {
        .system(
            size: CGFloat(WeatherWidgetContract.widgetVisualFontSize),
            weight: weight,
            design: .rounded
        )
    }

    // keep tinted mode system-controlled
    private var contentColor: Color {
        // preserve authored colors when allowed
        if renderingMode == .fullColor {
            return Color(red: 0.20, green: 0.12, blue: 0.18)
        }
        return .primary
    }

    // preserve blush in full color
    private var blushBackground: Color {
        // preserve authored blush when allowed
        if renderingMode == .fullColor {
            return Color(red: 251.0 / 255.0, green: 242.0 / 255.0, blue: 248.0 / 255.0)
        }
        return Color.accentColor.opacity(0.18)
    }

    // separate groups without heavy chrome
    private var tileBackground: Color {
        // preserve authored tile contrast when allowed
        if renderingMode == .fullColor {
            return Color.white.opacity(0.48)
        }
        return Color.primary.opacity(0.10)
    }
}
