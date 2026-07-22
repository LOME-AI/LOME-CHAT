// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SMART_MODEL_ID } from '@hushbox/shared';
import {
  railOfferedLabels,
  railOffersNone,
  effectiveReasoningSelection,
  useReasoningEffort,
  type RailModel,
} from '@/hooks/chat/use-reasoning-effort';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: undefined as { models: RailModel[] } | undefined })),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const { modelStoreState } = vi.hoisted(() => ({
  modelStoreState: {
    current: {
      activeModality: 'text' as string,
      selections: { text: [{ id: 'reasoner' }], image: [], audio: [], video: [] } as Record<
        string,
        { id: string }[]
      >,
    },
  },
}));

vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: unknown) => unknown) => selector(modelStoreState.current),
}));

/** Effort-native model enumerating (descending) high/medium/low. */
const effortModel: RailModel = {
  id: 'reasoner',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** Budget-native model (no effort vocabulary) — full five-rung ladder. */
const budgetModel: RailModel = {
  id: 'budget-reasoner',
  contextLength: 200_000,
  reasoning: {},
};

const mandatoryModel: RailModel = {
  id: 'mandatory-reasoner',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

const plainModel: RailModel = { id: 'plain', contextLength: 8192 };

describe('railOfferedLabels', () => {
  it('maps an enumerated effort vocabulary onto the positional ladder', () => {
    expect(railOfferedLabels([effortModel])).toEqual(['low', 'medium', 'high']);
  });

  it('offers the full ladder for a budget-native model', () => {
    expect(railOfferedLabels([budgetModel])).toEqual(['min', 'low', 'medium', 'high', 'max']);
  });

  it('offers nothing when any selected model lacks reasoning', () => {
    expect(railOfferedLabels([effortModel, plainModel])).toEqual([]);
  });

  it('intersects labels across a multi-model selection in canonical order', () => {
    expect(railOfferedLabels([effortModel, budgetModel])).toEqual(['low', 'medium', 'high']);
  });
});

describe('railOffersNone', () => {
  it('offers None when no selected model has mandatory reasoning', () => {
    expect(railOffersNone([effortModel, budgetModel])).toBe(true);
  });

  it('hides None when any selected model has mandatory reasoning', () => {
    expect(railOffersNone([effortModel, mandatoryModel])).toBe(false);
  });
});

describe('effectiveReasoningSelection', () => {
  it('returns the preferred level when every model offers it', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'high', models: [effortModel], modality: 'text' })
    ).toBe('high');
  });

  it('clamps an unoffered level to auto', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'max', models: [effortModel], modality: 'text' })
    ).toBe('auto');
  });

  it('passes auto through on a reasoning-capable selection', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: [effortModel], modality: 'text' })
    ).toBe('auto');
  });

  it('keeps none when no selected model is mandatory', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'none', models: [effortModel], modality: 'text' })
    ).toBe('none');
  });

  it('clamps none to auto when a selected model has mandatory reasoning', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'none',
        models: [mandatoryModel],
        modality: 'text',
      })
    ).toBe('auto');
  });

  it('is undefined on a non-text modality', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'high', models: [effortModel], modality: 'image' })
    ).toBeUndefined();
  });

  it('is undefined when the Smart Model sentinel is selected', () => {
    expect(
      effectiveReasoningSelection({
        preferred: 'auto',
        models: [{ id: SMART_MODEL_ID, contextLength: 0 }],
        modality: 'text',
      })
    ).toBeUndefined();
  });

  it('is undefined when any selected model lacks offered levels', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: [plainModel], modality: 'text' })
    ).toBeUndefined();
  });

  it('is undefined while the selection is unresolved', () => {
    expect(
      effectiveReasoningSelection({ preferred: 'auto', models: undefined, modality: 'text' })
    ).toBeUndefined();
  });
});

describe('useReasoningEffort', () => {
  beforeEach(() => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
    modelStoreState.current = {
      activeModality: 'text',
      selections: { text: [{ id: 'reasoner' }], image: [], audio: [], video: [] },
    };
    mockUseModels.mockReturnValue({ data: { models: [effortModel] } });
  });

  it('resolves the effective selection from the catalog rows of the selected models', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBe('medium');
  });

  it('is undefined while the catalog has not loaded', () => {
    mockUseModels.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBeUndefined();
  });

  it('is undefined when the active modality selection is empty', () => {
    modelStoreState.current = {
      activeModality: 'audio',
      selections: { text: [], image: [], audio: [], video: [] },
    };
    const { result } = renderHook(() => useReasoningEffort());
    expect(result.current.effective).toBeUndefined();
  });

  it('setSelection writes the persisted preference', () => {
    const { result } = renderHook(() => useReasoningEffort());
    act(() => {
      result.current.setSelection('low');
    });
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
  });
});
