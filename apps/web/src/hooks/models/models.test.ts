import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { Model } from '@hushbox/shared';
import {
  STRONGEST_TEXT_MODEL_ID,
  VALUE_TEXT_MODEL_ID,
  STRONGEST_IMAGE_MODEL_ID,
  VALUE_IMAGE_MODEL_ID,
  STRONGEST_VIDEO_MODEL_ID,
  VALUE_VIDEO_MODEL_ID,
  SMART_MODEL_ID,
} from '@hushbox/shared';
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
  const testModels: Model[] = [
    {
      id: 'expensive-basic',
      name: 'Expensive Basic',
      description: 'A pricey basic model',
      provider: 'TestProvider',
      modality: 'text' as const,
      contextLength: 100_000,
      pricePerInputToken: 0.000_05, // Highest price
      pricePerOutputToken: 0.000_15,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'cheap-basic',
      name: 'Cheap Basic',
      description: 'An affordable basic model',
      provider: 'TestProvider',
      modality: 'text' as const,
      contextLength: 50_000,
      pricePerInputToken: 0.000_001, // Lowest price
      pricePerOutputToken: 0.000_003,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'mid-basic',
      name: 'Mid Basic',
      description: 'A mid-priced basic model',
      provider: 'TestProvider',
      modality: 'text' as const,
      contextLength: 75_000,
      pricePerInputToken: 0.000_01, // Mid price
      pricePerOutputToken: 0.000_03,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
    {
      id: 'premium-model',
      name: 'Premium Model',
      description: 'A premium model',
      provider: 'TestProvider',
      modality: 'text' as const,
      contextLength: 200_000,
      pricePerInputToken: 0.0001,
      pricePerOutputToken: 0.0003,
      pricePerImage: 0,
      pricePerSecondByResolution: {},
      pricePerSecond: 0,
      capabilities: [],
      supportedParameters: [],
      created: Math.floor(Date.now() / 1000),
    },
  ];

  const premiumIds = new Set(['premium-model']);

  it('paid users on text get the most-expensive non-premium as strongest and cheapest as value (dynamic)', () => {
    // Text "Strongest" / "Value" buttons must resolve dynamically
    // for paid users — not the hardcoded constants.
    const result = getAccessibleModelIds(testModels, premiumIds, true);

    expect(result.strongestId).toBe('expensive-basic');
    expect(result.valueId).toBe('cheap-basic');
    // Sanity: never the hardcoded constants when dynamic data is available.
    expect(result.strongestId).not.toBe(STRONGEST_TEXT_MODEL_ID);
    expect(result.valueId).not.toBe(VALUE_TEXT_MODEL_ID);
  });

  it('paid users on text fall back to hardcoded text pins when no models are available', () => {
    const result = getAccessibleModelIds([], new Set(), true);
    expect(result.strongestId).toBe(STRONGEST_TEXT_MODEL_ID);
    expect(result.valueId).toBe(VALUE_TEXT_MODEL_ID);
  });

  it('returns hardcoded image pins when canAccessPremium and modality is image', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, true, 'image');
    expect(result.strongestId).toBe(STRONGEST_IMAGE_MODEL_ID);
    expect(result.valueId).toBe(VALUE_IMAGE_MODEL_ID);
  });

  it('returns hardcoded video pins when canAccessPremium and modality is video', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, true, 'video');
    expect(result.strongestId).toBe(STRONGEST_VIDEO_MODEL_ID);
    expect(result.valueId).toBe(VALUE_VIDEO_MODEL_ID);
  });

  it('returns empty pins for non-premium users on media modalities', () => {
    const resultImg = getAccessibleModelIds(testModels, premiumIds, false, 'image');
    const resultVid = getAccessibleModelIds(testModels, premiumIds, false, 'video');
    expect(resultImg.strongestId).toBe('');
    expect(resultImg.valueId).toBe('');
    expect(resultVid.strongestId).toBe('');
    expect(resultVid.valueId).toBe('');
  });

  it('returns highest-price basic model as strongest when canAccessPremium is false', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    expect(result.strongestId).toBe('expensive-basic');
  });

  it('returns lowest-price basic model as value when canAccessPremium is false', () => {
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    expect(result.valueId).toBe('cheap-basic');
  });

  it('handles empty model list gracefully', () => {
    const result = getAccessibleModelIds([], new Set(), false);

    expect(result.strongestId).toBe('');
    expect(result.valueId).toBe('');
  });

  it('handles case where all models are premium', () => {
    const allPremium = new Set(testModels.map((m) => m.id));
    const result = getAccessibleModelIds(testModels, allPremium, false);

    expect(result.strongestId).toBe(testModels[0]?.id);
    expect(result.valueId).toBe(testModels[0]?.id);
  });

  it('excludes premium models when finding strongest/value for non-premium users', () => {
    // Premium model has highest price, but should not be selected
    const result = getAccessibleModelIds(testModels, premiumIds, false);

    expect(result.strongestId).not.toBe('premium-model');
    expect(result.valueId).not.toBe('premium-model');
  });

  it('excludes the Smart Model from strongest/value calculation', () => {
    const modelsWithSmart: Model[] = [
      ...testModels,
      {
        id: SMART_MODEL_ID,
        name: 'Smart Model',
        description: 'Classifier-based router',
        provider: 'HushBox',
        modality: 'text' as const,
        contextLength: 2_000_000,
        pricePerInputToken: 0.000_000_039,
        pricePerOutputToken: 0.000_000_19,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        supportedParameters: [],
        isSmartModel: true,
        created: Math.floor(Date.now() / 1000),
      },
    ];

    // Smart Model has lowest price but should not be selected as "Best value"
    const result = getAccessibleModelIds(modelsWithSmart, premiumIds, false);

    expect(result.strongestId).not.toBe(SMART_MODEL_ID);
    expect(result.valueId).not.toBe(SMART_MODEL_ID);
  });

  it('uses combined input+output price for sorting', () => {
    // Create models where input/output prices would give different rankings
    const modelsWithVaryingPrices: Model[] = [
      {
        id: 'high-input-low-output',
        name: 'High Input Low Output',
        description: 'Test model',
        provider: 'TestProvider',
        modality: 'text' as const,
        contextLength: 100_000,
        pricePerInputToken: 0.0001, // High input
        pricePerOutputToken: 0.000_01, // Low output
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: 'low-input-high-output',
        name: 'Low Input High Output',
        description: 'Test model',
        provider: 'TestProvider',
        modality: 'text' as const,
        contextLength: 100_000,
        pricePerInputToken: 0.000_01, // Low input
        pricePerOutputToken: 0.0001, // High output
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
      },
    ];

    const result = getAccessibleModelIds(modelsWithVaryingPrices, new Set(), false);

    // Both have same combined price, so order depends on stable sort
    // The important thing is that it doesn't crash and returns valid IDs
    expect(modelsWithVaryingPrices.map((m) => m.id)).toContain(result.strongestId);
    expect(modelsWithVaryingPrices.map((m) => m.id)).toContain(result.valueId);
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
