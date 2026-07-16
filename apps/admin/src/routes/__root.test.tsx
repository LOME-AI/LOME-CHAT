import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './__root.js';

vi.mock('@/lib/env', () => ({ env: { isLocalDev: true } }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Outlet: (): React.JSX.Element => <div>Outlet Content</div>,
    Link: ({
      children,
      to,
      ...props
    }: {
      children: React.ReactNode;
      to: string;
    }): React.JSX.Element => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
  };
});

describe('root shell', () => {
  it('renders nav, topbar, and the routed outlet inside a main landmark', () => {
    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.adminShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNav)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminTopbar)).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toContainElement(screen.getByText('Outlet Content'));
  });

  it('mounts the A11yProvider (its colorblind SVG defs render with the shell)', () => {
    renderRoute(Route);
    expect(document.querySelector('filter[id^="a11y-cb"], svg filter')).not.toBeNull();
  });
});
