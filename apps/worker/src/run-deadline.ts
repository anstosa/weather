import {
  providerRequestBudgetMilliseconds,
  type ProviderFetchOptions,
} from "@weather/providers";

const RUN_FINALIZATION_GRACE_MS = 30_000;

export interface IngestionDeadlines {
  readonly providerDeadlineAt: string;
  readonly runDeadlineAt: string;
}

// cover provider retries plus durable finalization
export function planIngestionDeadlines(
  startedAt: Date,
  options: ProviderFetchOptions | undefined,
): IngestionDeadlines {
  const providerBudgetMs = providerRequestBudgetMilliseconds(options);

  return {
    providerDeadlineAt: new Date(
      startedAt.getTime() + providerBudgetMs,
    ).toISOString(),
    runDeadlineAt: new Date(
      startedAt.getTime() + providerBudgetMs + RUN_FINALIZATION_GRACE_MS,
    ).toISOString(),
  };
}
