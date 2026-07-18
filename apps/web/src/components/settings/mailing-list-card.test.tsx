import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';

vi.mock('@/lib/api-client', () => ({
  client: {
    newsletter: { me: { $get: vi.fn(), $put: vi.fn() } },
  },
  fetchJson: vi.fn(),
}));

import { MailingListCard } from './mailing-list-card';
import { client, fetchJson } from '@/lib/api-client';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);

function stubClientCalls(): void {
  vi.mocked(mockedClient.newsletter.me.$get).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.newsletter.me.$get>
  );
  vi.mocked(mockedClient.newsletter.me.$put).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<typeof mockedClient.newsletter.me.$put>
  );
}

const DESCRIPTION_COPY =
  'A few letters a year to your account email. No tracking. Separate from account and billing emails.';

describe('MailingListCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubClientCalls();
  });

  it('renders the title and the exact description copy', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: false });
    renderWithProviders(<MailingListCard />);

    expect(screen.getByText('Mailing list')).toBeInTheDocument();
    expect(screen.getByText(DESCRIPTION_COPY)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.settingsMailingListToggle)).toBeInTheDocument();
    });
  });

  it('shows a skeleton instead of the toggle while the settings load', () => {
    mockedFetchJson.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<MailingListCard />);

    expect(screen.queryByTestId(TEST_IDS.settingsMailingListToggle)).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
  });

  it('shows an error message instead of the toggle when the settings fail to load', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MailingListCard />);

    await waitFor(() => {
      expect(screen.getByText('Could not load this setting. Refresh to try again.')).toBeVisible();
    });
    expect(screen.queryByTestId(TEST_IDS.settingsMailingListToggle)).not.toBeInTheDocument();
  });

  it('reflects a subscribed account as a checked switch', async () => {
    mockedFetchJson.mockResolvedValue({ subscribed: true });
    renderWithProviders(<MailingListCard />);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.settingsMailingListToggle)).toBeChecked();
    });
  });

  it('sends the flipped value on toggle and disables the switch while pending', async () => {
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    let resolvePut: (value: unknown) => void = () => {};
    mockedFetchJson.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePut = resolve;
        })
    );
    const user = userEvent.setup();
    renderWithProviders(<MailingListCard />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    expect(mockedClient.newsletter.me.$put).toHaveBeenCalledWith({ json: { subscribed: true } });
    expect(toggle).toBeDisabled();

    resolvePut({ subscribed: true });
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).toBeChecked();
  });

  it('settles to unchecked without an error when the server answers false to an optimistic subscribe', async () => {
    // Complaint-suppressed subscriber: the server refuses the resubscribe and
    // answers {subscribed: false}. Deliberate product behavior, not an error.
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    const user = userEvent.setup();
    renderWithProviders(<MailingListCard />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).not.toBeChecked();
    expect(
      screen.queryByText('Could not load this setting. Refresh to try again.')
    ).not.toBeInTheDocument();
  });

  it('restores the previous switch state when the update fails', async () => {
    mockedFetchJson.mockResolvedValueOnce({ subscribed: false });
    mockedFetchJson.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderWithProviders(<MailingListCard />);

    const toggle = await screen.findByTestId(TEST_IDS.settingsMailingListToggle);
    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    expect(toggle).not.toBeChecked();
  });
});
