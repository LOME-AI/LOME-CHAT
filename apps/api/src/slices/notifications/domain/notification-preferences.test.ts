import { describe, it, expect } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import {
  getNotificationPreferences,
  putNotificationPreferencesBodySchema,
  saveNotificationPreferences,
  toPreferencesView,
} from './notification-preferences.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { NotificationPreferences, NotificationPreferencesStore } from '../ports/index.js';

const quiet: NotificationPreferences = {
  globalEnabled: true,
  messages: false,
  runCompletion: true,
  membership: false,
  quietHoursStartMinutes: 22 * 60,
  quietHoursEndMinutes: 7 * 60,
  timezone: 'America/New_York',
};

function storeReturning(row: NotificationPreferences | null): {
  store: NotificationPreferencesStore;
  upserts: NotificationPreferences[];
} {
  const upserts: NotificationPreferences[] = [];
  return {
    upserts,
    store: {
      read: () => okAsync(row),
      readForUsers: () => okAsync(new Map()),
      upsert: (_userId, preferences) => {
        upserts.push(preferences);
        return okAsync();
      },
    },
  };
}

describe('putNotificationPreferencesBodySchema', () => {
  it('accepts a body with no quiet hours', () => {
    const parsed = putNotificationPreferencesBodySchema.safeParse({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a coherent quiet-hours window with a valid timezone', () => {
    const parsed = putNotificationPreferencesBodySchema.safeParse({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: { startMinutes: 1320, endMinutes: 420, timezone: 'Asia/Tokyo' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-range minute', () => {
    const parsed = putNotificationPreferencesBodySchema.safeParse({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: { startMinutes: 1440, endMinutes: 0, timezone: 'Asia/Tokyo' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    const parsed = putNotificationPreferencesBodySchema.safeParse({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: { startMinutes: 0, endMinutes: 60, timezone: 'Not/AZone' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    const parsed = putNotificationPreferencesBodySchema.safeParse({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: null,
      sneaky: true,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('toPreferencesView', () => {
  it('nests a set quiet-hours window', () => {
    expect(toPreferencesView(quiet)).toEqual({
      globalEnabled: true,
      messages: false,
      runCompletion: true,
      membership: false,
      quietHours: { startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'America/New_York' },
    });
  });

  it('renders null quiet hours when the window is unset', () => {
    expect(toPreferencesView(DEFAULT_NOTIFICATION_PREFERENCES).quietHours).toBeNull();
  });
});

describe('getNotificationPreferences', () => {
  it('returns the defaults view when the user has no row', async () => {
    const { store } = storeReturning(null);

    const result = await getNotificationPreferences(store, 'u1');

    expect(result._unsafeUnwrap()).toEqual(toPreferencesView(DEFAULT_NOTIFICATION_PREFERENCES));
  });

  it('returns the stored view when a row exists', async () => {
    const { store } = storeReturning(quiet);

    const result = await getNotificationPreferences(store, 'u1');

    expect(result._unsafeUnwrap()).toEqual(toPreferencesView(quiet));
  });
});

describe('saveNotificationPreferences', () => {
  it('maps a body with quiet hours onto flat preferences and upserts', async () => {
    const { store, upserts } = storeReturning(null);

    const result = await saveNotificationPreferences(store, 'u1', {
      globalEnabled: true,
      messages: false,
      runCompletion: true,
      membership: false,
      quietHours: { startMinutes: 22 * 60, endMinutes: 7 * 60, timezone: 'America/New_York' },
    });

    expect(result.isOk()).toBe(true);
    expect(upserts[0]).toEqual(quiet);
  });

  it('maps a null quiet-hours body onto null flat fields', async () => {
    const { store, upserts } = storeReturning(null);

    const result = await saveNotificationPreferences(store, 'u1', {
      globalEnabled: false,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: null,
    });
    expect(result.isOk()).toBe(true);

    expect(upserts[0]).toEqual({
      globalEnabled: false,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHoursStartMinutes: null,
      quietHoursEndMinutes: null,
      timezone: null,
    });
  });

  it('returns the saved view', async () => {
    const { store } = storeReturning(null);

    const result = await saveNotificationPreferences(store, 'u1', {
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: null,
    });

    expect(result._unsafeUnwrap().quietHours).toBeNull();
  });
});
