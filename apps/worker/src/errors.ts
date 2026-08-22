import { redactSensitiveText } from "@weather/providers";

export type WorkerDiagnosticEvent = "source_run" | "worker_iteration";

export interface WorkerDiagnostic {
  readonly count: number;
  readonly duration_ms: number;
  readonly error_code: string | null;
  readonly event: WorkerDiagnosticEvent;
  readonly release: string;
  readonly run_id: string | null;
  readonly source_id: string | null;
}

interface WorkerDiagnosticInput {
  readonly count: number;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly event: WorkerDiagnosticEvent;
  readonly release: string;
  readonly runId: string | null;
  readonly sourceId: string | null;
}

// redact and bound worker errors
export function boundedWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(message).trim();

  return (redacted.length === 0 ? "worker operation failed" : redacted).slice(
    0,
    512,
  );
}

// retain distinct bounded secondary failures
export function combineWorkerDiagnostics(
  entries: readonly Readonly<{
    label: "finalization" | "release";
    value: unknown | null;
  }>[],
): string | null {
  const parts: string[] = [];

  // preserve every present diagnostic category
  for (const entry of entries) {
    // omit absent secondary failures
    if (entry.value === null) {
      continue;
    }

    parts.push(`${entry.label}=${boundedWorkerError(entry.value).slice(0, 220)}`);
  }

  // preserve a null absence contract
  if (parts.length === 0) {
    return null;
  }

  return parts.join("; ").slice(0, 512);
}

// release a source session without masking work
export async function guardReleaseSession(
  session: Readonly<{ release(): Promise<void> }>,
): Promise<string | null> {
  try {
    await session.release();
    return null;
  } catch (error) {
    // retain bounded cleanup diagnostics
    return boundedWorkerError(error);
  }
}

// construct one allowlisted structured diagnostic
export function createWorkerDiagnostic(
  input: WorkerDiagnosticInput,
): WorkerDiagnostic {
  return {
    count: boundedDiagnosticNumber(input.count),
    duration_ms: boundedDiagnosticNumber(input.durationMs),
    error_code: boundedDiagnosticErrorCode(input.errorCode),
    event: input.event,
    release: boundedDiagnosticIdentifier(input.release),
    run_id:
      input.runId === null ? null : boundedDiagnosticIdentifier(input.runId),
    source_id:
      input.sourceId === null
        ? null
        : boundedDiagnosticIdentifier(input.sourceId),
  };
}

// emit one newline-delimited JSON diagnostic
export function writeWorkerDiagnostic(diagnostic: WorkerDiagnostic): void {
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
}

// constrain structured diagnostic numbers
function boundedDiagnosticNumber(value: number): number {
  // reject negative non-finite or oversized metrics
  if (!Number.isSafeInteger(value) || value < 0) {
    return 0;
  }

  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

// constrain structured diagnostic identifiers
function boundedDiagnosticIdentifier(value: string): string {
  // redact values outside the identifier contract
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value)) {
    return "[redacted]";
  }

  return value;
}

// constrain structured diagnostic error codes
function boundedDiagnosticErrorCode(value: string | null): string | null {
  // preserve the no-error contract
  if (value === null) {
    return null;
  }

  // replace arbitrary external codes
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    return "worker_failure";
  }

  return value;
}
