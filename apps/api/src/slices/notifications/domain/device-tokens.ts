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
 * A browser Web Push subscription: the endpoint URL plus the two encryption
 * keys `PushManager.subscribe` returns. Stored as a `web` device-token row
 * (endpoint in `token`, keys in `p256dh`/`auth`).
 */
export const registerWebSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
});

export type RegisterWebSubscriptionInput = z.infer<typeof registerWebSubscriptionSchema>;

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
 * Registers a browser Web Push subscription for the owning user as a `web`
 * device-token row, keyed by its endpoint (the token unique constraint is the
 * `idempotent.byUpsert` guard — re-subscribing converges on one row).
 */
export function registerWebSubscription(
  store: DeviceTokenStore,
  userId: string,
  input: RegisterWebSubscriptionInput
): ResultAsync<void, DomainError> {
  return store.upsert({
    userId,
    token: input.endpoint,
    platform: 'web',
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
  });
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
