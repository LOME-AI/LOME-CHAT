import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { AdminNav } from './admin-nav.js';

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

  it('shows the HushBox Admin wordmark', () => {
    render(<AdminNav />);
    expect(screen.getByTestId(TEST_IDS.adminNav)).toHaveTextContent('HushBox Admin');
  });

  it.each([
    ['Dashboard', '/'],
    ['Customer 360', '/customer-360'],
    ['Jobs', '/jobs'],
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
