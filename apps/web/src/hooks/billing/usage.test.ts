import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: {
      usage: {
        summary: { $get: vi.fn(() => 'summary-req') },
        'spending-over-time': { $get: vi.fn(() => 'sot-req') },
        'cost-by-model': { $get: vi.fn(() => 'cbm-req') },
        'token-usage-over-time': { $get: vi.fn(() => 'tuot-req') },
        'spending-by-conversation': { $get: vi.fn(() => 'sbc-req') },
        'balance-history': { $get: vi.fn(() => 'bh-req') },
        models: { $get: vi.fn(() => 'models-req') },
      },
    },
  },
  fetchJson: vi.fn((req: unknown) => Promise.resolve({ echoed: req })),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn((options: unknown) => ({ __opts: options })),
}));

import { useQuery } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import {
  usageKeys,
  useUsageSummary,
  useSpendingOverTime,
  useCostByModel,
  useTokenUsageOverTime,
  useSpendingByConversation,
  useBalanceHistory,
  useUsageModels,
} from './usage';

const mockedUseQuery = vi.mocked(useQuery);
const mockedFetchJson = vi.mocked(fetchJson);
const usageClient = vi.mocked(client, true).billing.usage;

/** Grabs the options object passed to the most recent useQuery call. */
function lastOptions(): { queryKey: unknown; queryFn: () => unknown } {
  return mockedUseQuery.mock.calls.at(-1)?.[0] as { queryKey: unknown; queryFn: () => unknown };
}

const DATE_RANGE = { startDate: '2025-01-01', endDate: '2025-01-31' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usageKeys', () => {
  it('builds a stable hierarchy under the "usage" root', () => {
    expect(usageKeys.all).toEqual(['usage']);
    expect(usageKeys.summary(DATE_RANGE)).toEqual(['usage', 'summary', DATE_RANGE]);
    expect(usageKeys.models()).toEqual(['usage', 'models']);
    expect(usageKeys.costByModel(DATE_RANGE)).toEqual(['usage', 'cost-by-model', DATE_RANGE]);
    expect(usageKeys.spendingOverTime(DATE_RANGE)).toEqual([
      'usage',
      'spending-over-time',
      DATE_RANGE,
    ]);
    expect(usageKeys.tokenUsageOverTime(DATE_RANGE)).toEqual([
      'usage',
      'token-usage-over-time',
      DATE_RANGE,
    ]);
    expect(usageKeys.spendingByConversation(DATE_RANGE)).toEqual([
      'usage',
      'spending-by-conversation',
      DATE_RANGE,
    ]);
    expect(usageKeys.balanceHistory(DATE_RANGE)).toEqual(['usage', 'balance-history', DATE_RANGE]);
  });
});

describe('useUsageSummary', () => {
  it('keys the query and fetches the summary endpoint', async () => {
    useUsageSummary(DATE_RANGE);
    const options = lastOptions();
    expect(options.queryKey).toEqual(usageKeys.summary(DATE_RANGE));
    await options.queryFn();
    expect(usageClient.summary.$get).toHaveBeenCalledWith({ query: DATE_RANGE });
    expect(mockedFetchJson).toHaveBeenCalledWith('summary-req');
  });
});

describe('useSpendingOverTime', () => {
  it('forwards granularity and model when present', async () => {
    const params = { ...DATE_RANGE, granularity: 'day' as const, model: 'GPT-4' };
    useSpendingOverTime(params);
    const options = lastOptions();
    expect(options.queryKey).toEqual(usageKeys.spendingOverTime(params));
    await options.queryFn();
    expect(usageClient['spending-over-time'].$get).toHaveBeenCalledWith({
      query: {
        startDate: DATE_RANGE.startDate,
        endDate: DATE_RANGE.endDate,
        granularity: 'day',
        model: 'GPT-4',
      },
    });
  });

  it('passes undefined granularity and model when omitted', async () => {
    useSpendingOverTime(DATE_RANGE);
    await lastOptions().queryFn();
    expect(usageClient['spending-over-time'].$get).toHaveBeenCalledWith({
      query: {
        startDate: DATE_RANGE.startDate,
        endDate: DATE_RANGE.endDate,
        granularity: undefined,
        model: undefined,
      },
    });
  });
});

describe('useCostByModel', () => {
  it('fetches the cost-by-model endpoint', async () => {
    useCostByModel(DATE_RANGE);
    const options = lastOptions();
    expect(options.queryKey).toEqual(usageKeys.costByModel(DATE_RANGE));
    await options.queryFn();
    expect(usageClient['cost-by-model'].$get).toHaveBeenCalledWith({ query: DATE_RANGE });
  });
});

describe('useTokenUsageOverTime', () => {
  it('forwards granularity and model', async () => {
    const params = { ...DATE_RANGE, granularity: 'week' as const, model: 'Claude' };
    useTokenUsageOverTime(params);
    await lastOptions().queryFn();
    expect(usageClient['token-usage-over-time'].$get).toHaveBeenCalledWith({
      query: {
        startDate: DATE_RANGE.startDate,
        endDate: DATE_RANGE.endDate,
        granularity: 'week',
        model: 'Claude',
      },
    });
  });
});

describe('useSpendingByConversation', () => {
  it('includes the limit as a string when provided', async () => {
    useSpendingByConversation({ ...DATE_RANGE, limit: 5 });
    await lastOptions().queryFn();
    expect(usageClient['spending-by-conversation'].$get).toHaveBeenCalledWith({
      query: { startDate: DATE_RANGE.startDate, endDate: DATE_RANGE.endDate, limit: '5' },
    });
  });

  it('omits the limit when not provided', async () => {
    useSpendingByConversation(DATE_RANGE);
    await lastOptions().queryFn();
    expect(usageClient['spending-by-conversation'].$get).toHaveBeenCalledWith({
      query: { startDate: DATE_RANGE.startDate, endDate: DATE_RANGE.endDate },
    });
  });
});

describe('useBalanceHistory', () => {
  it('includes the limit as a string when provided', async () => {
    useBalanceHistory({ ...DATE_RANGE, limit: 10 });
    await lastOptions().queryFn();
    expect(usageClient['balance-history'].$get).toHaveBeenCalledWith({
      query: { startDate: DATE_RANGE.startDate, endDate: DATE_RANGE.endDate, limit: '10' },
    });
  });

  it('omits the limit when not provided', async () => {
    useBalanceHistory(DATE_RANGE);
    await lastOptions().queryFn();
    expect(usageClient['balance-history'].$get).toHaveBeenCalledWith({
      query: { startDate: DATE_RANGE.startDate, endDate: DATE_RANGE.endDate },
    });
  });
});

describe('useUsageModels', () => {
  it('keys the models query and fetches the models endpoint', async () => {
    useUsageModels();
    const options = lastOptions();
    expect(options.queryKey).toEqual(usageKeys.models());
    await options.queryFn();
    expect(usageClient.models.$get).toHaveBeenCalled();
    expect(mockedFetchJson).toHaveBeenCalledWith('models-req');
  });
});
