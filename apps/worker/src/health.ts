export interface WorkerHealth {
  readonly lastLoopAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly live: boolean;
  readonly ready: boolean;
  readonly stale: boolean;
}

// derive allowlisted worker health
export function workerHealth(
  now: Date,
  state: Readonly<{
    lastLoopAt: string | null;
    lastSuccessAt: string | null;
    ready: boolean;
  }>,
  staleAfterMs = 30 * 60 * 1_000,
): WorkerHealth {
  const lastLoop = state.lastLoopAt === null ? null : Date.parse(state.lastLoopAt);
  const stale =
    lastLoop === null ||
    !Number.isFinite(lastLoop) ||
    now.getTime() - lastLoop > staleAfterMs;

  return {
    lastLoopAt: state.lastLoopAt,
    lastSuccessAt: state.lastSuccessAt,
    live: true,
    ready: state.ready && !stale,
    stale,
  };
}
