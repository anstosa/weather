import { createHash } from "node:crypto";

import {
  ProviderFailure,
  boundedProviderMessage,
  type ProviderFetchOptions,
} from "./contract.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
export const DEFAULT_PROVIDER_MAX_ATTEMPTS = 3;
export const DEFAULT_PROVIDER_MAX_BODY_BYTES = 2_000_000;
export const MAX_PROVIDER_RETRY_DELAY_MS = 30_000;
const MAX_PROVIDER_BODY_BYTES = 10_000_000;

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
  const maxAttempts = options.maxAttempts ?? DEFAULT_PROVIDER_MAX_ATTEMPTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_PROVIDER_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const clock = options.clock ?? Date.now;
  const deadline = parseDeadline(options.deadlineAt);
  let lastFailure: ProviderFailure | null = null;

  validateHttpControls(timeoutMs, maxAttempts, maxBodyBytes);

  // attempt only the bounded request budget
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const attemptTimeoutMs = boundedAttemptTimeout(
        timeoutMs,
        deadline,
        clock,
        attempt,
      );
      const { body, response } = await fetchAttempt(
        fetchImplementation,
        url,
        attemptTimeoutMs,
        maxBodyBytes,
        attempt,
      );

      // classify non-success responses before parsing
      if (!response.ok) {
        throw classifyHttpFailure(response, body, attempt, clock);
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
      const failure = deadlineExpired(deadline, clock)
        ? deadlineFailure(attempt)
        : classifyThrownFailure(error, attempt);
      lastFailure = failure;

      // stop on permanent failures or exhausted attempts
      if (
        !isRetryable(failure) ||
        attempt === maxAttempts ||
        failure.ingestionError.code === "provider_deadline_exceeded"
      ) {
        throw failure;
      }

      await sleepWithinDeadline(
        retryDelayMilliseconds(failure, attempt, random),
        sleep,
        deadline,
        clock,
        attempt,
      );
    }
  }

  throw lastFailure ?? new Error("provider retry loop ended unexpectedly");
}

// calculate the maximum complete retry duration
export function providerRequestBudgetMilliseconds(
  options: ProviderFetchOptions = {},
): number {
  const maxAttempts = options.maxAttempts ?? DEFAULT_PROVIDER_MAX_ATTEMPTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_PROVIDER_MAX_BODY_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  validateHttpControls(timeoutMs, maxAttempts, maxBodyBytes);

  return (
    maxAttempts * timeoutMs +
    Math.max(0, maxAttempts - 1) * MAX_PROVIDER_RETRY_DELAY_MS
  );
}

// enforce bounded HTTP settings
function validateHttpControls(
  timeoutMs: number,
  maxAttempts: number,
  maxBodyBytes: number,
): void {
  // reject unbounded timeouts
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("provider timeout must be between 1 and 60000ms");
  }

  // reject unbounded retries
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("provider attempts must be between 1 and 3");
  }

  // reject unbounded response bodies
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_PROVIDER_BODY_BYTES
  ) {
    throw new RangeError("provider body limit must be between 1 and 10000000 bytes");
  }
}

// retain one aborting timeout through response consumption
async function fetchAttempt(
  fetchImplementation: typeof fetch,
  url: URL,
  timeoutMs: number,
  maxBodyBytes: number,
  attempt: number,
): Promise<Readonly<{ body: string; response: Response }>> {
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
    const response = await Promise.race([
      fetchImplementation(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      timeoutFailure,
    ]);
    const body = await readBoundedResponseBody(
      response,
      maxBodyBytes,
      timeoutFailure,
      attempt,
    );
    return { body, response };
  } catch (error) {
    // abort transport work without waiting on cleanup
    controller.abort(error);
    throw error;
  } finally {
    // clear the live deadline
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

// consume a response without crossing its byte ceiling
async function readBoundedResponseBody(
  response: Response,
  maxBodyBytes: number,
  timeoutFailure: Promise<never>,
  attempt: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");

  // reject an honest oversized length before allocation
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBodyBytes
  ) {
    const failure = responseTooLargeFailure(attempt, response.status);

    // cancel a declared oversized body without awaiting cleanup
    if (response.body !== null) {
      void response.body.cancel(failure).catch(() => undefined);
    }

    throw failure;
  }

  // preserve empty response semantics
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let completed = false;

  try {
    // enforce the limit against every streamed chunk
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeoutFailure]);

      // finish the UTF-8 stream
      if (chunk.done) {
        completed = true;
        return body + decoder.decode();
      }

      bytes += chunk.value.byteLength;

      // reject dishonest or absent lengths at the actual boundary
      if (bytes > maxBodyBytes) {
        throw responseTooLargeFailure(attempt, response.status);
      }

      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    // start cleanup without masking or extending the deadline
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    // release only after all reads completed
    if (completed) {
      reader.releaseLock();
    }
  }
}

// classify an oversized provider response
function responseTooLargeFailure(
  attempts: number,
  status: number,
): ProviderFailure {
  return new ProviderFailure(
    {
      classification: "invalid_payload",
      code: "provider_response_too_large",
      message: "provider response exceeded the byte limit",
    },
    { attempts, status },
  );
}

// parse an optional absolute run deadline
function parseDeadline(value: string | undefined): number | null {
  // retain standalone provider behavior
  if (value === undefined) {
    return null;
  }

  const parsed = Date.parse(value);

  // reject invalid absolute deadlines
  if (!Number.isFinite(parsed)) {
    throw new RangeError("provider deadlineAt must be a valid instant");
  }

  return parsed;
}

// bound one attempt by both request and run deadlines
function boundedAttemptTimeout(
  timeoutMs: number,
  deadline: number | null,
  clock: () => number,
  attempts: number,
): number {
  // retain the request timeout without a run deadline
  if (deadline === null) {
    return timeoutMs;
  }

  const remaining = deadline - clock();

  // fail before starting work past the run deadline
  if (remaining <= 0) {
    throw deadlineFailure(attempts);
  }

  return Math.min(timeoutMs, remaining);
}

// detect an exhausted absolute deadline
function deadlineExpired(
  deadline: number | null,
  clock: () => number,
): boolean {
  return deadline !== null && clock() >= deadline;
}

// classify one exhausted run deadline
function deadlineFailure(attempts: number): ProviderFailure {
  return new ProviderFailure(
    {
      classification: "retryable",
      code: "provider_deadline_exceeded",
      message: "provider run deadline exceeded",
    },
    { attempts },
  );
}

// keep retry sleeps inside the absolute deadline
async function sleepWithinDeadline(
  milliseconds: number,
  sleep: (milliseconds: number) => Promise<void>,
  deadline: number | null,
  clock: () => number,
  attempts: number,
): Promise<void> {
  // retain bounded default retry behavior
  if (deadline === null) {
    await sleep(milliseconds);
    return;
  }

  const remaining = deadline - clock();

  // reject a delay that cannot complete in budget
  if (remaining <= 0 || milliseconds > remaining) {
    throw deadlineFailure(attempts);
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    // reject an injected sleep that stalls
    timeout = setTimeout(() => {
      reject(deadlineFailure(attempts));
    }, remaining);
  });

  try {
    await Promise.race([sleep(milliseconds), timeoutFailure]);
  } finally {
    // clear the live sleep deadline
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
  clock: () => number,
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
        metadata: retryMetadata(response, clock),
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
    return Math.min(
      MAX_PROVIDER_RETRY_DELAY_MS,
      Math.max(0, Math.round(retryAfter)),
    );
  }

  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 100);
  return Math.min(
    MAX_PROVIDER_RETRY_DELAY_MS,
    250 * 2 ** (attempt - 1) + jitter,
  );
}

// serialize retry timing metadata
function retryMetadata(
  response: Response,
  clock: () => number,
): Readonly<Record<string, number>> {
  const retryAfter = response.headers.get("retry-after");

  // omit absent hints
  if (retryAfter === null) {
    return {};
  }

  const seconds = Number(retryAfter);

  // parse seconds-form hints
  if (Number.isFinite(seconds) && seconds >= 0) {
    return {
      retry_after_ms: Math.min(
        MAX_PROVIDER_RETRY_DELAY_MS,
        seconds * 1_000,
      ),
    };
  }

  const absolute = Date.parse(retryAfter);

  // parse date-form hints
  if (Number.isFinite(absolute)) {
    return {
      retry_after_ms: Math.min(
        MAX_PROVIDER_RETRY_DELAY_MS,
        Math.max(0, absolute - clock()),
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
      return boundedProviderMessage(parsed.reason);
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
