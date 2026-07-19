import type { deviceTokens } from '@hushbox/db';
import type { PushRecipient } from './push-sender.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

export type DevicePlatform = (typeof deviceTokens.$inferInsert)['platform'];

export interface DeviceTokenRegistration {
  readonly userId: string;
  readonly token: string;
  readonly platform: DevicePlatform;
}

/**
 * Single-writer persistence seam for `device_tokens`. The store lives behind
 * a port (unlike the models slice's in-domain queries) because its queries
 * need drizzle-orm operators, which only adapters may import.
 */
export interface DeviceTokenStore {
  /**
   * One `INSERT … ON CONFLICT (token) DO UPDATE` — the token unique
   * constraint is the idempotency guard (`idempotent.byUpsert` contract).
   * A re-registered token moves to the new owner (device handed off).
   */
  upsert(registration: DeviceTokenRegistration): ResultAsync<void, DomainError>;
  /**
   * One conditional DELETE scoped to the owning user; resolves `true` when a
   * row was deleted, `null` on 0 rows (`idempotent.byTransition` contract —
   * already-absent is the caller's no-op disambiguation).
   */
  deleteByToken(userId: string, token: string): ResultAsync<true | null, DomainError>;
  /**
   * All registered tokens for the given users, each paired with its owner
   * (push fan-out input). The userId rides along so a dead token can be
   * pruned with the user-scoped `deleteByToken`.
   */
  listTokensForUsers(
    userIds: readonly string[]
  ): ResultAsync<readonly PushRecipient[], DomainError>;
}
