#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <derived-data> <receipt-directory>" >&2
  exit 64
fi

DERIVED_DATA="$1"
RECEIPTS="$2"
PRODUCTS="$DERIVED_DATA/Build/Products/Release-iphonesimulator"
APP="$PRODUCTS/Weather.app"
EXTENSION="$APP/PlugIns/WeatherWidgetExtension.appex"
ASSET_CATALOG="$APP/Assets.car"
BANNED_PATTERN='localhost|127[.]0[.]0[.]1|0[.]0[.]0[.]0|NSAllowsArbitraryLoads|NSExceptionDomains|WKScriptMessageHandler|addScriptMessageHandler|serverTrust|trustAll|api[_-]?key|client[_-]?secret|BEGIN PRIVATE KEY|WEATHER_WIDGET_FIXTURE|WeatherWidgetFixtureSelection|WEATHER_M0_FIXTURE_MAXIMUM|WEATHER_M0_FIXTURE_NEAR_CUTOFF|WEATHER_M0_FIXTURE_BEDTIME|WEATHER_M0_FIXTURE_DEBUG_DEFAULT|WEATHER_V4_FIXTURE_|WEATHER_V4_PERSISTENCE_PROBE|WeatherWidgetPersistenceProbe|persistence-probe|m0-fixture-resolution|m0-compiled-fixture|v4-decoded-fixture|m0-webview-lifecycle|native-back-action|native-back-issued|native-navigation did-start|native-navigation did-commit|weather-ui-test|weather-m0-reload-widget|weather-widget-configuration-diagnostic|deterministic-ui-test|weather-https-fixture|WEATHER_HTTPS_FIXTURE_IOS_ORIGIN|WEATHER_HTTPS_FIXTURE_IOS_UNTRUSTED_ORIGIN|https-fixture-load|Weather Native Fixture Trusted Root|Weather Native Fixture Untrusted Root|Weather Native HTTPS Fixture|M0 fixture|Maximum density M0|Near cutoff M0|Bedtime M0|Weather route /forecast|about:blank'

mkdir -p "$RECEIPTS"

# require the unsigned app and embedded widget
if [[ ! -d "$APP" || ! -d "$EXTENSION" ]]; then
  echo "missing Release app or embedded widget under $PRODUCTS" >&2
  exit 1
fi

# require the compiled app-icon catalog
if [[ ! -f "$ASSET_CATALOG" ]]; then
  echo "Release app lacks compiled Assets.car" >&2
  exit 1
fi

# reject accidental provisioning material
if find "$APP" -name embedded.mobileprovision -print -quit | grep -q .; then
  echo "unsigned Release unexpectedly contains a provisioning profile" >&2
  exit 1
fi

SCAN_FILE="$RECEIPTS/release-strings.txt"
: > "$SCAN_FILE"

# inspect every produced regular file
while IFS= read -r -d '' artifact; do
  strings "$artifact" >> "$SCAN_FILE" 2>/dev/null || true
done < <(find "$APP" -type f -print0)

# reject fixture origins, trust bypasses, bridges, and secrets
if grep -Eai "$BANNED_PATTERN" "$SCAN_FILE" > "$RECEIPTS/release-banned-matches.txt"; then
  echo "Release artifact isolation failed; see $RECEIPTS/release-banned-matches.txt" >&2
  exit 1
fi
rm -f "$RECEIPTS/release-banned-matches.txt"

# require only compiled production destinations
for required in \
  'https://weather.ballydidean.farm' \
  'https://open-meteo.com/' \
  'https://creativecommons.org/licenses/by/4.0/' \
  'ballydidean-weather://forecast'; do
  if ! grep -Fq "$required" "$SCAN_FILE"; then
    echo "Release artifact lacks required compiled destination: $required" >&2
    exit 1
  fi
done

# inspect generated property lists
for plist in "$APP/Info.plist" "$EXTENSION/Info.plist"; do
  plutil -p "$plist" >> "$RECEIPTS/release-plists.txt"
  if plutil -p "$plist" | grep -Eq 'NSAppTransportSecurity|NSAllowsArbitraryLoads|NSExceptionDomains|application-groups'; then
    echo "Release plist weakens transport or storage boundaries: $plist" >&2
    exit 1
  fi
done

# preserve exact unsigned artifact hashes
while IFS= read -r -d '' artifact; do
  shasum -a 256 "$artifact"
done < <(find "$APP" -type f -print0) | LC_ALL=C sort > "$RECEIPTS/release-sha256.txt"

echo "unsigned Release artifact isolation passed; receipts: $RECEIPTS"
