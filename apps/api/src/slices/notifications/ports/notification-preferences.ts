import type { NotificationCategory } from '@hushbox/shared';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * A user's account-level notification controls. A missing row means every
 * default (see `DEFAULT_NOTIFICATION_PREFERENCES`) — the store never backfills.
 * Quiet-hours fields are coherent by construction: start/end are both-or-
 * neither, and a window carries a timezone (enforced at the DB by CHECK and at
 * the write boundary by the route schema).
 */
export interface NotificationPreferences {
  readonly globalEnabled: boolean;
  readonly messages: boolean;
  readonly runCompletion: boolean;
  readonly membership: boolean;
  /** Local minute-of-day the quiet window opens; null (with end) = off. */
  readonly quietHoursStartMinutes: number | null;
  /** Local minute-of-day the quiet window closes (exclusive). */
  readonly quietHoursEndMinutes: number | null;
  /** IANA timezone the window is evaluated against; null = off. */
  readonly timezone: string | null;
}

/** The per-category toggle field a category maps to. */
export const CATEGORY_TOGGLE: Readonly<
  Record<NotificationCategory, 'messages' | 'runCompletion' | 'membership'>
> = {
  message: 'messages',
  runCompletion: 'runCompletion',
  membership: 'membership',
};

/** All controls on, no quiet hours — the lazy default for a user with no row. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  globalEnabled: true,
  messages: true,
  runCompletion: true,
  membership: true,
  quietHoursStartMinutes: null,
  quietHoursEndMinutes: null,
  timezone: null,
};

/**
 * Single-writer persistence seam for `notification_preferences`
 * (notifications-slice-owned). Reads are lazy — a missing row resolves to
 * `null` and the domain applies defaults.
 */
export interface NotificationPreferencesStore {
  read(userId: string): ResultAsync<NotificationPreferences | null, DomainError>;
  /** Batched read for a push fan-out; users with no row are simply absent. */
  readForUsers(
    userIds: readonly string[]
  ): ResultAsync<ReadonlyMap<string, NotificationPreferences>, DomainError>;
  /** One `INSERT … ON CONFLICT (user_id) DO UPDATE` (`idempotent.byUpsert`). */
  upsert(userId: string, preferences: NotificationPreferences): ResultAsync<void, DomainError>;
}
