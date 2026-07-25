import { inArray } from 'drizzle-orm';
import { notificationPreferences } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NotificationPreferences, NotificationPreferencesStore } from '../ports/index.js';

interface PreferencesRow {
  readonly userId: string;
  readonly globalEnabled: boolean;
  readonly messages: boolean;
  readonly runCompletion: boolean;
  readonly membership: boolean;
  readonly quietHoursStartMinutes: number | null;
  readonly quietHoursEndMinutes: number | null;
  readonly timezone: string | null;
}

function toPreferences(row: PreferencesRow): NotificationPreferences {
  return {
    globalEnabled: row.globalEnabled,
    messages: row.messages,
    runCompletion: row.runCompletion,
    membership: row.membership,
    quietHoursStartMinutes: row.quietHoursStartMinutes,
    quietHoursEndMinutes: row.quietHoursEndMinutes,
    timezone: row.timezone,
  };
}

const SELECTED = {
  userId: notificationPreferences.userId,
  globalEnabled: notificationPreferences.globalEnabled,
  messages: notificationPreferences.messages,
  runCompletion: notificationPreferences.runCompletion,
  membership: notificationPreferences.membership,
  quietHoursStartMinutes: notificationPreferences.quietHoursStartMinutes,
  quietHoursEndMinutes: notificationPreferences.quietHoursEndMinutes,
  timezone: notificationPreferences.timezone,
} as const;

/**
 * The `notification_preferences` single-writer. Reads are lazy — a user with
 * no row resolves to `null`, and the domain applies defaults. `upsert` is one
 * `INSERT … ON CONFLICT (user_id)` so duplicate/racing writes converge on one
 * row (`idempotent.byUpsert`).
 */
export function createNotificationPreferencesStore(db: Database): NotificationPreferencesStore {
  return {
    read(userId: string): ResultAsync<NotificationPreferences | null, DomainError> {
      return fromPromise(
        db
          .select(SELECTED)
          .from(notificationPreferences)
          .where(inArray(notificationPreferences.userId, [userId])),
        (cause) => unavailableError('notification-preferences read failed', cause)
      ).map((rows) => {
        const row = rows[0];
        return row === undefined ? null : toPreferences(row);
      });
    },

    readForUsers(
      userIds: readonly string[]
    ): ResultAsync<ReadonlyMap<string, NotificationPreferences>, DomainError> {
      if (userIds.length === 0) {
        return okAsync(new Map());
      }
      return fromPromise(
        db
          .select(SELECTED)
          .from(notificationPreferences)
          .where(inArray(notificationPreferences.userId, [...userIds])),
        (cause) => unavailableError('notification-preferences lookup failed', cause)
      ).map((rows) => new Map(rows.map((row) => [row.userId, toPreferences(row)])));
    },

    upsert(userId: string, preferences: NotificationPreferences): ResultAsync<void, DomainError> {
      const values = {
        userId,
        globalEnabled: preferences.globalEnabled,
        messages: preferences.messages,
        runCompletion: preferences.runCompletion,
        membership: preferences.membership,
        quietHoursStartMinutes: preferences.quietHoursStartMinutes,
        quietHoursEndMinutes: preferences.quietHoursEndMinutes,
        timezone: preferences.timezone,
      };
      return fromPromise(
        db
          .insert(notificationPreferences)
          .values(values)
          .onConflictDoUpdate({
            target: notificationPreferences.userId,
            set: {
              globalEnabled: preferences.globalEnabled,
              messages: preferences.messages,
              runCompletion: preferences.runCompletion,
              membership: preferences.membership,
              quietHoursStartMinutes: preferences.quietHoursStartMinutes,
              quietHoursEndMinutes: preferences.quietHoursEndMinutes,
              timezone: preferences.timezone,
              updatedAt: new Date(),
            },
          }),
        (cause) => unavailableError('notification-preferences upsert failed', cause)
      ).map((): void => undefined);
    },
  };
}
