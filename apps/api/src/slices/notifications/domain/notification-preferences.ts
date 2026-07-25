import { z } from 'zod';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NotificationPreferences, NotificationPreferencesStore } from '../ports/index.js';

/** Whether a string is an IANA timezone the runtime can evaluate. */
function isValidTimeZone(timezone: string): boolean {
  try {
    // Intl throws a RangeError for an unrecognized zone (fail-fast at the seam).
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
    // eslint-disable-next-line catch-swallow/no-silent-catch -- the RangeError is the validation verdict (unknown zone), not a fault to surface
  } catch {
    return false;
  }
}

const MINUTES_IN_DAY = 24 * 60;

const quietHoursSchema = z.object({
  startMinutes: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1),
  endMinutes: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1),
  timezone: z.string().min(1).refine(isValidTimeZone, 'unknown IANA timezone'),
});

/**
 * The wire shape for reading and writing preferences. Quiet hours nest as one
 * object-or-null so the both-or-neither and timezone-required invariants are
 * structural (the DB CHECK re-enforces them server-authoritatively).
 */
export const putNotificationPreferencesBodySchema = z.strictObject({
  globalEnabled: z.boolean(),
  messages: z.boolean(),
  runCompletion: z.boolean(),
  membership: z.boolean(),
  quietHours: quietHoursSchema.nullable(),
});

/** The read/write view — identical shape both directions. */
export type NotificationPreferencesView = z.infer<typeof putNotificationPreferencesBodySchema>;

/** Projects the flat stored row onto the nested wire view. */
export function toPreferencesView(prefs: NotificationPreferences): NotificationPreferencesView {
  const quietHours =
    prefs.quietHoursStartMinutes === null ||
    prefs.quietHoursEndMinutes === null ||
    prefs.timezone === null
      ? null
      : {
          startMinutes: prefs.quietHoursStartMinutes,
          endMinutes: prefs.quietHoursEndMinutes,
          timezone: prefs.timezone,
        };
  return {
    globalEnabled: prefs.globalEnabled,
    messages: prefs.messages,
    runCompletion: prefs.runCompletion,
    membership: prefs.membership,
    quietHours,
  };
}

function fromBody(body: NotificationPreferencesView): NotificationPreferences {
  return {
    globalEnabled: body.globalEnabled,
    messages: body.messages,
    runCompletion: body.runCompletion,
    membership: body.membership,
    quietHoursStartMinutes: body.quietHours?.startMinutes ?? null,
    quietHoursEndMinutes: body.quietHours?.endMinutes ?? null,
    timezone: body.quietHours?.timezone ?? null,
  };
}

/** Reads the user's preferences, projecting a missing row to the defaults. */
export function getNotificationPreferences(
  store: Pick<NotificationPreferencesStore, 'read'>,
  userId: string
): ResultAsync<NotificationPreferencesView, DomainError> {
  return store
    .read(userId)
    .map((row) => toPreferencesView(row ?? DEFAULT_NOTIFICATION_PREFERENCES));
}

/**
 * Upserts the user's preferences (`idempotent.byUpsert` at the route) and
 * echoes the saved view back for the client to adopt.
 */
export function saveNotificationPreferences(
  store: Pick<NotificationPreferencesStore, 'upsert'>,
  userId: string,
  body: NotificationPreferencesView
): ResultAsync<NotificationPreferencesView, DomainError> {
  const preferences = fromBody(body);
  return store.upsert(userId, preferences).map(() => toPreferencesView(preferences));
}
