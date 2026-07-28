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

vi.mock('@/hooks/billing/use-spendable.js', () => ({
  useSpendable: vi.fn(),
}));

vi.mock('@/hooks/models/models.js', () => ({
  useModels: vi.fn(),
  getAccessibleModelIds: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useSpendable } from '@/hooks/billing/use-spendable.js';
import { useModels, getAccessibleModelIds } from '@/hooks/models/models.js';

const mockedUseSession = vi.mocked(useSession);
const mockedUseSpendable = vi.mocked(useSpendable);
const mockedUseModels = vi.mocked(useModels);
const mockedGetAccessibleModelIds = vi.mocked(getAccessibleModelIds);

const textModel = (id: string): Model => ({
  id,
  name: id,
  description: '',
  provider: 'p',
  modality: 'text' as const,
  contextLength: 100_000,
  capabilities: [],
  supportedParameters: [],
  created: 0,
  pricing: { inputPerToken: '100000', outputPerToken: '300000' },
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
    mockedUseSpendable.mockReturnValue({
      data: { spendableNanoUsd: '0', heldNanoUsd: '0', tier: 'free', payer: 'self' },
    } as never);
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

    // Stronger than "it terminates": the loop's engine was dropping a premium
    // selection and substituting a premium fallback. Premium entries are no
    // longer dropped at all, so the text selection is left exactly as it was
    // and there is no cycle to bound.
    expect(useModelStore.getState().selections.text).toEqual([
      { id: 'stale-removed', name: 'Stale' },
    ]);
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
