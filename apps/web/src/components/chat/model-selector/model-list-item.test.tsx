import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { TEST_IDS, type Model } from '@hushbox/shared';
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
    isPremium: false,
    isBelowFloor: false,
    canAccessPremium: true,
    isAuthenticated: true,
    isLinkGuest: false,
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
  it('shows a Top up link for an authenticated user on a locked model and stops row activation on click', () => {
    const onActivate = vi.fn();
    renderItem(
      baseProps({ isPremium: true, canAccessPremium: false, isAuthenticated: true, onActivate })
    );

    const link = screen.getByTestId('overlay-link');
    expect(link).toHaveTextContent('Top up');

    fireEvent.click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('shows a Sign up link for an unauthenticated user on a locked model and stops row activation on click', () => {
    const onActivate = vi.fn();
    renderItem(
      baseProps({ isPremium: true, canAccessPremium: false, isAuthenticated: false, onActivate })
    );

    const link = screen.getByTestId('overlay-link');
    expect(link).toHaveTextContent('Sign up');

    fireEvent.click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('does not lock a link guest even on a premium model', () => {
    renderItem(baseProps({ isPremium: true, canAccessPremium: false, isLinkGuest: true }));
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
