import type {
  IngestionError,
  JsonValue,
  NormalizedWeatherRecord,
  SourceKind,
} from "@weather/domain";

export const PROVIDER_CAPABILITIES = ["current", "historical"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderAttribution {
  readonly label: string;
  readonly url: string;
}

export interface ProviderRequestPlan {
  readonly adapterVersion: string;
  readonly capability: ProviderCapability;
  readonly sourceKind: SourceKind;
  readonly url: URL;
}

export interface ProviderBatch {
  readonly attempts: number;
  readonly checksum: string;
  readonly providerCursor: Readonly<Record<string, JsonValue>> | null;
  readonly records: readonly NormalizedWeatherRecord[];
  readonly responseMetadata: Readonly<Record<string, JsonValue>>;
}

export interface ProviderFetchOptions {
  readonly clock?: () => number;
  readonly deadlineAt?: string;
  readonly fetch?: typeof fetch;
  readonly maxBodyBytes?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

export type CurrentProviderOperation<Input> = (
  input: Input,
  options?: ProviderFetchOptions,
) => Promise<ProviderBatch>;

export type HistoricalProviderOperation<Input> = (
  input: Input,
  options?: ProviderFetchOptions,
) => Promise<ProviderBatch>;

export class ProviderFailure extends Error {
  readonly attempts: number;
  readonly ingestionError: IngestionError;
  readonly status: number | null;

  // preserve a bounded provider diagnosis
  constructor(
    ingestionError: IngestionError,
    options: Readonly<{
      attempts?: number;
      cause?: unknown;
      status?: number | null;
    }> = {},
  ) {
    super(ingestionError.message, { cause: options.cause });
    this.name = "ProviderFailure";
    this.attempts = options.attempts ?? 1;
    this.ingestionError = ingestionError;
    this.status = options.status ?? null;
  }
}

// coerce unknown failures to the provider boundary
export function asProviderFailure(error: unknown, attempts = 1): ProviderFailure {
  // retain classified failures
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

// redact and bound external error text
export function boundedProviderMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(raw).trim();

  return (redacted.length === 0 ? "provider request failed" : redacted).slice(0, 512);
}

// redact credential-shaped text across trust boundaries
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /["']?\b(?:api(?:[_\s-]?key)|authorization|password|token)\b["']?\s*(?:=|:)?\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:basic|bearer)\s+[^\s]+|[^\s]+)/giu,
      "[redacted]",
    )
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, "$1[redacted]@");
}
