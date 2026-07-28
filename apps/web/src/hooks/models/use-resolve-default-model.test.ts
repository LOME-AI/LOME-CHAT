import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  createModelStoreStub,
  selectorFromState,
  type ModelStoreStub,
} from '@/test-utils/model-store-mock';
import { useModelStore } from '@/stores/model';
import { useResolveDefaultModel } from '@/hooks/models/use-resolve-default-model';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/billing/use-spendable.js', () => ({
  useSpendable: vi.fn(),
}));

vi.mock('@/hooks/models/models.js', () => ({
  useModels: vi.fn(),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  return {
    ...actual,
    useModelStore: vi.fn(),
  };
});

import { useSession } from '@/lib/auth';
import { useSpendable } from '@/hooks/billing/use-spendable.js';
import { useModels } from '@/hooks/models/models.js';
import type { SelectedModelEntry } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

const mockedUseSession = vi.mocked(useSession);
const mockedUseSpendable = vi.mocked(useSpendable);

/** A served funding snapshot at the given payer tier. */
function servedTier(tier: 'paid' | 'free' | 'trial' | 'guest'): { data: unknown } {
  return { data: { spendableNanoUsd: '0', heldNanoUsd: '0', tier, payer: 'self' } };
}
const mockedUseModels = vi.mocked(useModels);
const mockedUseModelStore = vi.mocked(useModelStore);

const modelList: Model[] = [
  {
    id: 'imagen-cheap',
    name: 'Imagen Cheap',
    description: 'Cheap image model',
    provider: 'Google',
    modality: 'image',
    contextLength: 0,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { perImage: '20000000' },
  },
  {
    id: 'imagen-premium',
    name: 'Imagen Premium',
    description: 'Premium image model',
    provider: 'Google',
    modality: 'image',
    contextLength: 0,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { perImage: '120000000' },
  },
  {
    id: 'claude',
    name: 'Claude',
    description: 'Text model',
    provider: 'Anthropic',
    modality: 'text',
    contextLength: 200_000,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { inputPerToken: '3000', outputPerToken: '15000' },
  },
];

function imageModel(id: string, name: string, popularityRank?: number): Model {
  return {
    id,
    name,
    description: 'Image model',
    provider: 'Test',
    modality: 'image',
    contextLength: 0,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { perImage: '20000000' },
    ...(popularityRank === undefined ? {} : { popularityRank }),
  };
}

const mockSetSelectedModels = vi.fn();

function buildState(
  overrides: Partial<Record<ChatModality, SelectedModelEntry[]>> = {}
): ModelStoreStub {
  return createModelStoreStub({
    selections: {
      text: overrides.text ?? [{ id: 'smart-model', name: 'Smart Model' }],
      image: overrides.image ?? [],
      audio: overrides.audio ?? [],
      video: overrides.video ?? [],
    },
    setSelectedModels: mockSetSelectedModels,
  });
}

function stubStore(state: ModelStoreStub): void {
  mockedUseModelStore.mockImplementation(selectorFromState(state) as typeof useModelStore);
}

describe('useResolveDefaultModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'u1' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('paid') as never);
    mockedUseModels.mockReturnValue({
      data: { models: modelList, premiumIds: new Set(['imagen-premium']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing for text modality (text is always seeded with Smart Model)', () => {
    renderHook(() => {
      useResolveDefaultModel('text');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when selections[modality] already has entries', () => {
    stubStore(buildState({ image: [{ id: 'imagen-cheap', name: 'Imagen Cheap' }] }));
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing while models data has not loaded', () => {
    mockedUseModels.mockReturnValue({ data: undefined } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('auto-picks first available image model for a paid user', () => {
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
      { id: 'imagen-cheap', name: 'Imagen Cheap' },
    ]);
  });

  it('filters out premium models when user has no balance', () => {
    mockedUseSpendable.mockReturnValue(servedTier('free') as never);
    stubStore(buildState());
    // Only non-premium model should be available
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
      { id: 'imagen-cheap', name: 'Imagen Cheap' },
    ]);
  });

  it('does nothing when only premium models exist and user cannot access premium', () => {
    mockedUseSpendable.mockReturnValue(servedTier('free') as never);
    mockedUseModels.mockReturnValue({
      data: {
        models: modelList.filter((m) => m.id === 'imagen-premium' || m.modality === 'text'),
        premiumIds: new Set(['imagen-premium']),
      },
    } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing for modalities without any matching models (e.g., audio)', () => {
    renderHook(() => {
      useResolveDefaultModel('audio');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing while session is still pending', () => {
    mockedUseSession.mockReturnValue({ data: undefined, isPending: true } as unknown as ReturnType<
      typeof useSession
    >);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when authenticated user is waiting for balance', () => {
    mockedUseSpendable.mockReturnValue({ data: undefined } as never);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('breaks a popularity-rank tie by ascending model id', () => {
    mockedUseModels.mockReturnValue({
      data: {
        models: [imageModel('img-b', 'Img B', 5), imageModel('img-a', 'Img A', 5)],
        premiumIds: new Set<string>(),
      },
    } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [{ id: 'img-a', name: 'Img A' }]);
  });

  it('prefers a ranked model over an unranked one', () => {
    mockedUseModels.mockReturnValue({
      data: {
        models: [
          imageModel('img-unranked', 'Img Unranked'),
          imageModel('img-ranked', 'Img Ranked', 2),
        ],
        premiumIds: new Set<string>(),
      },
    } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
      { id: 'img-ranked', name: 'Img Ranked' },
    ]);
  });

  it('prefers the lower popularity rank when two models are ranked', () => {
    mockedUseModels.mockReturnValue({
      data: {
        models: [imageModel('img-low', 'Img Low', 1), imageModel('img-high', 'Img High', 9)],
        premiumIds: new Set<string>(),
      },
    } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image');
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
      { id: 'img-low', name: 'Img Low' },
    ]);
  });
});
