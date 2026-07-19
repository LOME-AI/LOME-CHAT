import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { AdminNav } from './admin-nav.js';

beforeEach(() => {
  // VITE_WEB_URL is registry-defined in every mode; stub it so renders resolve
  // the web-app link like a real build. Individual tests override as needed.
  vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
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

describe('AdminNav', () => {
  it('is chrome: a nav tagged data-chrome', () => {
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    expect(nav.tagName).toBe('NAV');
    expect(nav).toHaveAttribute('data-chrome', '');
  });

  it('fails fast when VITE_WEB_URL is missing (required var, parsed not cast)', () => {
    vi.stubEnv('VITE_WEB_URL', '');
    expect(() => render(<AdminNav />)).toThrow();
  });

  it('renders the shared brand logo linking to the web app chat', () => {
    vi.stubEnv('VITE_WEB_URL', 'http://localhost:5173');
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: 'HushBox - Go to chat' });
    expect(link).toHaveAttribute('href', 'http://localhost:5173/chat');
    expect(within(link).getByTestId(TEST_IDS.logo)).toBeInTheDocument();
  });

  it('gives the sidebar header the shared app-header-height token', () => {
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: 'HushBox - Go to chat' });
    const header = link.closest('div');
    expect(header?.className).toContain('min-h-[var(--app-header-height)]');
    expect(header?.className).not.toContain('h-11');
  });

  it('collapses to an icon rail below the breakpoint while keeping nav reachable', () => {
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    // Rail behavior is class-driven: narrow width by default, full width from
    // the min-[900px] breakpoint up; labels stay in the accessibility tree
    // (sr-only) and every link carries a tooltip title.
    expect(nav.className).toContain('w-14');
    expect(nav.className).toContain('min-[900px]:w-52');
    const link = within(nav).getByRole('link', { name: 'Dashboard' });
    expect(link).toHaveAttribute('title', 'Dashboard');
  });

  it('gives nav links the token focus ring instead of the UA default', () => {
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: 'Dashboard' });
    expect(link.className).toContain('outline-none');
    expect(link.className).toContain('focus-visible:ring-ring/50');
    expect(link.className).toContain('focus-visible:ring-[3px]');
  });

  it.each([
    ['Dashboard', '/'],
    ['Customer 360', '/customer-360'],
    ['Jobs', '/jobs'],
    ['Feedback', '/feedback'],
    ['Newsletter', '/newsletter'],
    ['Audit trail', '/audit'],
    ['Models', '/models'],
    ['SQL panel', '/sql'],
    ['Ops catalog', '/ops'],
  ])('links %s to %s', (label, href) => {
    render(<AdminNav />);
    const nav = screen.getByTestId(TEST_IDS.adminNav);
    const link = within(nav).getByRole('link', { name: label });
    expect(link).toHaveAttribute('href', href);
  });
});
