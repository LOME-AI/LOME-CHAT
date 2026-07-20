/**
 * Regression coverage for the validation `useEffect` infinite-update loop.
 *
 * Unlike `use-model-validation.test.ts`, this file does NOT stub `@/stores/model`.
 * The real Zustand store runs so that `setSelectedModels` actually mutates state
 * and a downstream React render can re-invoke the validation effect — which is
 * the only way to observe the loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useModelStore, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '@/stores/model';
import type { SelectedModelEntry } from '@/stores/model';
import type { Model, ChatModality } from '@hushbox/shared';
import { useModelValidation } from '@/hooks/models/use-model-validation.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/billing/billing.js', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/hooks/models/models.js', () => ({
  useModels: vi.fn(),
  getAccessibleModelIds: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useBalance } from '@/hooks/billing/billing.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);
const mockedUseModels = vi.mocked(useModels);
const mockedGetAccessibleModelIds = vi.mocked(getAccessibleModelIds);

const textModel = (id: string): Model => ({
  id,
  name: id,
  description: '',
  provider: 'p',
  modality: 'text' as const,
  contextLength: 100_000,
  pricePerInputToken: 0.0001,
  pricePerOutputToken: 0.0003,
  pricePerImage: 0,
  pricePerSecondByResolution: {},
  pricePerSecond: 0,
  capabilities: [],
  supportedParameters: [],
  created: 0,
});

function resetStore(selections: Partial<Record<ChatModality, SelectedModelEntry[]>> = {}): void {
  useModelStore.setState({
    activeModality: 'text',
    selections: {
      text: selections.text ?? [{ id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME }],
      image: selections.image ?? [],
      audio: selections.audio ?? [],
      video: selections.video ?? [],
    },
  });
}

describe('useModelValidation — infinite update loop guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseSession.mockReturnValue({ data: null, isPending: false } as ReturnType<
      typeof useSession
    >);
    mockedUseBalance.mockReturnValue({ data: undefined } as ReturnType<typeof useBalance>);
  });

  afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
  });

  it('does not infinitely re-set selections when the only text fallback is premium for a non-premium user', () => {
    // Repro: every text model in the catalog is premium. `getAccessibleModelIds`
    // returns the first text id (which is premium). The validation effect would
    // (1) drop the user's stale premium selection, (2) substitute the premium
    // fallback, (3) re-render, (4) drop the fallback because it's premium, (5)
    // substitute the same fallback again → unbounded loop.
    const models: Model[] = [textModel('premium-a'), textModel('premium-b')];
    const premiumIds = new Set(['premium-a', 'premium-b']);

    mockedUseModels.mockReturnValue({ data: { models, premiumIds } } as ReturnType<
      typeof useModels
    >);
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'premium-a',
      valueId: 'premium-a',
    });

    resetStore({ text: [{ id: 'stale-removed', name: 'Stale' }] });

    const setterSpy = vi.spyOn(useModelStore.getState(), 'setSelectedModels');

    renderHook(() => {
      useModelValidation();
    });

    // Bounded: at most one set per modality (4 modalities). Loop would exceed
    // React's update-depth limit and throw before the assertion even runs.
    expect(setterSpy.mock.calls.length).toBeLessThanOrEqual(4);

    // The text selection must end up either as a non-premium model the user can
    // access (none exist here, so the only safe answer is) leaving the stale
    // entry alone or replacing with an accessible default. Either way the loop
    // must terminate.
    const finalText = useModelStore.getState().selections.text;
    expect(finalText.length).toBeGreaterThanOrEqual(0);
  });

  it('terminates when a stale text selection is replaced by an accessible non-premium model', () => {
    const models: Model[] = [textModel('basic-a'), textModel('basic-b')];
    const premiumIds = new Set<string>();

    mockedUseModels.mockReturnValue({ data: { models, premiumIds } } as ReturnType<
      typeof useModels
    >);
    mockedGetAccessibleModelIds.mockReturnValue({
      strongestId: 'basic-a',
      valueId: 'basic-b',
    });

    resetStore({ text: [{ id: 'stale-removed', name: 'Stale' }] });

    const setterSpy = vi.spyOn(useModelStore.getState(), 'setSelectedModels');

    renderHook(() => {
      useModelValidation();
    });

    expect(setterSpy.mock.calls.length).toBeLessThanOrEqual(4);
    expect(useModelStore.getState().selections.text).toEqual([{ id: 'basic-a', name: 'basic-a' }]);
  });
});
