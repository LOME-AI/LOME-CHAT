import * as React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';

vi.mock('@/lib/api-client', () => ({
  client: { notifications: { preferences: { $get: vi.fn(), $put: vi.fn() } } },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: {
    getPermissionState: vi.fn(),
    requestPermissionAndRegister: vi.fn(),
    ensureRegistered: vi.fn(),
    unregister: vi.fn(),
  },
}));

// Web Audio does not exist in the test DOM; the unlock is what the toggle owes
// the store, so it is observed rather than performed.
vi.mock('@/lib/notification-activity/sound', () => ({
  primeNotificationSound: vi.fn(),
  playNotificationSound: vi.fn(),
}));

// Radix Select drives its listbox through pointer-capture APIs the test DOM
// lacks, so the family is swapped for a native <select> that keeps `value` and
// `onValueChange` observable. The trigger's id and label wiring are carried
// onto the native element so the accessibility assertions still mean something.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  interface SelectChildProps {
    id?: string;
    'aria-labelledby'?: string;
    value?: string;
    children?: React.ReactNode;
  }
  type SelectChild = React.ReactElement<SelectChildProps>;

  function SelectMock({
    value,
    onValueChange,
    disabled,
    children,
  }: Readonly<{
    value: string;
    onValueChange: (next: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }>): React.JSX.Element {
    const nodes = React.Children.toArray(children) as SelectChild[];
    const trigger = nodes.find((node) => node.props.id !== undefined);
    const items = nodes
      .flatMap((node) => React.Children.toArray(node.props.children) as SelectChild[])
      .filter((item) => item.props.value !== undefined);
    return (
      <select
        id={trigger?.props.id}
        aria-labelledby={trigger?.props['aria-labelledby']}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
      >
        {items.map((item) => (
          <option key={item.props.value} value={item.props.value}>
            {item.props.children}
          </option>
        ))}
      </select>
    );
  }

  return {
    ...actual,
    Select: SelectMock,
    SelectTrigger: (): null => null,
    SelectValue: (): null => null,
    SelectContent: (): null => null,
    SelectItem: (): null => null,
  };
});

import { NotificationsCard } from './notifications-card';
import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { notificationChannel } from '@/lib/notification-channel';
import { primeNotificationSound } from '@/lib/notification-activity/sound';
import { useNotificationActivityStore } from '@/stores/notification-activity';

const mockedClient = vi.mocked(client, true);
const mockedFetchJson = vi.mocked(fetchJson);
const mockedUseStableSession = vi.mocked(useStableSession);
const mockedChannel = vi.mocked(notificationChannel);
const mockedPrimeNotificationSound = vi.mocked(primeNotificationSound);

const DEVICE_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A zone this machine is provably not in, whatever the runner's TZ happens to be.
const AWAY_TIMEZONE = DEVICE_TIMEZONE === 'America/New_York' ? 'Europe/London' : 'America/New_York';

const PREFERENCES = {
  globalEnabled: true,
  messages: true,
  runCompletion: true,
  membership: true,
  quietHours: null,
};

function stubClientCalls(): void {
  vi.mocked(mockedClient.notifications.preferences.$get).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<
      typeof mockedClient.notifications.preferences.$get
    >
  );
  vi.mocked(mockedClient.notifications.preferences.$put).mockReturnValue(
    Promise.resolve(new Response()) as unknown as ReturnType<
      typeof mockedClient.notifications.preferences.$put
    >
  );
}

describe('NotificationsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubClientCalls();
    mockedUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: true,
      isStable: true,
      isPending: false,
    });
    mockedChannel.requestPermissionAndRegister.mockResolvedValue('granted');
    mockedChannel.getPermissionState.mockResolvedValue('granted');
    mockedChannel.unregister.mockImplementation(() => Promise.resolve());
  });

  it('reflects the saved preferences on every switch', async () => {
    mockedFetchJson.mockResolvedValue({ ...PREFERENCES, runCompletion: false });
    renderWithProviders(<NotificationsCard />);

    expect(await screen.findByRole('switch', { name: 'All notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'New messages' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Finished runs' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Invitations and shares' })).toBeChecked();
  });

  it('shows a skeleton while the preferences load', () => {
    mockedFetchJson.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<NotificationsCard />);

    expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'All notifications' })).not.toBeInTheDocument();
  });

  it('shows an error message when the preferences fail to load', async () => {
    mockedFetchJson.mockRejectedValue(new Error('boom'));
    renderWithProviders(<NotificationsCard />);

    await waitFor(() => {
      expect(
        screen.getByText('Could not load these settings. Refresh to try again.')
      ).toBeVisible();
    });
    expect(screen.queryByRole('switch', { name: 'All notifications' })).not.toBeInTheDocument();
  });

  it('turns message notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'New messages' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, messages: false },
    });
  });

  it('turns finished-run notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'Finished runs' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, runCompletion: false },
    });
  });

  it('turns invitation notifications off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'Invitations and shares' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, membership: false },
    });
  });

  it('stops delivery to this device when the account switch goes off', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, globalEnabled: false },
    });
    await waitFor(() => {
      expect(mockedChannel.unregister).toHaveBeenCalledTimes(1);
    });
  });

  it('asks this device for permission when the account switch goes on', async () => {
    mockedFetchJson.mockResolvedValue({ ...PREFERENCES, globalEnabled: false });
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    await waitFor(() => {
      expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    });
    expect(mockedChannel.unregister).not.toHaveBeenCalled();
  });

  it('leaves this device registered when only a category changes', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'New messages' }));

    await waitFor(() => {
      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalled();
    });
    expect(mockedChannel.unregister).not.toHaveBeenCalled();
    expect(mockedChannel.requestPermissionAndRegister).not.toHaveBeenCalled();
  });

  it('keeps the account switch usable from the keyboard', async () => {
    mockedFetchJson.mockResolvedValue(PREFERENCES);
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    const accountSwitch = await screen.findByRole('switch', { name: 'All notifications' });
    accountSwitch.focus();
    await user.keyboard(' ');

    expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
      json: { ...PREFERENCES, globalEnabled: false },
    });
  });

  it('survives a failed device call after the preference is saved', async () => {
    mockedFetchJson.mockResolvedValueOnce(PREFERENCES);
    mockedFetchJson.mockResolvedValueOnce({ ...PREFERENCES, globalEnabled: false });
    mockedChannel.unregister.mockRejectedValue(new Error('no service worker'));
    const user = userEvent.setup();
    renderWithProviders(<NotificationsCard />);

    await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

    await waitFor(() => {
      expect(mockedChannel.unregister).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('switch', { name: 'All notifications' })).not.toBeChecked();
  });

  describe('quiet hours', () => {
    const QUIET_HOURS = {
      startMinutes: 1320,
      endMinutes: 420,
      timezone: DEVICE_TIMEZONE,
    };

    it('hides the hour controls while quiet hours are off', async () => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
      renderWithProviders(<NotificationsCard />);

      await screen.findByRole('switch', { name: 'Quiet hours' });
      expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Until')).not.toBeInTheDocument();
    });

    it('saves both bounds and the device timezone when quiet hours go on', async () => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: QUIET_HOURS },
      });
    });

    it('clears both bounds when quiet hours go off', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'Quiet hours' }));

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: null },
      });
    });

    it('shows the saved bounds on the hour controls', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByLabelText<HTMLSelectElement>('From')).toHaveValue('1320');
      expect(screen.getByLabelText<HTMLSelectElement>('Until')).toHaveValue('420');
    });

    it('keeps the other bound and the timezone when the start hour changes', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.selectOptions(await screen.findByLabelText('From'), '1380');

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: { ...QUIET_HOURS, startMinutes: 1380 } },
      });
    });

    it('keeps the other bound and the timezone when the end hour changes', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.selectOptions(await screen.findByLabelText('Until'), '480');

      expect(mockedClient.notifications.preferences.$put).toHaveBeenCalledWith({
        json: { ...PREFERENCES, quietHours: { ...QUIET_HOURS, endMinutes: 480 } },
      });
    });

    it('groups the hour controls under a quiet-hours legend', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsCard />);

      const group = await screen.findByRole('group', { name: 'Quiet hours' });
      expect(group).toContainElement(screen.getByLabelText('From'));
      expect(group).toContainElement(screen.getByLabelText('Until'));
    });

    it('says quiet-hours notifications are dropped rather than delayed', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsCard />);

      expect(
        await screen.findByText(
          'Notifications that arrive during quiet hours are dropped, not delivered later.'
        )
      ).toBeVisible();
    });

    it('shows the timezone the hours are read in', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByText(`Hours are read in ${DEVICE_TIMEZONE}.`)).toBeVisible();
    });

    it('names the saved timezone when this device is somewhere else', async () => {
      mockedFetchJson.mockResolvedValue({
        ...PREFERENCES,
        quietHours: { ...QUIET_HOURS, timezone: AWAY_TIMEZONE },
      });
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByText(`Hours are read in ${AWAY_TIMEZONE}.`)).toBeVisible();
      expect(screen.queryByText(`Hours are read in ${DEVICE_TIMEZONE}.`)).not.toBeInTheDocument();
    });

    it('offers to move the hours here when this device is somewhere else', async () => {
      mockedFetchJson.mockResolvedValue({
        ...PREFERENCES,
        quietHours: { ...QUIET_HOURS, timezone: AWAY_TIMEZONE },
      });
      renderWithProviders(<NotificationsCard />);

      expect(
        await screen.findByText(
          `This device is in ${DEVICE_TIMEZONE}. Change a time to move quiet hours here.`
        )
      ).toBeVisible();
    });

    it('leaves out the device note when the saved timezone is this one', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, quietHours: QUIET_HOURS });
      renderWithProviders(<NotificationsCard />);

      await screen.findByLabelText('From');
      expect(screen.queryByText(/This device is in/)).not.toBeInTheDocument();
    });
  });

  describe('device permission', () => {
    const BLOCKED_MESSAGE =
      'This device is blocking notifications and will not ask again. Turn them on in your notification settings for HushBox.';

    beforeEach(() => {
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('confirms the device is allowed to show notifications', async () => {
      renderWithProviders(<NotificationsCard />);

      expect(
        await screen.findByText('This device is allowed to show notifications.')
      ).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('offers to ask a device that has not been asked yet', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByRole('button', { name: 'Allow notifications' })).toBeVisible();
    });

    it('asks the device for permission from the card', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    });

    it('drops the offer once the device grants permission', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('default');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(
        await screen.findByText('This device is allowed to show notifications.')
      ).toBeVisible();
    });

    it('says a blocked device will not be asked again', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('says a device with no push path cannot show notifications', async () => {
      mockedChannel.getPermissionState.mockResolvedValue('unsupported');
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByText('This device cannot show push notifications.')).toBeVisible();
    });

    it('admits the device still blocks delivery after the account switch goes on', async () => {
      mockedFetchJson.mockResolvedValue({ ...PREFERENCES, globalEnabled: false });
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      mockedChannel.requestPermissionAndRegister.mockResolvedValue('denied');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'All notifications' }));

      await waitFor(() => {
        expect(mockedChannel.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
    });

    it('says nothing while the device state is still unknown', () => {
      mockedChannel.getPermissionState.mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<NotificationsCard />);

      expect(
        screen.queryByText('This device is allowed to show notifications.')
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('keeps the last known state when the platform cannot be read', async () => {
      mockedChannel.getPermissionState.mockRejectedValue(new Error('no permission API'));
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByRole('switch', { name: 'All notifications' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeInTheDocument();
    });

    it('re-reads the device when a permission request throws', async () => {
      mockedChannel.getPermissionState.mockResolvedValueOnce('default');
      mockedChannel.requestPermissionAndRegister.mockRejectedValue(new Error('no service worker'));
      mockedChannel.getPermissionState.mockResolvedValue('denied');
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('button', { name: 'Allow notifications' }));

      expect(await screen.findByText(BLOCKED_MESSAGE)).toBeVisible();
    });
  });

  describe('sound', () => {
    beforeEach(() => {
      useNotificationActivityStore.setState({ soundEnabled: false });
      mockedFetchJson.mockResolvedValue(PREFERENCES);
    });

    it('leaves the chime off until it is asked for', async () => {
      renderWithProviders(<NotificationsCard />);

      expect(await screen.findByRole('switch', { name: 'Sound' })).not.toBeChecked();
    });

    it('turns the chime on', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(true);
      expect(screen.getByRole('switch', { name: 'Sound' })).toBeChecked();
    });

    it('unlocks audio as the chime goes on', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(mockedPrimeNotificationSound).toHaveBeenCalledTimes(1);
    });

    it('turns the chime back off', async () => {
      useNotificationActivityStore.setState({ soundEnabled: true });
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      await user.click(await screen.findByRole('switch', { name: 'Sound' }));

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(false);
      expect(mockedPrimeNotificationSound).not.toHaveBeenCalled();
    });

    it('keeps the chime switch usable from the keyboard', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NotificationsCard />);

      const soundSwitch = await screen.findByRole('switch', { name: 'Sound' });
      soundSwitch.focus();
      await user.keyboard(' ');

      expect(useNotificationActivityStore.getState().soundEnabled).toBe(true);
    });

    it('offers the chime while account settings are still loading', () => {
      renderWithProviders(<NotificationsCard />);

      expect(screen.getByRole('switch', { name: 'Sound' })).toBeInTheDocument();
    });
  });
});
