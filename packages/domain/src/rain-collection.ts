// freeze collection separately from any model or qualification authorization
export const RAIN_COLLECTION_POLICY = Object.freeze({
  contractVersion: "rain-prospective-capture/v1",
  siteSlug: "ballydidean",
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  startsAt: "2026-09-13T00:00:00.000Z",
  expiresAt: "2027-10-08T00:00:00.000Z",
  // enable the fixed catalog after operator-confirmed provider access
  stationAccessAuthorized: true,
  forecastHours: 49,
  decisionDelayHours: 8,
  forecastFirstAttemptHours: 6,
  forecastSecondAttemptHours: 7,
  stationCadenceMinutes: 60,
  stationWindowHours: 2,
  maximumForecastRequestsPerDay: 8,
  maximumStationRequestsPerDay: 288,
  maximumRequestsPerIteration: 2,
  minimumRequestSpacingMs: 1_100,
  pendingRequestGuardMs: 120_000,
  rateLimitCooldownHours: 24,
  maximumBodyBytes: 2_000_000,
  maximumCompressedBodyBytes: 2_100_000,
  maximumStoredBytesPerDay: 8_388_608,
  maximumStoredBytes: 2_147_483_648,
  timeoutMs: 45_000,
  modelEnabled: false,
  qualificationEnabled: false,
} as const);

// preserve the twelve physical gauges and their existing device identities
export const RAIN_COLLECTION_STATIONS = Object.freeze([
  { locationId: 64255, deviceId: 175727, serial: "ST-00054713", latitude: 47.95008, longitude: -122.43982 },
  { locationId: 225947, deviceId: 1239187, serial: "ST-00212830", latitude: 47.94215, longitude: -122.42542 },
  { locationId: 38270, deviceId: 115866, serial: "ST-00157152", latitude: 47.95293, longitude: -122.41414 },
  { locationId: 168853, deviceId: 401592, serial: "ST-00170845", latitude: 47.95498, longitude: -122.44074 },
  { locationId: 126537, deviceId: 313016, serial: "ST-00134621", latitude: 47.9582, longitude: -122.44274 },
  { locationId: 201058, deviceId: 466938, serial: "ST-00194085", latitude: 47.96244, longitude: -122.43369 },
  { locationId: 203055, deviceId: 470937, serial: "ST-00198967", latitude: 47.96505, longitude: -122.4241 },
  { locationId: 66270, deviceId: 180230, serial: "ST-00173167", latitude: 47.93134, longitude: -122.42912 },
  { locationId: 34768, deviceId: 107388, serial: "ST-00020495", latitude: 47.91752, longitude: -122.41112 },
  { locationId: 88159, deviceId: 230560, serial: "ST-00094734", latitude: 47.91563, longitude: -122.41845 },
  { locationId: 126197, deviceId: 312302, serial: "ST-00129187", latitude: 47.91413, longitude: -122.41471 },
  { locationId: 27140, deviceId: 87271, serial: "ST-00000360", latitude: 47.98707, longitude: -122.46295 },
] as const);

export type RainCollectionStation = (typeof RAIN_COLLECTION_STATIONS)[number];

// keep credential-bearing URLs outside durable identities
export type RainCaptureRequest = Readonly<{
  kind: "forecast";
  slotKey: string;
  runInitializedAt: string;
  attempt: 1 | 2;
}> | Readonly<{
  kind: "station";
  slotKey: string;
  stationId: number;
  start: string;
  endExclusive: string;
}>;

export type RainCaptureOutcome =
  | "valid"
  | "invalid"
  | "transport_error"
  | "rate_limited"
  | "unauthorized";

// retain exact decoded transport bytes before parsing or normalization
export interface RainCaptureReceipt {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly httpStatus: number | null;
  readonly body: Uint8Array | null;
  readonly bodySha256: string | null;
  readonly outcome: RainCaptureOutcome;
  readonly errorCode: string | null;
  readonly parserVersion: "rain-prospective-capture/v1";
  readonly rowCount: number;
  readonly availableByDecision: boolean | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

// expose only aggregate collection evidence to the public API
export interface RainCollectionStatus {
  readonly contractVersion: "rain-prospective-capture/v1";
  readonly modelEnabled: false;
  readonly qualificationEnabled: false;
  readonly claims: number;
  readonly receipts: number;
  readonly validForecasts: number;
  readonly timelyForecasts: number;
  readonly validStationWindows: number;
  readonly stationsSeen: number;
  readonly failedRequests: number;
  readonly pendingRequests: number;
  readonly unknownRequests: number;
  readonly lastClaimAt: string | null;
  readonly lastReceiptAt: string | null;
  readonly lastForecastReceiptAt: string | null;
  readonly lastStationReceiptAt: string | null;
  readonly pausedUntil: string | null;
  readonly compressedBytes: number;
}
