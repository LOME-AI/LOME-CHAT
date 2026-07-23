// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SMART_MODEL_ID, TEST_IDS } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import type { EffortModel } from '@/hooks/chat/use-reasoning-effort';

const { mockUseIsMobile, mockUseModels } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
  mockUseModels: vi.fn(() => ({ data: undefined as { models: EffortModel[] } | undefined })),
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
  ReasoningEffortMenu,
  effortOptionStates,
  EFFORT_DISABLED_REASONS,
} from '@/components/chat/input/reasoning-effort-menu';

/** Effort-native model: high/medium/low ladder, generous context. */
const effortModel: EffortModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const mandatoryModel: EffortModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
};

const plainModel: EffortModel = { id: 'test-model', contextLength: 8192 };

interface RenderMenuOptions {
  isAuthenticated?: boolean;
  maxOutputTokens?: number;
  estimatedInputTokens?: number;
}

function renderMenu(options: RenderMenuOptions = {}): ReturnType<typeof render> {
  return render(
    <ReasoningEffortMenu
      isAuthenticated={options.isAuthenticated ?? true}
      maxOutputTokens={options.maxOutputTokens ?? 100_000}
      estimatedInputTokens={options.estimatedInputTokens ?? 100}
    />
  );
}

function setCatalog(models: EffortModel[]): void {
  mockUseModels.mockReturnValue({ data: { models } });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId(TEST_IDS.effortChip));
}

describe('effortOptionStates', () => {
  it('marks every offered level enabled when balance and context both fit', () => {
    const states = effortOptionStates({
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
    const states = effortOptionStates({
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
    const smallContext: EffortModel = { ...effortModel, contextLength: 10_000 };
    const states = effortOptionStates({
      models: [smallContext],
      maxOutputTokens: 1_000_000,
      estimatedInputTokens: 9900,
    });
    expect(states).toContainEqual({ selection: 'high', state: 'output-limit' });
  });

  it('omits None when a selected model has mandatory reasoning', () => {
    const states = effortOptionStates({
      models: [mandatoryModel],
      maxOutputTokens: 100_000,
      estimatedInputTokens: 100,
    });
    expect(states.some((option) => option.selection === 'none')).toBe(false);
  });

  it('disables None when no output headroom remains at all', () => {
    const states = effortOptionStates({
      models: [effortModel],
      maxOutputTokens: 0,
      estimatedInputTokens: 100,
    });
    expect(states).toContainEqual({ selection: 'none', state: 'balance' });
  });

  it('marks None output-limit-infeasible when the context itself is exhausted', () => {
    const tinyContext: EffortModel = { ...effortModel, contextLength: 100 };
    const states = effortOptionStates({
      models: [tinyContext],
      maxOutputTokens: 1_000_000,
      estimatedInputTokens: 200,
    });
    expect(states).toContainEqual({ selection: 'none', state: 'output-limit' });
  });
});

describe('ReasoningEffortMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'auto' });
    resetStub();
    setCatalog([effortModel]);
  });

  it('renders no chip for a non-reasoning model', () => {
    setCatalog([plainModel]);
    renderMenu();
    expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
  });

  it('renders no chip for the Smart Model sentinel', () => {
    resetStub({
      selections: {
        text: [{ id: SMART_MODEL_ID, name: 'Smart' }],
        image: [],
        audio: [],
        video: [],
      },
    });
    setCatalog([{ id: SMART_MODEL_ID, contextLength: 0 }]);
    renderMenu();
    expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
  });

  it('renders no chip on a non-text modality', () => {
    resetStub({ activeModality: 'image' });
    renderMenu();
    expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
  });

  it('labels the chip with the current selection (Effort · Auto by default)', () => {
    renderMenu();
    expect(screen.getByTestId(TEST_IDS.effortChip)).toHaveAccessibleName('Effort · Auto');
  });

  it('labels the chip with the active level word', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    renderMenu();
    expect(screen.getByTestId(TEST_IDS.effortChip)).toHaveAccessibleName('Effort · Mid');
  });

  it('falls back to Auto on the chip when the preferred level is not offered', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'max' });
    renderMenu();
    expect(screen.getByTestId(TEST_IDS.effortChip)).toHaveAccessibleName('Effort · Auto');
  });

  it('reserves the widest possible label inside the chip so its width never changes', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'low' });
    renderMenu();
    const chip = screen.getByTestId(TEST_IDS.effortChip);
    // Every label is stacked invisibly in the same grid cell, so the chip is
    // always as wide as the widest "Effort · <word>" — regardless of selection.
    // 'Min' is the OFF row's display word (selection value `none`).
    for (const word of ['Auto', 'Lite', 'Low', 'Mid', 'High', 'Max', 'Min']) {
      const ghost = [...chip.querySelectorAll('[aria-hidden="true"]')].find(
        (node) => node.textContent === `Effort · ${word}`
      );
      expect(ghost, `ghost for ${word}`).toBeDefined();
      expect(ghost?.className).toContain('invisible');
      expect(ghost?.className).toContain('col-start-1');
      expect(ghost?.className).toContain('row-start-1');
    }
    // The ghosts never leak into the accessible label.
    expect(chip).toHaveAccessibleName('Effort · Low');
  });

  it('opens an upward menu listing full-word options, Auto first and Min (the off row) last', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Auto', 'High', 'Mid', 'Low', 'Min']);
    const content = items[0]?.closest('[data-slot="dropdown-menu-content"]');
    expect(content).toHaveAttribute('data-side', 'top');
  });

  it('renders the menu at exactly the trigger chip width', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    const content = screen
      .getAllByRole('menuitemradio')[0]
      ?.closest('[data-slot="dropdown-menu-content"]');
    expect(content?.className).toContain('w-[var(--radix-dropdown-menu-trigger-width)]');
    // The primitive's 8rem floor must not win over the trigger width.
    expect(content?.className).not.toContain('min-w-[8rem]');
  });

  it('marks the effective selection as the checked menu item', async () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    expect(screen.getByRole('menuitemradio', { name: 'Mid' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('selects a level with a single click and closes the menu', async () => {
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: 'Low' }));
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
    expect(screen.queryByRole('menuitemradio', { name: 'Low' })).not.toBeInTheDocument();
  });

  it('greys an unaffordable level with the balance reason exposed via aria-describedby', async () => {
    const user = userEvent.setup();
    renderMenu({ maxOutputTokens: 20_000 });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high).toHaveAttribute('aria-disabled', 'true');
    const describedBy = high.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const reason = document.querySelector(`[id="${describedBy ?? ''}"]`);
    expect(reason?.textContent).toBe(EFFORT_DISABLED_REASONS.balance);
  });

  it('uses the output-limit reason when the model context cannot hold the level', async () => {
    setCatalog([{ ...effortModel, contextLength: 10_000 }]);
    const user = userEvent.setup();
    renderMenu({ maxOutputTokens: 1_000_000, estimatedInputTokens: 9900 });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    const reason = document.querySelector(`[id="${high.getAttribute('aria-describedby') ?? ''}"]`);
    expect(reason?.textContent).toBe(EFFORT_DISABLED_REASONS['output-limit']);
  });

  it('ignores activation of a greyed level', async () => {
    const user = userEvent.setup();
    renderMenu({ maxOutputTokens: 20_000 });
    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('renders greyed levels perceivable, never hidden, for signed-in users', async () => {
    const user = userEvent.setup();
    renderMenu({ maxOutputTokens: 20_000 });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high.className).toContain('opacity-60');
    expect(high.className).not.toContain('opacity-40');
  });

  it('hides infeasible levels instead of greying them for trial users', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: false, maxOutputTokens: 20_000 });
    await openMenu(user);
    expect(screen.queryByRole('menuitemradio', { name: 'High' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Low' })).toBeInTheDocument();
  });

  it('resets a trial preference to auto when its level is no longer offered', () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
    renderMenu({ isAuthenticated: false, maxOutputTokens: 20_000 });
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('uses 44px minimum touch targets for menu items on mobile', async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    expect(screen.getByRole('menuitemradio', { name: 'Auto' }).className).toContain('min-h-11');
  });

  it('keeps a collapsed slide wrapper mounted while the chip is hidden', () => {
    setCatalog([plainModel]);
    const { container } = renderMenu();
    const wrapper = container.firstElementChild;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('transition-[grid-template-columns]');
    expect(wrapper?.className).toContain('grid-cols-[0fr]');
  });

  it('expands the slide wrapper when the chip is visible', () => {
    const { container } = renderMenu();
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain('grid-cols-[1fr]');
    expect(wrapper?.className).toContain('transition-[grid-template-columns]');
  });

  it('leaves the slide to the global reduced-motion kill (no motion-reduce override)', () => {
    // html.reduced-motion forces 0.01ms transitions but PRESERVES transitionend
    // (event-ordering by design); a motion-reduce:transition-none override
    // would drop the event and strand the outgoing chip — so it must not exist.
    const { container } = renderMenu();
    expect(container.firstElementChild?.className).not.toContain('motion-reduce');
  });

  it('keeps the outgoing chip mounted and inert until the collapse transition ends', () => {
    const view = renderMenu();
    expect(screen.getByTestId(TEST_IDS.effortChip)).toBeInTheDocument();
    setCatalog([plainModel]);
    view.rerender(
      <ReasoningEffortMenu isAuthenticated maxOutputTokens={100_000} estimatedInputTokens={100} />
    );
    const wrapper = view.container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('grid-cols-[0fr]');
    // Stale chip still slides out: present but inert (aria-hidden ancestor).
    const stale = screen.getByTestId(TEST_IDS.effortChip);
    expect(stale.closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.transitionEnd(wrapper);
    expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
  });

  it('ignores bubbled transitionend events from inner content during the collapse', () => {
    const view = renderMenu();
    setCatalog([plainModel]);
    view.rerender(
      <ReasoningEffortMenu isAuthenticated maxOutputTokens={100_000} estimatedInputTokens={100} />
    );
    const wrapper = view.container.firstElementChild as HTMLElement;
    const inner = wrapper.firstElementChild as HTMLElement;
    // A child transition (e.g. a hover color) bubbling up must not end the
    // slide early — only the wrapper's own grid-columns transition counts.
    fireEvent.transitionEnd(inner);
    expect(screen.getByTestId(TEST_IDS.effortChip)).toBeInTheDocument();
    fireEvent.transitionEnd(wrapper);
    expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
  });

  it('leaves the slide state alone when a transition ends while the chip is visible', () => {
    const view = renderMenu();
    const wrapper = view.container.firstElementChild as HTMLElement;
    fireEvent.transitionEnd(wrapper);
    expect(screen.getByTestId(TEST_IDS.effortChip)).toBeInTheDocument();
    expect(wrapper.className).toContain('grid-cols-[1fr]');
  });
});
