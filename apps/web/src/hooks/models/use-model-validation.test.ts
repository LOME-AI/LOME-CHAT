import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  createModelStoreStub,
  selectorFromState,
  type ModelStoreStub,
} from '@/test-utils/model-store-mock';
import { useModelStore } from '@/stores/model';
import { useModelValidation } from '@/hooks/models/use-model-validation.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/billing/use-spendable.js', () => ({
  useSpendable: vi.fn(),
}));

vi.mock('@/hooks/models/models.js', () => ({
  useModels: vi.fn(),
  getAccessibleModelIds: vi.fn(),
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
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';
import type { SelectedModelEntry } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

const mockedUseSession = vi.mocked(useSession);
const mockedUseSpendable = vi.mocked(useSpendable);

/** A served funding snapshot at the given payer tier. */
function servedTier(tier: 'paid' | 'free' | 'trial' | 'guest'): { data: unknown } {
  return { data: { spendableNanoUsd: '0', heldNanoUsd: '0', tier, payer: 'self' } };
}
const mockedUseModels = vi.mocked(useModels);
const mockedGetAccessibleModelIds = vi.mocked(getAccessibleModelIds);
const mockedUseModelStore = vi.mocked(useModelStore);

const testModels: Model[] = [
  {
    id: 'basic-model',
    name: 'Basic Model',
    description: 'A basic model',
    provider: 'TestProvider',
    modality: 'text' as const,
    contextLength: 100_000,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  },
  {
    id: 'premium-model',
    name: 'Premium Model',
    description: 'A premium model',
    provider: 'TestProvider',
    modality: 'text' as const,
    contextLength: 200_000,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { inputPerToken: '100000', outputPerToken: '300000' },
  },
  {
    id: 'imagen',
    name: 'Imagen',
    description: 'Imagen',
    provider: 'Google',
    modality: 'image' as const,
    contextLength: 0,
    capabilities: [],
    supportedParameters: [],
    created: Math.floor(Date.now() / 1000),
    pricing: { perImage: '40000000' },
  },
];

const mockSetSelectedModels = vi.fn();

function buildState(
  overrides: Partial<Record<ChatModality, SelectedModelEntry[]>> = {}
): ModelStoreStub {
  return createModelStoreStub({
    selections: {
      text: overrides.text ?? [{ id: 'basic-model', name: 'Basic Model' }],
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

describe('useModelValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseSpendable.mockReturnValue({ data: undefined } as never);
    stubStore(buildState());
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-model',
      valueId: 'basic-model',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when models data is not loaded', () => {
    mockedUseModels.mockReturnValue({ data: undefined } as ReturnType<typeof useModels>);

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not run while session is loading', () => {
    mockedUseSession.mockReturnValue({
      data: undefined,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not reset when premium user has premium model selected', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('paid') as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when selected text model is already accessible', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('free') as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'basic-model', name: 'Basic Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('KEEPS a premium text model selected for a free user — marked, never removed', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('free') as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    // The picker renders it greyed with its reason; rewriting the store would
    // hide a model the payer can unlock, and would change a selection the user
    // never changed.
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('KEEPS a premium text model selected for a trial user — marked, never removed', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseSpendable.mockReturnValue({ data: undefined } as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('leaves a premium selection alone even when a stronger basic model exists', () => {
    const modelsWithMultipleBasic: Model[] = [
      ...testModels,
      {
        id: 'expensive-basic',
        name: 'Expensive Basic',
        description: 'An expensive basic model',
        provider: 'TestProvider',
        modality: 'text' as const,
        contextLength: 150_000,
        capabilities: [],
        supportedParameters: [],
        created: Math.floor(Date.now() / 1000),
        pricing: { inputPerToken: '50000', outputPerToken: '150000' },
      },
    ];

    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: modelsWithMultipleBasic, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'expensive-basic',
      valueId: 'basic-model',
    });

    renderHook(() => {
      useModelValidation();
    });

    // The fallback exists for a selection the CATALOG dropped, not for one the
    // payer merely cannot fund today.
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does not reset if strongest model is not in the models list', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'non-existent',
      valueId: 'non-existent',
    });

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('resets text when selected model no longer exists', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).toHaveBeenCalledWith('text', [
      { id: 'basic-model', name: 'Basic Model' },
    ]);
  });

  it('does not run while balance is loading for an authenticated user', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue({ data: undefined } as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(buildState({ text: [{ id: 'premium-model', name: 'Premium Model' }] }));

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('removes an invalid image model without touching text', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('paid') as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        text: [{ id: 'basic-model', name: 'Basic Model' }],
        image: [{ id: 'stale-image-model', name: 'Stale' }],
      })
    );

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).toHaveBeenCalledTimes(1);
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', []);
  });

  it('preserves valid image models and only removes invalid ones', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    mockedUseSpendable.mockReturnValue(servedTier('paid') as never);
    mockedUseModels.mockReturnValue({
      data: { models: testModels, premiumIds: new Set(['premium-model']) },
    } as ReturnType<typeof useModels>);
    stubStore(
      buildState({
        image: [
          { id: 'imagen', name: 'Imagen' },
          { id: 'stale', name: 'Stale' },
        ],
      })
    );

    renderHook(() => {
      useModelValidation();
    });

    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [{ id: 'imagen', name: 'Imagen' }]);
  });

  describe('trial-user modality lock', () => {
    it('forces activeModality to text when the user is unauthenticated', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      mockedUseSpendable.mockReturnValue({ data: undefined } as never);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation();
      });

      expect(mockSetActiveModality).toHaveBeenCalledWith('text');
    });

    it('does not touch activeModality when already text for unauthenticated user', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      mockedUseSpendable.mockReturnValue({ data: undefined } as never);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'text',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation();
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });

    it('does not touch activeModality for authenticated users on non-text modality', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as ReturnType<typeof useSession>);
      mockedUseSpendable.mockReturnValue(servedTier('paid') as never);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [{ id: 'imagen', name: 'Imagen' }],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation();
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });

    it('does not run while session is still loading', () => {
      const mockSetActiveModality = vi.fn();
      mockedUseSession.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseSpendable.mockReturnValue({ data: undefined } as never);
      mockedUseModels.mockReturnValue({
        data: { models: testModels, premiumIds: new Set(['premium-model']) },
      } as ReturnType<typeof useModels>);
      stubStore(
        createModelStoreStub({
          activeModality: 'image',
          selections: {
            text: [{ id: 'basic-model', name: 'Basic Model' }],
            image: [],
            audio: [],
            video: [],
          },
          setSelectedModels: mockSetSelectedModels,
          setActiveModality: mockSetActiveModality,
        })
      );

      renderHook(() => {
        useModelValidation();
      });

      expect(mockSetActiveModality).not.toHaveBeenCalled();
    });
  });
});
