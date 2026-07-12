import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MARKETING_BASE_URL, ROUTES, TEST_IDS } from '@hushbox/shared';

const { mockLoginLinkPost, mockFetchJson, mockOpenExternalUrl } = vi.hoisted(() => ({
  mockLoginLinkPost: vi.fn(),
  mockFetchJson: vi.fn(),
  mockOpenExternalUrl: vi.fn(),
}));

vi.mock('@/lib/api-client.js', () => ({
  client: {
    billing: {
      'login-link': { $post: mockLoginLinkPost },
    },
  },
  fetchJson: mockFetchJson,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

import { ManageOnlineButton } from './manage-online-button';

describe('ManageOnlineButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoginLinkPost.mockReturnValue(Promise.resolve(new Response()));
  });

  it('renders with "Manage Balance Online" text', () => {
    render(<ManageOnlineButton />);

    expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).toHaveTextContent(
      'Manage Balance Online'
    );
  });

  it('opens the external URL with the minted token and sends an Idempotency-Key', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockResolvedValueOnce({ token: 'test-token-123' });

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(mockLoginLinkPost).toHaveBeenCalledWith(
        {},
        { headers: { 'Idempotency-Key': expect.any(String) } }
      );
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(
      `${MARKETING_BASE_URL}${ROUTES.BILLING}?token=test-token-123`
    );
  });

  it('disables button while loading', async () => {
    const user = userEvent.setup();
    let resolveToken!: (value: { token: string }) => void;
    mockFetchJson.mockReturnValueOnce(
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
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open browser when the token call fails', async () => {
    const user = userEvent.setup();
    mockFetchJson.mockRejectedValueOnce(new Error('Auth failed'));

    render(<ManageOnlineButton />);

    await user.click(screen.getByTestId(TEST_IDS.manageOnlineButton));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.manageOnlineButton)).not.toBeDisabled();
    });
    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });
});
