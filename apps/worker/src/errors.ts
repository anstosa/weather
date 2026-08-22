// redact and bound worker errors
export function boundedWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message
    .replace(
      /(?:api[_-]?key|authorization|password|token)=?[^\s&]*/giu,
      "[redacted]",
    )
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .trim();

  return (redacted.length === 0 ? "worker operation failed" : redacted).slice(
    0,
    512,
  );
}
