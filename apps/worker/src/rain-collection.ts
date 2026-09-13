import {
  RAIN_COLLECTION_POLICY,
  RAIN_COLLECTION_STATIONS,
  type RainCaptureReceipt,
  type RainCaptureRequest,
} from "@weather/domain";
import {
  appendRainCaptureReceipt,
  claimRainCaptureSlot,
  type createDatabasePool,
} from "@weather/database";
import { fetchRainCapture } from "@weather/providers";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkerConfiguration } from "./config.js";

type DatabasePool = ReturnType<typeof createDatabasePool>;

export interface RainCollectionRepository {
  readonly claimRainCaptureSlot: typeof claimRainCaptureSlot;
  readonly appendRainCaptureReceipt: typeof appendRainCaptureReceipt;
}

export interface RainCollectionOptions {
  readonly apiKey?: string;
  readonly fetchCapture?: (
    request: RainCaptureRequest,
  ) => Promise<RainCaptureReceipt>;
  readonly now?: () => Date;
  readonly repository?: RainCollectionRepository;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly stationsAuthorized: boolean;
}

export interface RainCollectionResult {
  readonly attempted: number;
  readonly valid: number;
  readonly failed: number;
}

const HOUR_MS = 3_600_000;
const repository: RainCollectionRepository = {
  claimRainCaptureSlot,
  appendRainCaptureReceipt,
};

// require the production capture boundary independently of provider credentials
export function isRainCollectionEnabled(configuration: Pick<
  WorkerConfiguration,
  "rainCollectionEnabled" | "openMeteoCompatibilityOrigin" | "site" | "version"
>): boolean {
  return configuration.rainCollectionEnabled === true &&
    configuration.openMeteoCompatibilityOrigin === null &&
    configuration.site.site.key === RAIN_COLLECTION_POLICY.siteSlug &&
    /^\d{4}\.\d{2}\.\d{2}-[1-9][0-9]?$/u.test(configuration.version);
}

// plan only recent run slots and one fair hourly twelve-gauge sweep
export function planRainCaptureRequests(
  now: Date,
  stationsAuthorized: boolean,
): readonly RainCaptureRequest[] {
  const time = now.getTime();
  const policy = RAIN_COLLECTION_POLICY;

  // never collect outside the separately authorized lifetime
  if (
    !Number.isFinite(time) ||
    time < Date.parse(policy.startsAt) ||
    time >= Date.parse(policy.expiresAt)
  ) {
    return [];
  }

  const initialized = Math.floor((time - 6 * HOUR_MS) / (6 * HOUR_MS)) * 6 * HOUR_MS;
  const runInitializedAt = new Date(initialized).toISOString();
  const attempt = time - initialized < 7 * HOUR_MS ? 1 : 2;
  const requests: RainCaptureRequest[] = [{
    kind: "forecast",
    slotKey: `forecast:${runInitializedAt}:${attempt}`,
    runInitializedAt,
    attempt,
  }];

  // require a distinct operator-confirmed public-station entitlement
  if (!stationsAuthorized) {
    return requests;
  }

  // allow two minutes for the endpoint before capturing the completed hour
  const stationHour = Math.floor((time - 120_000) / HOUR_MS) * HOUR_MS;
  const endExclusive = new Date(stationHour + 1_000).toISOString();
  const start = new Date(stationHour + 1_000 - policy.stationWindowHours * HOUR_MS).toISOString();
  const rotation = Math.floor(stationHour / HOUR_MS) % RAIN_COLLECTION_STATIONS.length;

  // rotate priority so prolonged outages cannot always starve the same gauges
  for (let offset = 0; offset < RAIN_COLLECTION_STATIONS.length; offset += 1) {
    const station = RAIN_COLLECTION_STATIONS[(rotation + offset) % RAIN_COLLECTION_STATIONS.length];

    // keep unchecked array access away from durable identities
    if (station === undefined) {
      throw new Error("rain station catalog is incomplete");
    }
    requests.push({
      kind: "station",
      slotKey: `station:${station.locationId}:${endExclusive}`,
      stationId: station.locationId,
      start,
      endExclusive,
    });
  }

  return requests;
}

// capture bounded append-only evidence without changing ordinary ingestion
export async function collectRainEvidence(
  pool: DatabasePool,
  release: string,
  options: RainCollectionOptions,
): Promise<RainCollectionResult> {
  const now = options.now ?? currentDate;
  const store = options.repository ?? repository;
  const sleep = options.sleep ?? delay;
  const fetchCapture = options.fetchCapture ?? (
    // keep credentials in memory and outside the persisted request identity
    async (request: RainCaptureRequest) => await fetchRainCapture(request, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      now,
    })
  );
  const requests = planRainCaptureRequests(now(), options.stationsAuthorized);
  const result = { attempted: 0, valid: 0, failed: 0 };

  // let durable uniqueness and cooldown checks arbitrate every individual slot
  for (const request of requests) {
    // preserve a fixed per-iteration budget even after failed captures
    if (result.attempted >= RAIN_COLLECTION_POLICY.maximumRequestsPerIteration) {
      break;
    }

    const claimId = await store.claimRainCaptureSlot(pool, { request, release });

    // do not repeat successful, unknown or otherwise unavailable request slots
    if (claimId === null) {
      continue;
    }
    result.attempted += 1;

    try {
      const receipt = await fetchCapture(request);
      await store.appendRainCaptureReceipt(pool, claimId, receipt);

      // successful capture is not model qualification or timely availability
      if (receipt.outcome === "valid") {
        result.valid += 1;
      } else {
        result.failed += 1;
      }
      // suspend this loop immediately after explicit provider access or rate errors
      if (receipt.outcome === "rate_limited" || receipt.outcome === "unauthorized") {
        break;
      }
      // leave durable receipts committed before the next provider start
      if (result.attempted < RAIN_COLLECTION_POLICY.maximumRequestsPerIteration) {
        await sleep(RAIN_COLLECTION_POLICY.minimumRequestSpacingMs);
      }
    } catch {
      // a missing receipt remains an explicit unknown claim after a crash
      result.failed += 1;
      break;
    }
  }

  return result;
}

// use the real collection clock by default
function currentDate(): Date {
  return new Date();
}
