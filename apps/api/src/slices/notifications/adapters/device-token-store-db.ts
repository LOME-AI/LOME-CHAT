import { and, eq, inArray } from 'drizzle-orm';
import { deviceTokens } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DeviceTokenRegistration, DeviceTokenStore } from '../ports/index.js';

/**
 * The `device_tokens` single-writer. Error messages never carry the token
 * value — tokens are credentials.
 */
export function createDeviceTokenStore(db: Database): DeviceTokenStore {
  return {
    upsert(registration: DeviceTokenRegistration): ResultAsync<void, DomainError> {
      return fromPromise(
        db
          .insert(deviceTokens)
          .values({
            userId: registration.userId,
            token: registration.token,
            platform: registration.platform,
          })
          .onConflictDoUpdate({
            target: deviceTokens.token,
            set: {
              userId: registration.userId,
              platform: registration.platform,
              updatedAt: new Date(),
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

    listTokensForUsers(userIds: readonly string[]): ResultAsync<readonly string[], DomainError> {
      if (userIds.length === 0) {
        return okAsync([]);
      }
      return fromPromise(
        db
          .select({ token: deviceTokens.token })
          .from(deviceTokens)
          .where(inArray(deviceTokens.userId, [...userIds])),
        (cause) => unavailableError('device-token lookup failed', cause)
      ).map((rows) => rows.map((row) => row.token));
    },
  };
}
