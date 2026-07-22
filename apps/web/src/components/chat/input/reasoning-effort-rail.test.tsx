// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { RailModel } from '@/hooks/chat/use-reasoning-effort';

const { mockUseIsMobile, mockUseModels } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
  mockUseModels: vi.fn(() => ({ data: undefined as { models: RailModel[] } | undefined })),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, useIsMobile: mockUseIsMobile };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

import {
  ReasoningEffortRail,
  railPillStates,
  RAIL_DISABLED_REASONS,
} from '@/components/chat/input/reasoning-effort-rail';

/** Effort-native model: high/medium/low ladder, generous context. */
const effortModel: RailModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const mandatoryModel: RailModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

const plainModel: RailModel = { id: 'test-model', contextLength: 8192 };

interface RenderRailOptions {
  isAuthenticated?: boolean;
  maxOutputTokens?: number;
  estimatedInputTokens?: number;
}

function renderRail(options: RenderRailOptions = {}): void {
  render(
    <ReasoningEffortRail
      isAuthenticated={options.isAuthenticated ?? true}
      maxOutputTokens={options.maxOutputTokens ?? 100_000}
      estimatedInputTokens={options.estimatedInputTokens ?? 100}
    />
  );
}

function setCatalog(models: RailModel[]): void {
  mockUseModels.mockReturnValue({ data: { models } });
}

describe('railPillStates', () => {
  it('marks every offered level enabled when balance and context both fit', () => {
    const states = railPillStates({
      models: [effortModel],
      maxOutputTokens: 100_000,
      estimatedInputTokens: 100,
    });
    expect(states).toEqual([
      { selection: 'auto', state: 'enabled' },
      { selection: 'high', state: 'enabled' },
      { selection: 'medium', state: 'enabled' },
      { selection: 'low', state: 'enabled' },
      { selection: 'none', state: 'enabled' },
    ]);
  });

  it('marks a level the balance cannot fund as balance-infeasible', () => {
    // high's budget tier is 32k tokens; 20k affordable output cannot cover it.
    const states = railPillStates({
      models: [effortModel],
      maxOutputTokens: 20_000,
      estimatedInputTokens: 100,
    });
    expect(states).toContainEqual({ selection: 'high', state: 'balance' });
    expect(states).toContainEqual({ selection: 'low', state: 'enabled' });
  });

  it('marks a level the model context cannot hold as output-limit-infeasible', () => {
    // context 10k − 9.9k input leaves 100 tokens of context headroom: below
    // even the min budget tier, while the balance itself is ample.
    const smallContext: RailModel = { ...effortModel, contextLength: 10_000 };
    const states = railPillStates({
      models: [smallContext],
      maxOutputTokens: 1_000_000,
      estimatedInputTokens: 9900,
    });
    expect(states).toContainEqual({ selection: 'high', state: 'output-limit' });
  });

  it('omits None when a selected model has mandatory reasoning', () => {
    const states = railPillStates({
      models: [mandatoryModel],
      maxOutputTokens: 100_000,
      estimatedInputTokens: 100,
    });
    expect(states.some((pill) => pill.selection === 'none')).toBe(false);
  });

  it('disables None when no output headroom remains at all', () => {
    const states = railPillStates({
      models: [effortModel],
      maxOutputTokens: 0,
      estimatedInputTokens: 100,
    });
    expect(states).toContainEqual({ selection: 'none', state: 'balance' });
  });

  it('marks None output-limit-infeasible when the context itself is exhausted', () => {
    const tinyContext: RailModel = { ...effortModel, contextLength: 100 };
    const states = railPillStates({
      models: [tinyContext],
      maxOutputTokens: 1_000_000,
      estimatedInputTokens: 200,
    });
    expect(states).toContainEqual({ selection: 'none', state: 'output-limit' });
  });
});

describe('ReasoningEffortRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
    resetStub();
    setCatalog([effortModel]);
  });

  it('renders nothing for a non-reasoning model', () => {
    setCatalog([plainModel]);
    renderRail();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('renders nothing for the Smart Model sentinel', () => {
    resetStub({
      selections: {
        text: [{ id: SMART_MODEL_ID, name: 'Smart' }],
        image: [],
        audio: [],
        video: [],
      },
    });
    setCatalog([{ id: SMART_MODEL_ID, contextLength: 0 }]);
    renderRail();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('renders nothing on a non-text modality', () => {
    resetStub({ activeModality: 'image' });
    renderRail();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('renders a radiogroup with full-word accessible names, Auto on top and None last', () => {
    renderRail();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'Auto',
      'High',
      'Medium',
      'Low',
      'None',
    ]);
  });

  it('marks the effective selection as the checked radio', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    renderRail();
    expect(screen.getByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows Auto as checked when the preferred level is not offered by this model', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'max' });
    renderRail();
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
  });

  it('selects a level with a single click', () => {
    renderRail();
    fireEvent.click(screen.getByRole('radio', { name: 'Low' }));
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
  });

  it('disables an unaffordable level with the balance reason exposed via aria-describedby', () => {
    renderRail({ maxOutputTokens: 20_000 });
    const high = screen.getByRole('radio', { name: 'High' });
    expect(high).toHaveAttribute('aria-disabled', 'true');
    const describedBy = high.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const reason = document.querySelector(`[id="${describedBy ?? ''}"]`);
    expect(reason?.textContent).toBe(RAIL_DISABLED_REASONS.balance);
  });

  it('uses the output-limit reason when the model context cannot hold the level', () => {
    setCatalog([{ ...effortModel, contextLength: 10_000 }]);
    renderRail({ maxOutputTokens: 1_000_000, estimatedInputTokens: 9900 });
    const high = screen.getByRole('radio', { name: 'High' });
    const reason = document.querySelector(`[id="${high.getAttribute('aria-describedby') ?? ''}"]`);
    expect(reason?.textContent).toBe(RAIL_DISABLED_REASONS['output-limit']);
  });

  it('ignores clicks on a disabled level', () => {
    renderRail({ maxOutputTokens: 20_000 });
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('hides infeasible levels instead of disabling them for trial users', () => {
    renderRail({ isAuthenticated: false, maxOutputTokens: 20_000 });
    expect(screen.queryByRole('radio', { name: 'High' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Low' })).toBeInTheDocument();
  });

  it('resets a trial preference to auto when its level is no longer offered', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
    renderRail({ isAuthenticated: false, maxOutputTokens: 20_000 });
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('moves focus with arrow keys through the roving tabindex', () => {
    renderRail();
    const auto = screen.getByRole('radio', { name: 'Auto' });
    auto.focus();
    fireEvent.keyDown(auto, { key: 'ArrowDown' });
    expect(screen.getByRole('radio', { name: 'High' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'High' }), { key: 'ArrowUp' });
    expect(auto).toHaveFocus();
  });

  it('jumps to the first and last pills with Home and End', () => {
    renderRail();
    const auto = screen.getByRole('radio', { name: 'Auto' });
    auto.focus();
    fireEvent.keyDown(auto, { key: 'End' });
    expect(screen.getByRole('radio', { name: 'None' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: 'None' }), { key: 'Home' });
    expect(auto).toHaveFocus();
  });

  it('leaves focus in place on an unrelated key', () => {
    renderRail();
    const auto = screen.getByRole('radio', { name: 'Auto' });
    auto.focus();
    fireEvent.keyDown(auto, { key: 'a' });
    expect(auto).toHaveFocus();
  });

  it('keeps focus on the first pill when ArrowUp has nowhere to go', () => {
    renderRail();
    const auto = screen.getByRole('radio', { name: 'Auto' });
    auto.focus();
    fireEvent.keyDown(auto, { key: 'ArrowUp' });
    expect(auto).toHaveFocus();
  });

  it('uses 44px minimum touch targets on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    renderRail();
    expect(screen.getByRole('radio', { name: 'Auto' }).className).toContain('min-h-11');
  });

  it('selects the focused level with the keyboard', () => {
    renderRail();
    const low = screen.getByRole('radio', { name: 'Low' });
    low.focus();
    fireEvent.keyDown(low, { key: ' ' });
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
  });
});
