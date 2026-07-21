import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { type ModelFeatureId, type ResolveBillingResult } from '@hushbox/shared';
import { type BudgetCalculationResult } from '@/hooks/billing/use-budget-calculation';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';

const {
  mockUseBudgetCalculation,
  mockUseConversationBudgets,
  mockUseResolveBilling,
  mockSelectedModels,
  mockModelsData,
  mockSearchStore,
  mockSession,
  mockActiveModality,
  mockImageSelections,
  mockVideoSelections,
  mockAudioSelections,
  mockImageConfig,
  mockVideoConfig,
  mockAudioConfig,
} = vi.hoisted(() => {
  interface HoistedModel {
    id: string;
    contextLength: number;
    // BASE (pre-markup) nano-USD wire rates as canonical decimal strings.
    pricing: {
      inputPerToken?: string;
      outputPerToken?: string;
      perImage?: string;
      perSecondByResolution?: Record<string, string>;
    };
  }
  interface HoistedModelsData {
    models: HoistedModel[];
    premiumIds: Set<string>;
  }
  return {
    mockUseBudgetCalculation: vi.fn(),
    mockUseConversationBudgets: vi.fn(),
    mockUseResolveBilling: vi.fn(),
    mockSelectedModels: { current: [{ id: 'test-model', name: 'Test Model' }] },
    mockImageSelections: { current: [] as { id: string; name: string }[] },
    mockVideoSelections: { current: [] as { id: string; name: string }[] },
    mockAudioSelections: { current: [] as { id: string; name: string }[] },
    mockActiveModality: { current: 'text' as 'text' | 'image' | 'video' | 'audio' },
    mockImageConfig: { current: { aspectRatio: '1:1' as const } },
    mockVideoConfig: {
      current: {
        aspectRatio: '16:9' as '16:9' | '9:16',
        durationSeconds: 4,
        resolution: '720p' as '720p' | '1080p',
      },
    },
    mockAudioConfig: {
      current: { format: 'mp3' as 'mp3' | 'ogg' | 'wav', maxDurationSeconds: 600 },
    },
    mockModelsData: {
      current: {
        models: [
          {
            id: 'test-model',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      } as HoistedModelsData,
    },
    mockSearchStore: { current: { webSearchEnabled: false } },
    mockSession: {
      current: {
        data: {
          user: {
            id: 'user-1',
            email: 'test@test.com',
            username: 'testuser',
            emailVerified: true,
            totpEnabled: false,
          },
          session: { id: 'session-1' },
        },
        isPending: false,
      } as { data: { user: { id: string } } | null; isPending: boolean },
    },
  };
});

vi.mock('@/hooks/billing/use-budget-calculation', () => ({
  useBudgetCalculation: (...args: unknown[]) => mockUseBudgetCalculation(...args),
}));

vi.mock('@/hooks/billing/use-conversation-budgets', () => ({
  useConversationBudgets: (...args: unknown[]) => mockUseConversationBudgets(...args),
}));

vi.mock('@/hooks/billing/use-resolve-billing', () => ({
  useResolveBilling: (...args: unknown[]) => mockUseResolveBilling(...args),
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return {
    ...actual,
    useModelStore: (selector?: (state: unknown) => unknown) => {
      const state = createModelStoreStub({
        activeModality: mockActiveModality.current,
        selections: {
          text: mockSelectedModels.current,
          image: mockImageSelections.current,
          audio: mockAudioSelections.current,
          video: mockVideoSelections.current,
        },
        imageConfig: mockImageConfig.current,
        videoConfig: mockVideoConfig.current,
        audioConfig: mockAudioConfig.current,
      });
      return selectorFromState(state)(selector as (s: unknown) => unknown);
    },
  };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({
    data: mockModelsData.current,
    isLoading: false,
  }),
}));

vi.mock('@/stores/search', () => ({
  useSearchStore: () => mockSearchStore.current,
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => mockSession.current,
  useAuthStore: (selector: (state: { customInstructions: string | null }) => unknown) =>
    selector({ customInstructions: null }),
}));

const AUTHENTICATED_SESSION = {
  data: {
    user: {
      id: 'user-1',
      email: 'test@test.com',
      username: 'testuser',
      emailVerified: true,
      totpEnabled: false,
    },
    session: { id: 'session-1' },
  },
  isPending: false,
};

describe('usePromptBudget', () => {
  const defaultInput: {
    value: string;
    historyCharacters: number;
    capabilities: ModelFeatureId[];
  } = {
    value: 'Hello',
    historyCharacters: 0,
    capabilities: [],
  };

  const baseBudgetResult: BudgetCalculationResult & { isBalanceLoading: boolean } = {
    maxOutputTokens: 5000,
    estimatedInputTokens: 100,
    estimatedInputCost: 0.001,
    estimatedMinimumCost: 0.002,
    effectiveBalance: 10,
    currentUsage: 1100,
    capacityPercent: 1,
    outputCostPerToken: 0.000_001,
    preReservedCents: 0,
    isBalanceLoading: false,
  };

  const approvedBillingResult: ResolveBillingResult = {
    fundingSource: 'personal_balance',
  };

  beforeEach(() => {
    mockSession.current = AUTHENTICATED_SESSION;
    mockSearchStore.current = { webSearchEnabled: false };
    mockUseBudgetCalculation.mockReturnValue(baseBudgetResult);
    mockUseConversationBudgets.mockReturnValue({
      data: undefined,
      isPending: true,
      isLoading: false,
    });
    mockUseResolveBilling.mockReturnValue(approvedBillingResult);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns flat PromptBudgetResult with all expected fields', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current).toEqual(
        expect.objectContaining({
          fundingSource: 'personal_balance',
          notifications: expect.any(Array),
          capacityPercent: 1,
          capacityCurrentUsage: 1100,
          capacityMaxCapacity: 128_000,
          estimatedCostCents: expect.any(Number),
          isOverCapacity: false,
          hasBlockingError: false,
          hasContent: true,
        })
      );
    });

    it('returns estimatedCostCents as estimatedMinimumCost * 100', () => {
      const { result } = renderHook(() => usePromptBudget(defaultInput));

      // estimatedMinimumCost = 0.002 → cents = 0.2
      expect(result.current.estimatedCostCents).toBeCloseTo(0.2, 5);
    });
  });

  describe('solo conversation', () => {
    it('passes null to useConversationBudgets when no conversationId', () => {
      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });

    it('does not pass group context to useResolveBilling for solo', () => {
      renderHook(() => usePromptBudget(defaultInput));

      const callArgument = mockUseResolveBilling.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgument).not.toHaveProperty('group');
    });
  });

  describe('group budget wiring', () => {
    it('passes null to useConversationBudgets for conversation owners', () => {
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'owner',
        })
      );

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
    });

    it('passes group context to useResolveBilling when group budget data is available', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '8000000000',
              spentNanoUsd: '3000000000',
              effectiveRemainingNanoUsd: '5000000000',
            },
          ],
        },
        isLoading: false,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      // Hook converts the NanoUSD effective remaining + owner balance → cents.
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          group: {
            effectiveCents: 500,
            ownerBalanceCents: 5000,
          },
        })
      );
    });

    it('is not a group member when a conversationId is present but privilege is omitted', () => {
      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          // currentUserPrivilege omitted → resolveIsGroupMember bails at the
          // privilege guard, so this is treated as solo (no group budget query).
        })
      );

      expect(mockUseConversationBudgets).toHaveBeenCalledWith(null);
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.not.objectContaining({ group: expect.anything() })
      );
    });

    it('reports zero effective cents when the members list is empty', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: '50000000000',
          members: [],
        },
        isLoading: false,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          group: expect.objectContaining({ effectiveCents: 0 }),
        })
      );
    });

    it('threads a negative owner balance into the group context (composer denial)', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '-1000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '8000000000',
              spentNanoUsd: '3000000000',
              effectiveRemainingNanoUsd: '-1000000000',
            },
          ],
        },
        isLoading: false,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const callArgument = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        group: { ownerBalanceCents: number };
      };
      expect(callArgument.group.ownerBalanceCents).toBe(-100);
    });

    it('does not pass group context while budget data is loading', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isLoading: true,
      });

      renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const callArgument = mockUseResolveBilling.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgument).not.toHaveProperty('group');
    });

    it('passes hasDelegatedBudget to generateNotifications when group member', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '5000000000',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '5000000000',
            },
          ],
        },
        isLoading: false,
      });
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'owner_balance' });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      // owner_balance + hasDelegatedBudget → delegated_budget_notice
      const hasDelegatedNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'delegated_budget_notice'
      );
      expect(hasDelegatedNotice).toBe(true);
    });

    it('does not show delegated_budget_exhausted when the member cap is 0', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '0',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '0',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '0',
            },
          ],
        },
        isPending: false,
        isLoading: false,
      });
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'personal_balance' });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      const hasExhausted = result.current.notifications.some(
        (n: { id: string }) => n.id === 'delegated_budget_exhausted'
      );
      expect(hasExhausted).toBe(false);
    });
  });

  describe('billing and notifications', () => {
    it('hasBlockingError is true when billing is denied', () => {
      mockUseResolveBilling.mockReturnValue({
        fundingSource: 'denied',
        reason: 'insufficient_balance',
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is true when over capacity', () => {
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        capacityPercent: 150,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
      expect(result.current.isOverCapacity).toBe(true);
    });

    it('hasContent is false for empty input', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          value: '   ',
        })
      );

      expect(result.current.hasContent).toBe(false);
    });

    it('passes isPremiumModel based on premiumIds', () => {
      renderHook(() => usePromptBudget(defaultInput));

      // premiumIds is empty set, so test-model is NOT premium
      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          isPremiumModel: false,
        })
      );
    });

    it('returns fundingSource from useResolveBilling', () => {
      mockUseResolveBilling.mockReturnValue({ fundingSource: 'free_allowance' });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.fundingSource).toBe('free_allowance');
    });

    it('treats a model as non-premium while the catalog is still loading', () => {
      // useModels().data undefined (loading) → premiumIds lookup short-circuits
      // and the `?? false` fallback applies.
      (mockModelsData as { current: unknown }).current = undefined;

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({ isPremiumModel: false })
      );
    });
  });

  describe('multi-model budget', () => {
    it('passes all selected models pricing to useBudgetCalculation', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { models: unknown[] };
      expect(budgetInput.models).toHaveLength(2);
    });

    it('uses minimum context length across all selected models', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      // capacityMaxCapacity should reflect the minimum context length (64_000)
      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        models: { contextLength: number }[];
      };
      const contextLengths = budgetInput.models.map((m) => m.contextLength);
      expect(Math.min(...contextLengths)).toBe(64_000);
    });

    it('reports isPremiumModel true when any selected model is premium', () => {
      mockSelectedModels.current = [
        { id: 'model-a', name: 'Model A' },
        { id: 'model-b', name: 'Model B' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'model-a',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
          {
            id: 'model-b',
            contextLength: 64_000,
            pricing: { inputPerToken: '20000', outputPerToken: '60000' },
          },
        ],
        premiumIds: new Set<string>(['model-b']),
      };

      renderHook(() => usePromptBudget(defaultInput));

      expect(mockUseResolveBilling).toHaveBeenCalledWith(
        expect.objectContaining({
          isPremiumModel: true,
        })
      );
    });

    afterEach(() => {
      // Reset to single-model defaults
      mockSelectedModels.current = [{ id: 'test-model', name: 'Test Model' }];
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    });
  });

  describe('read-only privilege', () => {
    it('hasBlockingError is true when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('fundingSource is denied when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      expect(result.current.fundingSource).toBe('denied');
    });

    it('includes read_only_notice notification when privilege is read', () => {
      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'read',
        })
      );

      const hasReadOnlyNotice = result.current.notifications.some(
        (n: { id: string }) => n.id === 'read_only_notice'
      );
      expect(hasReadOnlyNotice).toBe(true);
    });
  });

  describe('web search cost', () => {
    afterEach(() => {
      mockSearchStore.current = { webSearchEnabled: false };
      mockModelsData.current = {
        models: [
          {
            id: 'test-model',
            contextLength: 128_000,
            pricing: { inputPerToken: '10000', outputPerToken: '30000' },
          },
        ],
        premiumIds: new Set<string>(),
      };
    });

    it('enables the core web-search reservation on useBudgetCalculation when web search is on', () => {
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      // The client passes only the flag; the core adds the worst-case reservation
      // line item (never a mirrored client cost).
      expect(budgetInput.webSearch).toBe(true);
    });

    it('omits the web-search reservation when web search is disabled', () => {
      mockSearchStore.current = { webSearchEnabled: false };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      expect(budgetInput.webSearch).toBeUndefined();
    });

    it('enables the web-search reservation regardless of model (Perplexity runs against any text model)', () => {
      // Perplexity tool runs against any text model that supports tool calling.
      // The frontend budget preview must match the backend reservation, not gate
      // on per-model pricing.
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as { webSearch?: boolean };
      expect(budgetInput.webSearch).toBe(true);
    });

    it('omits the web-search reservation for unauthenticated (trial) users even when the toggle is persisted on', () => {
      // The search preference persists across sign-out/expiry (hushbox-search-storage
      // is not cleared by resetForUnauthenticated). Web search is authenticated-only,
      // so a stale `true` must not reserve the worst-case search cost — that would
      // exceed the 1¢ trial cap and block every trial message.
      mockSession.current = { data: null, isPending: false };
      mockSearchStore.current = { webSearchEnabled: true };

      renderHook(() => usePromptBudget(defaultInput));

      const budgetInput = mockUseBudgetCalculation.mock.calls[0]![0] as {
        webSearch?: boolean;
        isAuthenticated: boolean;
      };
      expect(budgetInput.isAuthenticated).toBe(false);
      expect(budgetInput.webSearch).toBeUndefined();
    });
  });

  describe('loading state blocking', () => {
    it('hasBlockingError is true while group budget is loading', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isPending: true,
        isLoading: true,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is true while balance is loading', () => {
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        isBalanceLoading: true,
      });

      const { result } = renderHook(() => usePromptBudget(defaultInput));

      expect(result.current.hasBlockingError).toBe(true);
    });

    it('hasBlockingError is false once group budget and balance have loaded', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: {
          conversationCapNanoUsd: '10000000000',
          conversationSpentNanoUsd: '2000000000',
          ownerBalanceNanoUsd: '50000000000',
          members: [
            {
              memberId: 'mem-1',
              userId: 'user-1',
              username: 'testuser',
              privilege: 'write',
              capNanoUsd: '5000000000',
              spentNanoUsd: '0',
              effectiveRemainingNanoUsd: '5000000000',
            },
          ],
        },
        isPending: false,
        isLoading: false,
      });
      mockUseBudgetCalculation.mockReturnValue({
        ...baseBudgetResult,
        isBalanceLoading: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        })
      );

      expect(result.current.hasBlockingError).toBe(false);
    });

    it('group budget loading does not block owners', () => {
      mockUseConversationBudgets.mockReturnValue({
        data: undefined,
        isPending: true,
        isLoading: false,
      });

      const { result } = renderHook(() =>
        usePromptBudget({
          ...defaultInput,
          conversationId: 'conv-1',
          currentUserPrivilege: 'owner',
        })
      );

      // Owner is not a group member, so group budget pending does not block
      expect(result.current.hasBlockingError).toBe(false);
    });
  });

  describe('media modalities feed per-image / per-second cost into billing', () => {
    afterEach(() => {
      // Restore default text-mode state for subsequent suites.
      mockActiveModality.current = 'text';
      mockImageSelections.current = [];
      mockVideoSelections.current = [];
      mockAudioSelections.current = [];
    });

    it('image modality: passes the core media cost to useResolveBilling, not the text token cost', () => {
      // Two image models at $0.04 base each. The shared core marks up the
      // provider cost and adds storage; the resulting cents must flow into
      // useResolveBilling so a low-balance user gets the insufficient-balance gate.
      mockActiveModality.current = 'image';
      mockImageSelections.current = [
        { id: 'imagen-4', name: 'Imagen 4' },
        { id: 'imagen-4-fast', name: 'Imagen 4 Fast' },
      ];
      mockModelsData.current = {
        models: [
          {
            id: 'imagen-4',
            contextLength: 0,
            pricing: { perImage: '40000000' },
          },
          {
            id: 'imagen-4-fast',
            contextLength: 0,
            pricing: { perImage: '40000000' },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      // Token-cost path would yield 0.2 cents (from baseBudgetResult). The
      // media path must produce >0 cents reflecting two $0.04 images +
      // fees + storage — substantially more than the text-only baseline.
      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostCents: number;
      };
      expect(lastCall.estimatedMinimumCostCents).toBeGreaterThan(8); // 2 × $0.04 = 8¢ floor before fees/storage
    });

    it('video modality: cost = perSecondByResolution × duration, summed per model, with fees', () => {
      mockActiveModality.current = 'video';
      mockVideoSelections.current = [{ id: 'veo-3.1', name: 'Veo 3.1' }];
      mockVideoConfig.current = {
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      };
      mockModelsData.current = {
        models: [
          {
            id: 'veo-3.1',
            contextLength: 0,
            pricing: { perSecondByResolution: { '720p': '100000000', '1080p': '150000000' } },
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostCents: number;
      };
      // 5 seconds × $0.10/s = $0.50 = 50¢ pre-fee. Just verify it's at least
      // that floor; the exact post-fee+storage value is covered by
      // use-media-cost-estimate.test.
      expect(lastCall.estimatedMinimumCostCents).toBeGreaterThanOrEqual(50);
    });

    it('audio modality: cost is storage-only (no wire provider rate; audio deferred)', () => {
      // The nano wire exposes no audio provider rate (audio inference is
      // deferred), so the client can only account for output storage. The cost
      // is therefore small but positive — the (60s × bytes/s) storage estimate.
      mockActiveModality.current = 'audio';
      mockAudioSelections.current = [{ id: 'tts-1', name: 'TTS-1' }];
      mockAudioConfig.current = { format: 'mp3', maxDurationSeconds: 60 };
      mockModelsData.current = {
        models: [
          {
            id: 'tts-1',
            contextLength: 0,
            pricing: {},
          },
        ],
        premiumIds: new Set<string>(),
      };

      renderHook(() => usePromptBudget(defaultInput));

      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostCents: number;
      };
      expect(lastCall.estimatedMinimumCostCents).toBeGreaterThan(0);
    });

    it('text modality: still uses the token-derived cost (regression guard)', () => {
      // Default state: text modality. Token cost = baseBudgetResult.estimatedMinimumCost * 100 = 0.2¢
      renderHook(() => usePromptBudget(defaultInput));

      const lastCall = mockUseResolveBilling.mock.calls.at(-1)![0] as {
        estimatedMinimumCostCents: number;
      };
      expect(lastCall.estimatedMinimumCostCents).toBeCloseTo(0.2, 5);
    });
  });
});
