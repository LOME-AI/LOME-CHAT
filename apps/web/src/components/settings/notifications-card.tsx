import * as React from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { notificationChannel } from '@/lib/notification-channel';
import { useNotificationActivityStore } from '@/stores/notification-activity';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '@/hooks/notifications/use-notification-preferences';
import type {
  NotificationPreferences,
  NotificationPreferencesUpdate,
} from '@/hooks/notifications/use-notification-preferences';
import type { PushPermissionState } from '@/lib/notification-channel';

type QuietHours = NonNullable<NotificationPreferences['quietHours']>;

const CATEGORIES = [
  {
    field: 'messages',
    id: 'notifications-messages',
    label: 'New messages',
    description: 'Replies in conversations you are part of.',
  },
  {
    field: 'runCompletion',
    id: 'notifications-run-completion',
    label: 'Finished runs',
    description: 'When a model finishes work you started.',
  },
  {
    field: 'membership',
    id: 'notifications-membership',
    label: 'Invitations and shares',
    description: 'When someone adds you to a conversation or shares one with you.',
  },
] as const;

/**
 * What each platform answer means for the person reading it. `denied` says the
 * prompt is gone for good because it is: browsers and phones raise it once, and
 * the only way back is their own settings — telling them to try the switch
 * again would send them in a circle.
 */
const PERMISSION_MESSAGE: Readonly<Record<PushPermissionState, string>> = {
  granted: 'This device is allowed to show notifications.',
  default: 'This device has not been asked yet.',
  denied:
    'This device is blocking notifications and will not ask again. Turn them on in your notification settings for HushBox.',
  unsupported: 'This device cannot show push notifications.',
};

const MINUTES_PER_HOUR = 60;
const HOURS_OF_DAY = Array.from({ length: 24 }, (_unused, hour) => ({
  minutes: hour * MINUTES_PER_HOUR,
  label: `${String(hour).padStart(2, '0')}:00`,
}));

const DEFAULT_QUIET_START_MINUTES = 22 * MINUTES_PER_HOUR;
const DEFAULT_QUIET_END_MINUTES = 7 * MINUTES_PER_HOUR;

interface SwitchRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: Readonly<SwitchRowProps>): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <Label htmlFor={id} id={`${id}-label`}>
          {label}
        </Label>
        <p id={`${id}-description`} className="text-muted-foreground text-sm">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="mt-1 shrink-0"
      />
    </div>
  );
}

interface HourSelectProps {
  id: string;
  label: string;
  minutes: number;
  disabled: boolean;
  onSelect: (minutes: number) => void;
}

function HourSelect({
  id,
  label,
  minutes,
  disabled,
  onSelect,
}: Readonly<HourSelectProps>): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} id={`${id}-label`}>
        {label}
      </Label>
      <Select
        value={String(minutes)}
        disabled={disabled}
        onValueChange={(next) => {
          onSelect(Number(next));
        }}
      >
        <SelectTrigger id={id} aria-labelledby={`${id}-label`} className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HOURS_OF_DAY.map((hour) => (
            <SelectItem key={hour.minutes} value={String(hour.minutes)}>
              {hour.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface QuietHoursFieldsProps {
  quietHours: QuietHours;
  deviceTimezone: string;
  disabled: boolean;
  onChange: (next: QuietHours) => void;
}

/**
 * The zone on display is the saved one, because that is the zone the server
 * evaluates the window in. It is only re-stamped from the device when a bound
 * is written, so someone who travelled keeps their old zone — and their old
 * quiet window — until they change a time here. Showing the device zone instead
 * would claim a window the server is not enforcing.
 */
function QuietHoursFields({
  quietHours,
  deviceTimezone,
  disabled,
  onChange,
}: Readonly<QuietHoursFieldsProps>): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-4">
        <HourSelect
          id="notifications-quiet-hours-start"
          label="From"
          minutes={quietHours.startMinutes}
          disabled={disabled}
          onSelect={(startMinutes) => {
            onChange({ ...quietHours, startMinutes, timezone: deviceTimezone });
          }}
        />
        <HourSelect
          id="notifications-quiet-hours-end"
          label="Until"
          minutes={quietHours.endMinutes}
          disabled={disabled}
          onSelect={(endMinutes) => {
            onChange({ ...quietHours, endMinutes, timezone: deviceTimezone });
          }}
        />
      </div>
      <p className="text-muted-foreground text-sm">{`Hours are read in ${quietHours.timezone}.`}</p>
      {quietHours.timezone !== deviceTimezone && (
        <p className="text-muted-foreground text-sm">
          {`This device is in ${deviceTimezone}. Change a time to move quiet hours here.`}
        </p>
      )}
    </div>
  );
}

interface PreferenceControlsProps {
  preferences: NotificationPreferences;
  disabled: boolean;
  onSave: (next: NotificationPreferencesUpdate) => void;
}

function PreferenceControls({
  preferences,
  disabled,
  onSave,
}: Readonly<PreferenceControlsProps>): React.JSX.Element {
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { quietHours } = preferences;

  return (
    <div className="space-y-6">
      <SwitchRow
        id="notifications-all"
        label="All notifications"
        description="Off stops every notification, on every device."
        checked={preferences.globalEnabled}
        disabled={disabled}
        onCheckedChange={(globalEnabled) => {
          onSave({ ...preferences, globalEnabled });
        }}
      />

      <fieldset className="space-y-4 border-0 p-0">
        <legend className="mb-4 text-sm font-medium">What you get notified about</legend>
        {CATEGORIES.map((category) => (
          <SwitchRow
            key={category.field}
            id={category.id}
            label={category.label}
            description={category.description}
            checked={preferences[category.field]}
            disabled={disabled}
            onCheckedChange={(checked) => {
              onSave({ ...preferences, [category.field]: checked });
            }}
          />
        ))}
      </fieldset>

      <fieldset className="space-y-4 border-0 p-0">
        <legend className="mb-4 text-sm font-medium">Quiet hours</legend>
        <SwitchRow
          id="notifications-quiet-hours"
          label="Quiet hours"
          description="Notifications that arrive during quiet hours are dropped, not delivered later."
          checked={quietHours !== null}
          disabled={disabled}
          onCheckedChange={(checked) => {
            onSave({
              ...preferences,
              quietHours: checked
                ? {
                    startMinutes: DEFAULT_QUIET_START_MINUTES,
                    endMinutes: DEFAULT_QUIET_END_MINUTES,
                    timezone: deviceTimezone,
                  }
                : null,
            });
          }}
        />
        {quietHours !== null && (
          <QuietHoursFields
            quietHours={quietHours}
            deviceTimezone={deviceTimezone}
            disabled={disabled}
            onChange={(next) => {
              onSave({ ...preferences, quietHours: next });
            }}
          />
        )}
      </fieldset>
    </div>
  );
}

interface DevicePermissionState {
  permission: PushPermissionState | null;
  isAsking: boolean;
  ask: () => void;
  refresh: () => void;
}

/**
 * This device's side of the story, read through the same facade the one-time
 * prompt uses. It is deliberately a separate reading from the account
 * preferences: the switches say what the server will send, the platform says
 * whether anything can arrive, and they disagree often enough that the card
 * has to show both. `null` means not read yet — the card says nothing rather
 * than guessing.
 */
function useDevicePermission(): DevicePermissionState {
  const [permission, setPermission] = React.useState<PushPermissionState | null>(null);
  const [isAsking, setIsAsking] = React.useState(false);

  const refresh = React.useCallback((): void => {
    void (async (): Promise<void> => {
      try {
        setPermission(await notificationChannel.getPermissionState());
      } catch {
        // An unreadable platform is not an answer: keep the last known state
        // rather than claiming one the device never gave.
      }
    })();
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const ask = React.useCallback((): void => {
    setIsAsking(true);
    void (async (): Promise<void> => {
      try {
        setPermission(await notificationChannel.requestPermissionAndRegister());
      } catch {
        // The grant can land and registration still fail; re-read the platform
        // instead of assuming which of the two happened.
        refresh();
      } finally {
        setIsAsking(false);
      }
    })();
  }, [refresh]);

  return { permission, isAsking, ask, refresh };
}

/**
 * What this device will actually do with a notification.
 *
 * Without this, the account switch is the only thing on screen and it lies by
 * omission: someone who answered "Later" — or blocked the prompt — sees an "on"
 * switch and no notifications, with no route back, because the platform prompt
 * is raised once per device and never again.
 */
function DevicePermission({
  permission,
  isAsking,
  ask,
}: Readonly<Omit<DevicePermissionState, 'refresh'>>): React.JSX.Element | null {
  if (permission === null) return null;

  return (
    <div aria-live="polite" className="space-y-3">
      <p className="text-muted-foreground text-sm">{PERMISSION_MESSAGE[permission]}</p>
      {permission === 'default' && (
        <Button size="sm" onClick={ask} disabled={isAsking}>
          Allow notifications
        </Button>
      )}
    </div>
  );
}

/**
 * The chime that plays when activity arrives here. It is a browser setting, not
 * an account one: it lives in this device's store, it is saved the moment it is
 * flipped, and the flip itself is the gesture browsers require before audio may
 * play unprompted — which is why the store's setter is the only way to turn it
 * on. Sound never carries a signal on its own; the badge and the announcer say
 * the same thing.
 */
function SoundSetting(): React.JSX.Element {
  const soundEnabled = useNotificationActivityStore((state) => state.soundEnabled);
  const setSoundEnabled = useNotificationActivityStore((state) => state.setSoundEnabled);

  return (
    <fieldset className="space-y-4 border-0 p-0">
      <legend className="mb-4 text-sm font-medium">On this device</legend>
      <SwitchRow
        id="notifications-sound"
        label="Sound"
        description="Plays a short chime when something arrives while you're looking away."
        checked={soundEnabled}
        disabled={false}
        onCheckedChange={setSoundEnabled}
      />
    </fieldset>
  );
}

/**
 * Account-level notification settings.
 *
 * The switches are account state, but the global one also owns this device's
 * registration: turning it off stops delivery here immediately rather than
 * leaving a live subscription the server would only ever refuse to use, and
 * turning it on asks for permission through the same facade the one-time
 * prompt uses. That device call is best-effort; the saved preference is what
 * decides delivery.
 */
export function NotificationsCard(): React.JSX.Element {
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const device = useDevicePermission();
  const savedGlobalEnabled = preferences.data?.globalEnabled;
  const { refresh: refreshPermission } = device;

  const handleSave = React.useCallback(
    (next: NotificationPreferencesUpdate): void => {
      const globalChanged = next.globalEnabled !== savedGlobalEnabled;
      update.mutate(next, {
        onSuccess: (): void => {
          if (!globalChanged) return;
          void (async (): Promise<void> => {
            try {
              if (next.globalEnabled) {
                await notificationChannel.requestPermissionAndRegister();
              } else {
                await notificationChannel.unregister();
              }
            } catch {
              // Best-effort: the saved preference already decides delivery, and
              // registration heals on the next authenticated app start.
            } finally {
              // Whatever the device answered, the card must show it: a saved
              // "on" preference over a blocked device would otherwise read as
              // working notifications.
              refreshPermission();
            }
          })();
        },
      });
    },
    [refreshPermission, savedGlobalEnabled, update]
  );

  let body: React.JSX.Element;
  if (preferences.isPending) {
    body = (
      <div
        data-testid={TEST_IDS.skeletonBlock}
        className="bg-muted h-24 animate-pulse rounded-md"
        aria-hidden
      />
    );
  } else if (preferences.isError) {
    body = (
      <p className="text-destructive text-sm">
        Could not load these settings. Refresh to try again.
      </p>
    );
  } else {
    body = (
      <PreferenceControls
        preferences={preferences.data}
        disabled={update.isPending}
        onSave={handleSave}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-brand-red">Notifications</CardTitle>
        <CardDescription>
          Push notifications for this account. They never carry message content, only a link back to
          the conversation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {body}
        <DevicePermission
          permission={device.permission}
          isAsking={device.isAsking}
          ask={device.ask}
        />
        <SoundSetting />
      </CardContent>
    </Card>
  );
}
