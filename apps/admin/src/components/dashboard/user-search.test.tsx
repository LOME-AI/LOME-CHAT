import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { UserSearch } from './user-search.js';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return { ...actual, useNavigate: () => navigate };
});

beforeEach(() => {
  navigate.mockClear();
});

describe('UserSearch', () => {
  it('navigates to Customer 360 with the searched term', async () => {
    const user = userEvent.setup();
    render(<UserSearch />);

    await user.type(screen.getByTestId(TEST_IDS.adminUserSearchInput), 'user@example.com');
    await user.click(screen.getByRole('button', { name: /open customer 360/i }));

    expect(navigate).toHaveBeenCalledWith({
      to: '/customer-360',
      search: { q: 'user@example.com' },
    });
  });

  it('trims the term before navigating', async () => {
    const user = userEvent.setup();
    render(<UserSearch />);

    await user.type(screen.getByTestId(TEST_IDS.adminUserSearchInput), '  someone@x.io  ');
    await user.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith({ to: '/customer-360', search: { q: 'someone@x.io' } });
  });

  it('ignores an empty submission', async () => {
    const user = userEvent.setup();
    render(<UserSearch />);

    await user.click(screen.getByRole('button', { name: /open customer 360/i }));

    expect(navigate).not.toHaveBeenCalled();
  });
});
