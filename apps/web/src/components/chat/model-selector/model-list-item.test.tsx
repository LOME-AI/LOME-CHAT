import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { TEST_IDS, noticeText, type Model, type RefusalCode } from '@hushbox/shared';
import { ModelListItem } from '@/components/chat/model-selector/model-list-item';
import type { ModelListItemProps } from '@/components/chat/model-selector/model-list-item';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    onClick,
  }: {
    children: React.ReactNode;
    to: string;
    onClick?: (e: React.MouseEvent) => void;
  }) => (
    <a href={to} data-testid="overlay-link" onClick={onClick}>
      {children}
    </a>
  ),
}));

function makeModel(): Model {
  return {
    id: 'm1',
    name: 'Test Model',
    description: 'desc',
    provider: 'prov',
    modality: 'text',
    contextLength: 8000,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  } as unknown as Model;
}

function baseProps(overrides: Partial<ModelListItemProps> = {}): ModelListItemProps {
  return {
    model: makeModel(),
    isFocused: false,
    isSelected: false,
    isDisabled: false,
    availability: { available: true },
    pickerMode: 'single',
    isExpanded: false,
    isMobile: false,
    isPulsing: false,
    cascadeIndex: 0,
    onActivate: vi.fn(),
    onHover: vi.fn(),
    onShowInfo: vi.fn(),
    onToggleExpand: vi.fn(),
    ...overrides,
  };
}

function renderItem(props: ModelListItemProps): void {
  render(
    <TouchDeviceOverrideContext value={false}>
      <ModelListItem {...props} />
    </TouchDeviceOverrideContext>
  );
}

describe('ModelListItem premium overlay', () => {
  it("offers the reason's action as a link and does not activate the row when it is clicked", () => {
    const onActivate = vi.fn();
    renderItem(
      baseProps({
        availability: { available: false, reason: 'premium_requires_credit' },
        onActivate,
      })
    );

    const link = screen.getByTestId('overlay-link');
    // The wording comes from the shared vocabulary, not from this component.
    expect(link).toHaveTextContent('Add credit');

    fireEvent.click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('offers the sign-up action for a payer with no account', () => {
    renderItem(
      baseProps({ availability: { available: false, reason: 'premium_requires_account' } })
    );

    expect(screen.getByTestId('overlay-link')).toHaveTextContent('Sign up');
  });

  it('decorates nothing when the producer marked the row available', () => {
    // Whether a link guest may reach a premium model is the PRODUCER's verdict
    // (it knows the tier); the row renders what it is given and holds no rule
    // of its own about who is exempt.
    renderItem(baseProps({ availability: { available: true } }));
    expect(screen.queryByTestId('overlay-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.premiumOverlay)).not.toBeInTheDocument();
  });

  it('activates the row when the main button is clicked', () => {
    const onActivate = vi.fn();
    renderItem(baseProps({ onActivate }));
    fireEvent.click(screen.getByRole('button', { name: 'Use Test Model' }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

describe('ModelListItem — typed reasons drive every disabled row', () => {
  /**
   * The picker renders the produced verdict. It never classifies a model, so
   * these fixtures pass an `Availability` exactly as `affordable.all` carries
   * it — a premium lock and a funding shortfall differ only in their reason.
   */
  function unavailable(reason: RefusalCode): Partial<ModelListItemProps> {
    return { availability: { available: false, reason } };
  }

  it.each([
    ['premium_requires_credit'],
    ['premium_requires_account'],
    ['insufficient_funds'],
    ['prompt_too_long'],
  ] as const)('renders %s as the shared copy, never a local sentence', (reason) => {
    render(<ModelListItem {...baseProps(unavailable(reason))} />);

    // The one home for money copy. A locally authored sentence would be a
    // second phrasing of a condition that already has exactly one.
    const expected = noticeText(reason);
    expect(screen.getAllByText(expected).length).toBeGreaterThan(0);
  });

  it('keeps an unavailable row PRESENT, focusable and explained', () => {
    render(<ModelListItem {...baseProps(unavailable('premium_requires_credit'))} />);

    const row = screen.getByRole('option');
    // Marked, never filtered: the row exists and is still reachable.
    expect(row).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /Use Test Model/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    // The reason is an accessible description, not only a hover tooltip.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.querySelector(`[id="${describedBy ?? ''}"]`)).toHaveTextContent(
      noticeText('premium_requires_credit')
    );
  });

  it('leaves an available row undecorated and selectable', () => {
    render(<ModelListItem {...baseProps({ availability: { available: true } })} />);

    const button = screen.getByRole('button', { name: /Use Test Model/ });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('option')).not.toHaveAttribute('data-unavailable');
  });

  it('still reports activation on an unavailable row, so the container can route it', () => {
    // The row must not swallow the click: the container routes a premium lock
    // to the paywall and allows de-selecting a row that became unavailable.
    // Whether the click SELECTS is the container's call, pinned there.
    const onActivate = vi.fn();
    render(<ModelListItem {...baseProps({ ...unavailable('insufficient_funds'), onActivate })} />);

    fireEvent.click(screen.getByRole('button', { name: /Use Test Model/ }));

    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
