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
  effortOptionsFrom,
} from '@/components/chat/input/reasoning-effort-menu';
import { noticeText } from '@hushbox/shared';
import type { Availability, DimensionAvailability } from '@hushbox/shared';

/** A produced effort dimension, exactly as `affordable.turnDimensions` carries it. */
function dim(rows: [string, string, boolean][]): DimensionAvailability {
  const options = rows.map(([optionId, label, available]) => ({
    optionId: optionId,
    label,
    availability: (available
      ? { available: true }
      : { available: false, reason: 'model_output_cap_too_low' }) satisfies Availability,
  }));
  const [first, ...rest] = options;
  if (first === undefined) throw new Error('a dimension always presents at least one option');
  return { dimensionId: 'effort', options: [first, ...rest] };
}

/** Effort-native model: high/medium/low ladder, generous context. */
const effortModel: EffortModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const plainModel: EffortModel = { id: 'test-model', contextLength: 8192 };

/** Budget-native sibling: offers the full five-rung ladder. */
const budgetNativeModel: EffortModel = {
  id: 'model-b',
  contextLength: 200_000,
  reasoning: {},
};

interface RenderMenuOptions {
  /** The produced dimension; defaults to a fully-available three-rung ladder. */
  dimension?: DimensionAvailability;
}

const DEFAULT_DIMENSION = dim([
  ['off', 'Min', true],
  ['low', 'Low', true],
  ['medium', 'Mid', true],
  ['high', 'High', true],
]);

function renderMenu(options: RenderMenuOptions = {}): ReturnType<typeof render> {
  return render(<ReasoningEffortMenu effortDimension={options.dimension ?? DEFAULT_DIMENSION} />);
}

function setCatalog(models: EffortModel[]): void {
  mockUseModels.mockReturnValue({ data: { models } });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId(TEST_IDS.effortChip));
}

describe("effortOptionsFrom — the producer's presented set, ordered", () => {
  it('renders the UNION, marking a rung only one sibling offers rather than hiding it', () => {
    // The intersection clamp this replaced was wrong in BOTH directions on one
    // selection. Sibling A offers {low, high}; sibling B adds {medium}.
    //   intersection = {low, high} → `medium` VANISHES from the menu, even
    //     though per-model resolution falls downward so the turn can honour it.
    //   producer     = {off, low, medium, high}, each graded by the same query
    //     the send gate runs — so `high` can be PRESENT AND GREYED when neither
    //     sibling can fund it, which the intersection would have enabled.
    const dimension = dim([
      ['off', 'Min', true],
      ['low', 'Low', true],
      ['medium', 'Mid', false],
      ['high', 'High', false],
    ]);

    const options = effortOptionsFrom(dimension);

    // Membership is the producer's: the union-only rung is present.
    expect(options.map((option) => option.selection)).toEqual([
      'auto',
      'high',
      'medium',
      'low',
      'off',
    ]);
    // And it is MARKED, not hidden — greyed-never-hidden, every tier.
    expect(options.find((option) => option.selection === 'medium')?.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
    // A rung both siblings name but neither can fund stays refused.
    expect(options.find((option) => option.selection === 'high')?.availability.available).toBe(
      false
    );
  });

  it('orders Auto first, rungs strongest-first, Min last — order is presentation only', () => {
    const options = effortOptionsFrom(
      dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', true],
      ])
    );

    expect(options.map((option) => option.selection)).toEqual(['auto', 'high', 'low', 'off']);
  });

  it('keeps Auto selectable with no dimension at all — it delegates the choice', () => {
    expect(effortOptionsFrom()).toEqual([{ selection: 'auto', availability: { available: true } }]);
  });

  it('omits Min when no selected model can disable reasoning', () => {
    const options = effortOptionsFrom(
      dim([
        ['low', 'Low', true],
        ['high', 'High', true],
      ])
    );

    expect(options.map((option) => option.selection)).toEqual(['auto', 'high', 'low']);
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
    // 'Min' is the OFF row's display word (selection value `off`).
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

  it('greys a refused level with the SHARED reason exposed via aria-describedby', async () => {
    const user = userEvent.setup();
    renderMenu({
      dimension: dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', false],
      ]),
    });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high).toHaveAttribute('aria-disabled', 'true');
    const describedBy = high.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    const reason = document.querySelector(`[id="${describedBy ?? ''}"]`);
    // The one home for money copy — not a sentence this component authors.
    expect(reason?.textContent).toBe(noticeText('model_output_cap_too_low'));
  });

  it('ignores activation of a greyed level', async () => {
    const user = userEvent.setup();
    renderMenu({
      dimension: dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', false],
      ]),
    });
    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: 'High' }));
    expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
  });

  it('renders greyed levels perceivable, never hidden', async () => {
    const user = userEvent.setup();
    renderMenu({
      dimension: dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', false],
      ]),
    });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high.className).toContain('opacity-60');
    expect(high.className).not.toContain('opacity-40');
  });

  // The menu takes no auth input at all, so greying cannot vary by tier —
  // trial and guest users see the same greyed-never-hidden ladder.
  it('marks an infeasible level aria-disabled while a feasible one stays enabled', async () => {
    const user = userEvent.setup();
    renderMenu({
      dimension: dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', false],
      ]),
    });
    await openMenu(user);
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Low' })).not.toHaveAttribute('aria-disabled');
  });

  it('renders the ladder union across a heterogeneous selection with union-only levels greyed', async () => {
    resetStub({
      selections: {
        text: [
          { id: 'test-model', name: 'A' },
          { id: 'model-b', name: 'B' },
        ],
        image: [],
        audio: [],
        video: [],
      },
    });
    setCatalog([effortModel, budgetNativeModel]);
    const user = userEvent.setup();
    renderMenu({
      dimension: dim([
        ['off', 'Min', true],
        ['lite', 'Lite', true],
        ['low', 'Low', true],
        ['medium', 'Mid', true],
        ['high', 'High', true],
        ['max', 'Max', false],
      ]),
    });
    await openMenu(user);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual([
      'Auto',
      'Max',
      'High',
      'Mid',
      'Low',
      'Lite',
      'Min',
    ]);
    const max = screen.getByRole('menuitemradio', { name: 'Max' });
    expect(max).toHaveAttribute('aria-disabled', 'true');
    const reason = document.querySelector(`[id="${max.getAttribute('aria-describedby') ?? ''}"]`);
    expect(reason?.textContent).toBe(noticeText('model_output_cap_too_low'));
  });

  it('keeps Auto selectable when every level is greyed', async () => {
    useReasoningEffortStore.setState({ preferredReasoningEffort: 'low' });
    const user = userEvent.setup();
    renderMenu();
    await openMenu(user);
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).not.toHaveAttribute(
      'aria-disabled'
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'Auto' }));
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
    view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
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
    view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
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

describe('single-choice model — Auto stays selectable (§Reasoning Effort 10c)', () => {
  /**
   * A model offering exactly ONE distinct resolved rung buys no classifier
   * call: the choice is deterministic. Auto must remain selectable anyway —
   * it means "let the turn decide", and with one option that decision is
   * simply made without a call. Disabling Auto here would tell the user their
   * persisted preference is invalid on a model that honours it perfectly.
   */
  it('renders Auto enabled beside the single rung', () => {
    const options = effortOptionsFrom(dim([['high', 'High', true]]));

    expect(options).toEqual([
      { selection: 'auto', availability: { available: true } },
      { selection: 'high', availability: { available: true } },
    ]);
  });

  it('keeps Auto enabled even when the one rung is refused', () => {
    // Auto is never graded by the producer — it is not an option in the
    // dimension, it is the absence of a pin. So it survives a rung that does not.
    const options = effortOptionsFrom(dim([['high', 'High', false]]));

    expect(options[0]).toEqual({ selection: 'auto', availability: { available: true } });
    expect(options[1]?.availability.available).toBe(false);
  });

  it('renders Auto selectable in the menu with a single-rung ladder', async () => {
    const user = userEvent.setup();
    renderMenu({ dimension: dim([['high', 'High', true]]) });
    await openMenu(user);

    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Auto', 'High']);
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).not.toHaveAttribute(
      'aria-disabled'
    );
  });
});
