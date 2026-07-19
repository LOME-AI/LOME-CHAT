import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './__root.js';

vi.mock('@/lib/env', () => ({ isDevAuthEnabled: () => true }));

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

beforeEach(() => {
  // AdminNav parses VITE_WEB_URL (registry-defined in every mode); stub it so
  // the shell renders like a real build. Mirrors admin-nav.test.tsx.
  vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it('renders a skip-to-content link as the first focusable element', () => {
    renderRoute(Route);

    const shell = screen.getByTestId(TEST_IDS.adminShell);
    const focusables = shell.querySelectorAll('a, button, input, [tabindex]');
    expect(focusables[0]).toBe(screen.getByRole('link', { name: /skip to content/i }));
  });

  it('points the skip link at the main content region', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute('href', '#main');
  });

  it('gives main a focusable target for the skip link', () => {
    renderRoute(Route);

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('mounts the A11yProvider (its colorblind SVG defs render with the shell)', () => {
    renderRoute(Route);
    expect(document.querySelector('filter[id^="a11y-cb"], svg filter')).not.toBeNull();
  });
});
