import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { PaletteProvider, usePalette } from '@/components/palette/palette-provider';
import { AdminTopbar } from './admin-topbar.js';

vi.mock('@/lib/env', () => ({ env: { isLocalDev: true } }));

function PaletteState(): React.JSX.Element {
  const { open } = usePalette();
  return <span>{open ? 'palette-open' : 'palette-closed'}</span>;
}

function renderTopbar(): void {
  render(
    <PaletteProvider>
      <AdminTopbar />
      <PaletteState />
    </PaletteProvider>
  );
}

describe('AdminTopbar', () => {
  it('is chrome: a header tagged data-chrome', () => {
    renderTopbar();
    const topbar = screen.getByTestId(TEST_IDS.adminTopbar);
    expect(topbar.tagName).toBe('HEADER');
    expect(topbar).toHaveAttribute('data-chrome', '');
  });

  it('opens the command palette from the search affordance', async () => {
    const user = userEvent.setup();
    renderTopbar();
    expect(screen.getByText('palette-closed')).toBeInTheDocument();
    await user.click(screen.getByTestId(TEST_IDS.adminSearch));
    expect(screen.getByText('palette-open')).toBeInTheDocument();
  });

  it('renders the dev actor switcher', () => {
    renderTopbar();
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toBeInTheDocument();
  });

  it('renders the theme toggle', () => {
    renderTopbar();
    expect(screen.getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
  });
});
