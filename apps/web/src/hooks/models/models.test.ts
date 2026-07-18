import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { Model } from '@hushbox/shared';
import { SMART_MODEL_ID } from '@hushbox/shared';
import {
  useModels,
  getAccessibleModelIds,
  modelKeys,
  modelsQueryOptions,
} from '@/hooks/models/models.js';

vi.mock('@/lib/api-client.js', () => ({
  client: {
    models: {
      $get: vi.fn(() => Promise.resolve(new Response())),
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client.js';

const mockFetchJson = vi.mocked(fetchJson);

const MOCK_MODELS: Model[] = [
  {
    id: 'openai/gpt-4-turbo',
    name: 'GPT-4 Turbo',
    description: 'Most capable GPT-4 model',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    pricePerInputToken: 0.000_01,
    pricePerOutputToken: 0.000_03,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: ['temperature', 'tools', 'tool_choice'],
    created: Math.floor(Date.now() / 1000),
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    description: 'Balanced Claude model',
    provider: 'Anthropic',
    modality: 'text' as const,
    contextLength: 200_000,
    pricePerInputToken: 0.000_003,
    pricePerOutputToken: 0.000_015,
    pricePerImage: 0,
    pricePerSecondByResolution: {},
    pricePerSecond: 0,
    capabilities: [],
    supportedParameters: ['temperature', 'max_tokens'],
    created: Math.floor(Date.now() / 1000),
  },
];

const MOCK_API_RESPONSE = {
  models: MOCK_MODELS,
  premiumModelIds: ['openai/gpt-4-turbo'],
};

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches models from API', async () => {
    mockFetchJson.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data?.models).toHaveLength(2);
  });

  it('returns models with correct structure', async () => {
    mockFetchJson.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.models[0]).toMatchObject({
      id: 'openai/gpt-4-turbo',
      name: 'GPT-4 Turbo',
      provider: 'OpenAI',
      contextLength: 128_000,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_03,
    });
  });

  it('returns premiumIds as a Set', async () => {
    mockFetchJson.mockResolvedValueOnce(MOCK_API_RESPONSE);

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.premiumIds).toBeInstanceOf(Set);
    expect(result.current.data?.premiumIds.has('openai/gpt-4-turbo')).toBe(true);
    expect(result.current.data?.premiumIds.has('anthropic/claude-3.5-sonnet')).toBe(false);
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Network error');
  });

  it('returns empty data when API returns empty models', async () => {
    mockFetchJson.mockResolvedValueOnce({ models: [], premiumModelIds: [] });

    const { result } = renderHook(() => useModels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.models).toEqual([]);
    expect(result.current.data?.premiumIds.size).toBe(0);
  });
});

describe('getAccessibleModelIds', () => {
  function mk(o: Partial<Model> & { id: string }): Model {
    return {
      name: o.id,
      description: 'test',
      provider: 'TestProvider',
      modality: 'text',
      contextLength: 100_000,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      supportedParameters: [],
      created: 0,
      ...o,
    };
  }

  // rank order: prem(0) < basic1(1) < basic2(2) < basic3(3); costs via input token * 1000.
  const prem = mk({ id: 'prem', popularityRank: 0, pricePerInputToken: 0.0005 }); // cost 0.5
  const basic1 = mk({ id: 'basic1', popularityRank: 1, pricePerInputToken: 0.000_01 }); // cost 0.01
  const basic2 = mk({ id: 'basic2', popularityRank: 2, pricePerInputToken: 0.0009 }); // cost 0.9
  const basic3 = mk({ id: 'basic3', popularityRank: 3, pricePerInputToken: 0.000_02 }); // cost 0.02
  const tierModels = [prem, basic1, basic2, basic3];
  const premiumIds = new Set(['prem']);

  it('paid text pins come from the most-popular half with premium in the candidate set', () => {
    // candidate = all 4 (premium included); top half by popularity = [prem, basic1];
    // strongest = priciest in that half (prem), value = cheapest (basic1).
    const result = getAccessibleModelIds(tierModels, premiumIds, true);

    expect(result.strongestId).toBe('prem');
    expect(result.valueId).toBe('basic1');
  });

  it('trial text pins exclude premium and derive from the most-popular half', () => {
    // candidate = [basic1, basic2, basic3]; top half = [basic1, basic2];
    // strongest = priciest (basic2), value = cheapest (basic1).
    const result = getAccessibleModelIds(tierModels, premiumIds, false);

    expect(result.strongestId).toBe('basic2');
    expect(result.valueId).toBe('basic1');
    expect(result.strongestId).not.toBe('prem');
    expect(result.valueId).not.toBe('prem');
  });

  it('does not pick an expensive but unpopular model as strongest', () => {
    const pop1 = mk({ id: 'pop1', popularityRank: 0, pricePerInputToken: 0.000_05 }); // 0.05
    const pop2 = mk({ id: 'pop2', popularityRank: 1, pricePerInputToken: 0.000_03 }); // 0.03
    const pop3 = mk({ id: 'pop3', popularityRank: 2, pricePerInputToken: 0.000_01 }); // 0.01
    const trap = mk({ id: 'trap', pricePerInputToken: 0.005 }); // unranked, cost 5.0 (priciest overall)

    // top half = [pop1, pop2]; trap is unranked (sorts last) and excluded.
    const result = getAccessibleModelIds([pop1, pop2, pop3, trap], new Set(), false);

    expect(result.strongestId).toBe('pop1');
    expect(result.strongestId).not.toBe('trap');
    expect(result.valueId).toBe('pop2');
  });

  it('returns no pins for image, video, and audio modalities', () => {
    for (const modality of ['image', 'video', 'audio'] as const) {
      const result = getAccessibleModelIds(tierModels, premiumIds, true, modality);
      expect(result).toEqual({ strongestId: '', valueId: '' });
    }
  });

  it('returns no pins when the model list is empty', () => {
    expect(getAccessibleModelIds([], new Set(), true)).toEqual({ strongestId: '', valueId: '' });
  });

  it('returns no pins when a non-premium user has only premium candidates', () => {
    const result = getAccessibleModelIds([prem], premiumIds, false);
    expect(result).toEqual({ strongestId: '', valueId: '' });
  });

  it('returns no pins when every candidate is unranked', () => {
    const unranked = [
      mk({ id: 'u1', pricePerInputToken: 0.0002 }),
      mk({ id: 'u2', pricePerInputToken: 0.0001 }),
    ];
    expect(getAccessibleModelIds(unranked, new Set(), true)).toEqual({
      strongestId: '',
      valueId: '',
    });
  });

  it('returns the single candidate as both strongest and value', () => {
    const only = mk({ id: 'only', popularityRank: 0, pricePerInputToken: 0.000_03 });
    const result = getAccessibleModelIds([only], new Set(), true);

    expect(result.strongestId).toBe('only');
    expect(result.valueId).toBe('only');
  });

  it('excludes the Smart Model from candidacy', () => {
    const smart = mk({
      id: SMART_MODEL_ID,
      popularityRank: 0,
      pricePerInputToken: 0.000_001,
      isSmartModel: true,
    });
    const normal = mk({ id: 'n1', popularityRank: 1, pricePerInputToken: 0.0001 });

    const result = getAccessibleModelIds([smart, normal], new Set(), true);

    expect(result.strongestId).toBe('n1');
    expect(result.valueId).toBe('n1');
    expect(result.strongestId).not.toBe(SMART_MODEL_ID);
    expect(result.valueId).not.toBe(SMART_MODEL_ID);
  });

  it('breaks price ties deterministically by first encountered in the popular half', () => {
    const t1 = mk({ id: 't1', popularityRank: 0, pricePerInputToken: 0.000_05 }); // 0.05
    const t2 = mk({ id: 't2', popularityRank: 1, pricePerInputToken: 0.000_05 }); // 0.05 (tie)
    const t3 = mk({ id: 't3', popularityRank: 2, pricePerInputToken: 0.0009 });
    const t4 = mk({ id: 't4', popularityRank: 3, pricePerInputToken: 0.0009 });

    // top half = [t1, t2], equal cost; first-encountered wins both extremes.
    const result = getAccessibleModelIds([t1, t2, t3, t4], new Set(), false);

    expect(result.strongestId).toBe('t1');
    expect(result.valueId).toBe('t1');
  });

  it('uses combined input+output price for the strongest/value split', () => {
    const cheap = mk({
      id: 'cheap',
      popularityRank: 0,
      pricePerInputToken: 0.000_01,
      pricePerOutputToken: 0.000_01,
    }); // 0.02
    const pricey = mk({
      id: 'pricey',
      popularityRank: 1,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0001,
    }); // 0.2
    // Two unpopular fillers so cheap+pricey are the most-popular half.
    const fill1 = mk({ id: 'fill1', popularityRank: 2, pricePerInputToken: 0.0005 });
    const fill2 = mk({ id: 'fill2', popularityRank: 3, pricePerInputToken: 0.0005 });

    const result = getAccessibleModelIds([cheap, pricey, fill1, fill2], new Set(), true);

    expect(result.strongestId).toBe('pricey');
    expect(result.valueId).toBe('cheap');
  });
});

describe('modelKeys', () => {
  it('builds a detail key scoped to the model id', () => {
    expect(modelKeys.detail('model-x')).toEqual(['models', 'model-x']);
  });
});

describe('modelsQueryOptions', () => {
  it('returns correct queryKey', () => {
    const options = modelsQueryOptions();
    expect(options.queryKey).toEqual(modelKeys.list());
  });

  it('returns a callable queryFn', () => {
    const options = modelsQueryOptions();
    expect(typeof options.queryFn).toBe('function');
  });

  it('returns staleTime of 1 hour', () => {
    const options = modelsQueryOptions();
    expect(options.staleTime).toBe(1000 * 60 * 60);
  });
});
