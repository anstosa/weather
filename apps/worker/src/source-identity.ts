import type {
  EcowittConfiguration,
  EcowittStationConfiguration,
  SiteConfiguration,
  SiteConfigurationSource,
  PublicStationConfiguration,
  PublicStationConfigurationStation,
  PublicStationSourceConfiguration,
  TempestConfiguration,
  TempestStationConfiguration,
  TideConfiguration,
  TideStationConfiguration,
} from "@weather/database";
import {
  canonicalizeJson,
  type JsonValue,
  type SourceKind,
} from "@weather/domain";

export interface RuntimeSourceIdentity {
  readonly materialProviderConfig: JsonValue;
  readonly providerKey: string;
  readonly siteSlug: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationSlug: string;
  readonly timezone: string;
}

// bind a database source to one configured local Ecowitt gateway
export function sourceIdentityMatchesEcowittConfiguration(
  source: RuntimeSourceIdentity,
  configuration: EcowittConfiguration,
  station: EcowittStationConfiguration,
): boolean {
  // require exact durable and configured identity fields
  if (
    source.siteSlug !== configuration.siteKey ||
    source.stationSlug !== station.key ||
    source.providerKey !== configuration.provider.key ||
    source.sourceKey !== station.sourceKey ||
    source.sourceKind !== "physical_sensor" ||
    source.sourceConfigFingerprint !== station.fingerprint ||
    source.timezone !== station.timezone
  ) {
    return false;
  }

  try {
    return (
      canonicalizeJson(source.materialProviderConfig) ===
      canonicalizeJson(station.adapterConfig)
    );
  } catch {
    // fail closed on malformed database JSON
    return false;
  }
}

// bind a database source to one configured tide source
export function sourceIdentityMatchesTideConfiguration(
  source: RuntimeSourceIdentity,
  configuration: TideConfiguration,
  station: TideStationConfiguration,
): boolean {
  // require exact durable and configured identity fields
  if (
    source.siteSlug !== configuration.siteKey ||
    source.stationSlug !== station.key ||
    source.providerKey !== configuration.provider.key ||
    source.sourceKey !== station.source.key ||
    source.sourceKind !== station.source.sourceKind ||
    source.sourceConfigFingerprint !== station.source.fingerprint ||
    source.timezone !== station.timezone
  ) {
    return false;
  }

  try {
    return (
      canonicalizeJson(source.materialProviderConfig) ===
      canonicalizeJson(station.source.adapterConfig)
    );
  } catch {
    // fail closed on malformed database JSON
    return false;
  }
}

// bind a database source to one configured public station
export function sourceIdentityMatchesPublicStationConfiguration(
  source: RuntimeSourceIdentity,
  configuration: PublicStationConfiguration,
  station: PublicStationConfigurationStation,
  stationSource: PublicStationSourceConfiguration,
): boolean {
  // require exact durable and configured identity fields
  if (
    source.siteSlug !== configuration.siteKey ||
    source.stationSlug !== station.key ||
    source.providerKey !== stationSource.providerKey ||
    source.sourceKey !== stationSource.key ||
    source.sourceKind !== "physical_sensor" ||
    source.sourceConfigFingerprint !== stationSource.fingerprint ||
    source.timezone !== station.timezone
  ) {
    return false;
  }

  try {
    return (
      canonicalizeJson(source.materialProviderConfig) ===
      canonicalizeJson(stationSource.adapterConfig)
    );
  } catch {
    // fail closed on malformed database JSON
    return false;
  }
}

// bind a database source to one configured Tempest station
export function sourceIdentityMatchesTempestConfiguration(
  source: RuntimeSourceIdentity,
  configuration: TempestConfiguration,
  station: TempestStationConfiguration,
): boolean {
  // require exact durable and configured identity fields
  if (
    source.siteSlug !== configuration.siteKey ||
    source.stationSlug !== station.key ||
    source.providerKey !== configuration.provider.key ||
    source.sourceKey !== station.sourceKey ||
    source.sourceKind !== "physical_sensor" ||
    source.sourceConfigFingerprint !== station.fingerprint ||
    source.timezone !== station.timezone
  ) {
    return false;
  }

  try {
    return (
      canonicalizeJson(source.materialProviderConfig) ===
      canonicalizeJson(station.adapterConfig)
    );
  } catch {
    // fail closed on malformed database JSON
    return false;
  }
}

// bind a database source to the loaded material configuration
export function sourceIdentityMatchesConfiguration(
  source: RuntimeSourceIdentity,
  site: SiteConfiguration,
  configuration: SiteConfigurationSource,
): boolean {
  // require exact durable and configured identity fields
  if (
    source.siteSlug !== site.site.key ||
    source.stationSlug !== site.station.key ||
    source.providerKey !== site.provider.key ||
    source.sourceKey !== configuration.key ||
    source.sourceKind !== configuration.sourceKind ||
    source.sourceConfigFingerprint !== configuration.fingerprint ||
    source.timezone !== site.site.timezone
  ) {
    return false;
  }

  try {
    return (
      canonicalizeJson(source.materialProviderConfig) ===
      canonicalizeJson(configuration.adapterConfig)
    );
  } catch {
    // fail closed on malformed database JSON
    return false;
  }
}
