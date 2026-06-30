import { z } from 'zod';
import { devicePlatformEnum } from '@hushbox/db';
import { okAsync } from '../../../lib/result/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../lib/idempotency/index.js';
import type { DeviceTokenStore } from '../ports/index.js';

export const registerDeviceTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(devicePlatformEnum.enumValues),
});

export type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;

/**
 * One `INSERT … ON CONFLICT` through the store — the token unique constraint
 * arbitrates duplicates (`idempotent.byUpsert` at the route seam).
 */
export function registerDeviceToken(
  store: DeviceTokenStore,
  userId: string,
  input: RegisterDeviceTokenInput
): ResultAsync<void, DomainError> {
  return store.upsert({ userId, token: input.token, platform: input.platform });
}

/**
 * The `idempotent.byTransition` contract for unregistration: the conditional
 * DELETE either wins (`true`) or matched nothing (`null`), and zero rows
 * disambiguates to the already-deleted no-op (`false`) — repeating the call
 * converges on the same absent end-state.
 */
export function unregisterDeviceToken(
  store: DeviceTokenStore,
  userId: string,
  token: string
): ByTransitionParams<boolean, DomainError> {
  return {
    transition: () => store.deleteByToken(userId, token),
    onZeroRows: () => okAsync(false),
  };
}
