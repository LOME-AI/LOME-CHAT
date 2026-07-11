import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MARKETING_BASE_URL, ROUTES, TEST_IDS } from '@hushbox/shared';

const { mockUnportedEndpoint, mockOpenExternalUrl } = vi.hoisted(() => ({
  mockUnportedEndpoint: vi.fn(),
  mockOpenExternalUrl: vi.fn(),
}));

// UNPORTED: the login-link route is not mounted on the rebuilt backend; the
// component routes through `unportedEndpoint` (a 404-shaped rejection) and
// never touches the typed client. These tests pin the click flow around that
// seam so the repoint is mechanical once the route lands.
vi.mock('@/lib/unported-endpoint.js', () => ({
  unportedEndpoint: mockUnportedEndpoint,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

import { ManageOnlineButton } from './manage-online-button';

describe('ManageOnlineButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with "Manage Balance Online" text', () => {
    render(<ManageOnlineButton />);

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toHaveTextContent(
      'Manage Balance Online'
    );
  });

  it('opens the external URL when the token call resolves', async () => {
    const user = userEvent.setup();
    mockUnportedEndpoint.mockResolvedValueOnce({ token: 'test-token-123' });

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(mockUnportedEndpoint).toHaveBeenCalledWith('POST /api/billing/login-link');
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      `${MARKETING_BASE_URL}${ROUTES.BILLING}?token=test-token-123`
    );
  });

  it('disables button while loading', async () => {
    const user = userEvent.setup();
    let resolveToken!: (value: { token: string }) => void;
    mockUnportedEndpoint.mockReturnValueOnce(
      new Promise<{ token: string }>((resolve) => {
        resolveToken = resolve;
      })
    );

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toBeDisabled();

    resolveToken({ token: 'tok' });

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
  });

  it('re-enables button after error', async () => {
    const user = userEvent.setup();
    mockUnportedEndpoint.mockRejectedValueOnce(new Error('Network error'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open browser when the token call fails', async () => {
    const user = userEvent.setup();
    mockUnportedEndpoint.mockRejectedValueOnce(new Error('Auth failed'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });
});
