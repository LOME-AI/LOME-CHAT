import { useQuery } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import type {
  UsageSummaryResponse,
  SpendingOverTimeResponse,
  CostByModelResponse,
  TokenUsageOverTimeResponse,
  SpendingByConversationResponse,
  BalanceHistoryResponse,
  UsageModelsResponse,
  UsageGranularity,
} from '@hushbox/shared';

interface DateRange {
  startDate: string;
  endDate: string;
}

interface TimeSeriesParams extends DateRange {
  granularity?: UsageGranularity;
  model?: string;
}

export const usageKeys = {
  all: ['usage'] as const,
  summary: (params: DateRange) => [...usageKeys.all, 'summary', params] as const,
  spendingOverTime: (params: TimeSeriesParams) =>
    [...usageKeys.all, 'spending-over-time', params] as const,
  costByModel: (params: DateRange) => [...usageKeys.all, 'cost-by-model', params] as const,
  tokenUsageOverTime: (params: TimeSeriesParams) =>
    [...usageKeys.all, 'token-usage-over-time', params] as const,
  spendingByConversation: (params: DateRange & { limit?: number }) =>
    [...usageKeys.all, 'spending-by-conversation', params] as const,
  balanceHistory: (params: DateRange & { limit?: number }) =>
    [...usageKeys.all, 'balance-history', params] as const,
  models: () => [...usageKeys.all, 'models'] as const,
};

export function useUsageSummary(
  params: DateRange
): ReturnType<typeof useQuery<UsageSummaryResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.summary(params),
    queryFn: () =>
      fetchJson<UsageSummaryResponse>(client.billing.usage.summary.$get({ query: params })),
  });
}

export function useSpendingOverTime(
  params: TimeSeriesParams
): ReturnType<typeof useQuery<SpendingOverTimeResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.spendingOverTime(params),
    queryFn: () =>
      fetchJson<SpendingOverTimeResponse>(
        client.billing.usage['spending-over-time'].$get({
          query: {
            startDate: params.startDate,
            endDate: params.endDate,
            granularity: params.granularity,
            model: params.model,
          },
        })
      ),
  });
}

export function useCostByModel(
  params: DateRange
): ReturnType<typeof useQuery<CostByModelResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.costByModel(params),
    queryFn: () =>
      fetchJson<CostByModelResponse>(client.billing.usage['cost-by-model'].$get({ query: params })),
  });
}

export function useTokenUsageOverTime(
  params: TimeSeriesParams
): ReturnType<typeof useQuery<TokenUsageOverTimeResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.tokenUsageOverTime(params),
    queryFn: () =>
      fetchJson<TokenUsageOverTimeResponse>(
        client.billing.usage['token-usage-over-time'].$get({
          query: {
            startDate: params.startDate,
            endDate: params.endDate,
            granularity: params.granularity,
            model: params.model,
          },
        })
      ),
  });
}

export function useSpendingByConversation(
  params: DateRange & { limit?: number }
): ReturnType<typeof useQuery<SpendingByConversationResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.spendingByConversation(params),
    queryFn: () =>
      fetchJson<SpendingByConversationResponse>(
        client.billing.usage['spending-by-conversation'].$get({
          query: {
            startDate: params.startDate,
            endDate: params.endDate,
            ...(params.limit !== undefined && { limit: String(params.limit) }),
          },
        })
      ),
  });
}

export function useBalanceHistory(
  params: DateRange & { limit?: number }
): ReturnType<typeof useQuery<BalanceHistoryResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.balanceHistory(params),
    queryFn: () =>
      fetchJson<BalanceHistoryResponse>(
        client.billing.usage['balance-history'].$get({
          query: {
            startDate: params.startDate,
            endDate: params.endDate,
            ...(params.limit !== undefined && { limit: String(params.limit) }),
          },
        })
      ),
  });
}

export function useUsageModels(): ReturnType<typeof useQuery<UsageModelsResponse, Error>> {
  return useQuery({
    queryKey: usageKeys.models(),
    queryFn: () => fetchJson<UsageModelsResponse>(client.billing.usage.models.$get()),
  });
}
