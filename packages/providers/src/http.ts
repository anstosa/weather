import { createHash } from "node:crypto";

import {
  ProviderFailure,
  boundedProviderMessage,
  type ProviderFetchOptions,
} from "./contract.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export interface JsonResponse {
  readonly attempts: number;
  readonly checksum: string;
  readonly payload: unknown;
  readonly status: number;
}

// fetch JSON with bounded retry controls
export async function fetchJsonWithRetry(
  url: URL,
  options: ProviderFetchOptions = {},
): Promise<JsonResponse> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let lastFailure: ProviderFailure | null = null;

  validateHttpControls(timeoutMs, maxAttempts);

  // attempt only the bounded request budget
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        fetchImplementation,
        url,
        timeoutMs,
      );
      const body = await response.text();

      // classify non-success responses before parsing
      if (!response.ok) {
        throw classifyHttpFailure(response, body, attempt);
      }

      let payload: unknown;

      try {
        payload = JSON.parse(body) as unknown;
      } catch (error) {
        throw new ProviderFailure(
          {
            classification: "invalid_payload",
            code: "invalid_json",
            message: "provider returned invalid JSON",
          },
          { attempts: attempt, cause: error, status: response.status },
        );
      }

      return {
        attempts: attempt,
        checksum: createHash("sha256").update(body).digest("hex"),
        payload,
        status: response.status,
      };
    } catch (error) {
      const failure = classifyThrownFailure(error, attempt);
      lastFailure = failure;

      // stop on permanent failures or exhausted attempts
      if (!isRetryable(failure) || attempt === maxAttempts) {
        throw failure;
      }

      await sleep(retryDelayMilliseconds(failure, attempt, random));
    }
  }

  throw lastFailure ?? new Error("provider retry loop ended unexpectedly");
}

// enforce bounded HTTP settings
function validateHttpControls(timeoutMs: number, maxAttempts: number): void {
  // reject unbounded timeouts
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("provider timeout must be between 1 and 60000ms");
  }

  // reject unbounded retries
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("provider attempts must be between 1 and 3");
  }
}

// race fetch against an aborting timeout
async function fetchWithTimeout(
  fetchImplementation: typeof fetch,
  url: URL,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    // abort the request at its deadline
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("provider request timed out"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetchImplementation(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      timeoutFailure,
    ]);
  } finally {
    // clear the live deadline
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

// classify HTTP response status
function classifyHttpFailure(
  response: Response,
  body: string,
  attempts: number,
): ProviderFailure {
  const status = response.status;
  const detail = extractProviderReason(body);

  // classify rate limits separately
  if (status === 429) {
    return new ProviderFailure(
      {
        classification: "rate_limited",
        code: "provider_rate_limited",
        message: detail ?? "provider rate limit exceeded",
        metadata: retryMetadata(response),
      },
      { attempts, status },
    );
  }

  // allow bounded retries for server errors
  if (status >= 500) {
    return new ProviderFailure(
      {
        classification: "retryable",
        code: "provider_server_error",
        message: detail ?? `provider returned HTTP ${status}`,
      },
      { attempts, status },
    );
  }

  return new ProviderFailure(
    {
      classification: "permanent",
      code: "provider_request_rejected",
      message: detail ?? `provider returned HTTP ${status}`,
    },
    { attempts, status },
  );
}

// classify transport and timeout failures
function classifyThrownFailure(error: unknown, attempts: number): ProviderFailure {
  // retain explicit provider failures
  if (error instanceof ProviderFailure) {
    return error;
  }

  return new ProviderFailure(
    {
      classification: "retryable",
      code: "provider_unavailable",
      message: boundedProviderMessage(error),
    },
    { attempts, cause: error },
  );
}

// determine retry eligibility
function isRetryable(failure: ProviderFailure): boolean {
  return (
    failure.ingestionError.classification === "retryable" ||
    failure.ingestionError.classification === "rate_limited"
  );
}

// calculate bounded exponential backoff
function retryDelayMilliseconds(
  failure: ProviderFailure,
  attempt: number,
  random: () => number,
): number {
  const retryAfter = failure.ingestionError.metadata?.retry_after_ms;

  // honor a bounded retry-after response
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Math.round(retryAfter)));
  }

  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 100);
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (attempt - 1) + jitter);
}

// serialize retry timing metadata
function retryMetadata(response: Response): Readonly<Record<string, number>> {
  const retryAfter = response.headers.get("retry-after");

  // omit absent hints
  if (retryAfter === null) {
    return {};
  }

  const seconds = Number(retryAfter);

  // parse seconds-form hints
  if (Number.isFinite(seconds) && seconds >= 0) {
    return { retry_after_ms: Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000) };
  }

  const absolute = Date.parse(retryAfter);

  // parse date-form hints
  if (Number.isFinite(absolute)) {
    return {
      retry_after_ms: Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(0, absolute - Date.now()),
      ),
    };
  }

  return {};
}

// extract bounded provider error text
function extractProviderReason(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };

    // accept provider reason strings only
    if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
      return parsed.reason.trim().slice(0, 512);
    }
  } catch {
    return null;
  }

  return null;
}

// sleep between attempts
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
