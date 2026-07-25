import { and, eq, inArray, or } from 'drizzle-orm';
import { deviceTokens } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  DeviceTokenRegistration,
  DeviceTokenStore,
  PushDeviceRef,
  PushRecipient,
} from '../ports/index.js';

/**
 * The `device_tokens` single-writer. Error messages never carry the token
 * value or a subscription endpoint — both are credentials. A `web` row stores
 * the Web Push endpoint in `token` and its keys in `p256dh`/`auth`; native
 * rows leave the key columns null (the DB CHECK binds key presence to `web`).
 */
export function createDeviceTokenStore(db: Database): DeviceTokenStore {
  return {
    upsert(registration: DeviceTokenRegistration): ResultAsync<void, DomainError> {
      const p256dh = registration.p256dh ?? null;
      const auth = registration.auth ?? null;
      return fromPromise(
        db
          .insert(deviceTokens)
          .values({
            userId: registration.userId,
            token: registration.token,
            platform: registration.platform,
            p256dh,
            auth,
          })
          .onConflictDoUpdate({
            target: deviceTokens.token,
            set: {
              userId: registration.userId,
              platform: registration.platform,
              p256dh,
              auth,
              updatedAt: new Date(),
              // Re-registration is proof of life: it must advance the
              // retention clock, or an app that re-registers on every launch
              // still ages out of `device_tokens`.
              lastSeenAt: new Date(),
            },
          }),
        (cause) => unavailableError('device-token upsert failed', cause)
      ).map((): void => undefined);
    },

    deleteByToken(userId: string, token: string): ResultAsync<true | null, DomainError> {
      return fromPromise(
        db
          .delete(deviceTokens)
          .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)))
          .returning({ id: deviceTokens.id }),
        (cause) => unavailableError('device-token delete failed', cause)
      ).map((rows) => (rows.length > 0 ? true : null));
    },

    listTokensForUsers(
      userIds: readonly string[]
    ): ResultAsync<readonly PushRecipient[], DomainError> {
      if (userIds.length === 0) {
        return okAsync([]);
      }
      return fromPromise(
        db
          .select({
            userId: deviceTokens.userId,
            token: deviceTokens.token,
            platform: deviceTokens.platform,
            p256dh: deviceTokens.p256dh,
            auth: deviceTokens.auth,
          })
          .from(deviceTokens)
          .where(inArray(deviceTokens.userId, [...userIds])),
        (cause) => unavailableError('device-token lookup failed', cause)
      ).map((rows) => rows.flatMap((row) => toRecipients(row)));
    },

    touchLastSeen(references: readonly PushDeviceRef[]): ResultAsync<void, DomainError> {
      if (references.length === 0) {
        return okAsync();
      }
      // Each ref is matched as a (userId, token) pair rather than by two
      // independent IN lists, so a target can never refresh a row it does not
      // own.
      const owned = references.map((reference) =>
        and(eq(deviceTokens.userId, reference.userId), eq(deviceTokens.token, reference.token))
      );
      return fromPromise(
        db
          .update(deviceTokens)
          .set({ lastSeenAt: new Date() })
          .where(or(...owned)),
        (cause) => unavailableError('device-token last-seen touch failed', cause)
      ).map((): void => undefined);
    },
  };
}

interface DeviceTokenRow {
  readonly userId: string;
  readonly token: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly p256dh: string | null;
  readonly auth: string | null;
}

/**
 * Widens a stored row into a platform-tagged push target. A `web` row's
 * `token` is its endpoint and its keys are non-null by the DB CHECK; a web row
 * missing a key is dropped rather than shipped as a malformed web target (a
 * subscription with no keys cannot be encrypted to).
 */
function toRecipients(row: DeviceTokenRow): readonly PushRecipient[] {
  if (row.platform === 'web') {
    if (row.p256dh === null || row.auth === null) {
      return [];
    }
    return [
      {
        platform: 'web',
        userId: row.userId,
        endpoint: row.token,
        p256dh: row.p256dh,
        auth: row.auth,
      },
    ];
  }
  return [{ platform: row.platform, userId: row.userId, token: row.token }];
}
