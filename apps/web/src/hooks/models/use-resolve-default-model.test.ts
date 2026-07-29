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

// `hasServedFunding` stays REAL: it is the shared predicate behind both the
// query's `enabled` flag and every caller's pending gate, and a mock that
// re-states it is a second implementation of the rule under test.
vi.mock('@/hooks/billing/use-spendable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/billing/use-spendable.js')>()),
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
import { setLinkGuestAuth, clearLinkGuestAuth } from '@/lib/link-guest-auth.js';
import { useModels } from '@/hooks/models/models.js';
import type { SelectedModelEntry } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';

const mockedUseSession = vi.mocked(useSession);
const mockedUseSpendable = vi.mocked(useSpendable);

/** A served funding snapshot at the given payer tier. */
function servedTier(
  tier: 'paid' | 'free' | 'trial' | 'guest',
  payer: 'self' | 'owner' = 'self'
): { data: unknown } {
  return { data: { spendableNanoUsd: '0', heldNanoUsd: '0', payerTier: tier, payer } };
}

/** No snapshot — either still loading or a door that was never opened. */
const noSnapshot = { data: undefined };

/**
 * Serve `snapshot` to exactly one funding scope and `otherwise` to every other,
 * so a hook reading the wrong scope reads a different tier and the assertion
 * moves.
 */
function servedByScope(
  scope: string | null,
  snapshot: { data: unknown },
  otherwise: { data: unknown }
): void {
  mockedUseSpendable.mockImplementation(((conversationId?: string | null) =>
    (conversationId ?? null) === scope ? snapshot : otherwise) as unknown as typeof useSpendable);
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
    clearLinkGuestAuth();
    vi.restoreAllMocks();
  });

  it('does nothing for text modality (text is always seeded with Smart Model)', () => {
    renderHook(() => {
      useResolveDefaultModel('text', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when selections[modality] already has entries', () => {
    stubStore(buildState({ image: [{ id: 'imagen-cheap', name: 'Imagen Cheap' }] }));
    renderHook(() => {
      useResolveDefaultModel('image', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing while models data has not loaded', () => {
    mockedUseModels.mockReturnValue({ data: undefined } as ReturnType<typeof useModels>);
    renderHook(() => {
      useResolveDefaultModel('image', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('auto-picks first available image model for a paid user', () => {
    renderHook(() => {
      useResolveDefaultModel('image', null);
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
      useResolveDefaultModel('image', null);
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
      useResolveDefaultModel('image', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing for modalities without any matching models (e.g., audio)', () => {
    renderHook(() => {
      useResolveDefaultModel('audio', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing while session is still pending', () => {
    mockedUseSession.mockReturnValue({ data: undefined, isPending: true } as unknown as ReturnType<
      typeof useSession
    >);
    renderHook(() => {
      useResolveDefaultModel('image', null);
    });
    expect(mockSetSelectedModels).not.toHaveBeenCalled();
  });

  it('does nothing when authenticated user is waiting for balance', () => {
    mockedUseSpendable.mockReturnValue({ data: undefined } as never);
    renderHook(() => {
      useResolveDefaultModel('image', null);
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
      useResolveDefaultModel('image', null);
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
      useResolveDefaultModel('image', null);
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
      useResolveDefaultModel('image', null);
    });
    expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
      { id: 'img-low', name: 'Img Low' },
    ]);
  });

  describe('the payer, not the sender, decides which default is reachable', () => {
    /** Nothing but a premium model, so premium access alone decides the outcome. */
    function premiumOnlyCatalog(): void {
      mockedUseModels.mockReturnValue({
        data: {
          models: modelList.filter((m) => m.id === 'imagen-premium' || m.modality === 'text'),
          premiumIds: new Set(['imagen-premium']),
        },
      } as ReturnType<typeof useModels>);
    }

    it("picks an owner-funded member's default from the owner's paid tier", () => {
      premiumOnlyCatalog();
      servedByScope('conv-owner', servedTier('paid', 'owner'), servedTier('free'));

      renderHook(() => {
        useResolveDefaultModel('image', 'conv-owner');
      });

      expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
        { id: 'imagen-premium', name: 'Imagen Premium' },
      ]);
    });

    it("picks an owner-funded link guest's default from the owner's paid tier", () => {
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      setLinkGuestAuth('link-public-key');
      premiumOnlyCatalog();
      // The unscoped door is closed to a guest, which is exactly what made the
      // guest resolve as if the owner had no premium access.
      servedByScope('conv-shared', servedTier('paid', 'owner'), noSnapshot);

      renderHook(() => {
        useResolveDefaultModel('image', 'conv-shared');
      });

      expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
        { id: 'imagen-premium', name: 'Imagen Premium' },
      ]);
    });

    it('waits for the payer snapshot of a link guest instead of defaulting below it', () => {
      mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
        typeof useSession
      >);
      setLinkGuestAuth('link-public-key');
      mockedUseModels.mockReturnValue({
        data: {
          models: [
            imageModel('imagen-premium', 'Imagen Premium', 0),
            imageModel('imagen-cheap', 'Imagen Cheap', 1),
          ],
          premiumIds: new Set(['imagen-premium']),
        },
      } as ReturnType<typeof useModels>);
      servedByScope('conv-shared', noSnapshot, noSnapshot);

      renderHook(() => {
        useResolveDefaultModel('image', 'conv-shared');
      });

      // Choosing now would seed the cheaper model permanently: the resolver
      // runs once, only while the selection is empty.
      expect(mockSetSelectedModels).not.toHaveBeenCalled();
    });

    it('leaves a solo self-funded caller reading its own unscoped door', () => {
      premiumOnlyCatalog();
      servedByScope(null, servedTier('paid'), servedTier('free'));

      renderHook(() => {
        useResolveDefaultModel('image', null);
      });

      expect(mockedUseSpendable).toHaveBeenCalledWith(null);
      expect(mockSetSelectedModels).toHaveBeenCalledWith('image', [
        { id: 'imagen-premium', name: 'Imagen Premium' },
      ]);
    });
  });
});
