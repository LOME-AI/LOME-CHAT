import type { Variables } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The per-request Redis client as the pipeline types it — named here so port
 * factory signatures never import the infra module (only adapters may).
 */
export type RedisClient = Variables['redis'];

/** Pending OPAQUE registration handshake, keyed by a server-issued id. */
export interface PendingRegistrationState {
  readonly email: string;
  readonly username: string;
  readonly userId: string;
  /** Set when the email is already registered — the finish round answers the
   * enumeration-safe fake-success shape instead of inserting. */
  readonly existing?: boolean;
}

/** Pending OPAQUE login handshake, keyed by a server-issued id. */
export interface PendingLoginState {
  readonly identifier: string;
  /** Null on the fake-registration-record (unknown identifier) path. */
  readonly userId: string | null;
  readonly expectedSerialized: number[];
}

export type RateLimitKind = 'login' | 'register';

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * Ephemeral auth coordination state (Redis-backed). `consume*` operations are
 * single-use by contract: resolve-and-delete, so a replayed handshake finds
 * nothing — the dedup the opaque-protocol idempotency exemption relies on.
 */
export interface AuthStateStore {
  savePendingRegistration(
    handshakeId: string,
    state: PendingRegistrationState
  ): ResultAsync<void, DomainError>;
  consumePendingRegistration(
    handshakeId: string
  ): ResultAsync<PendingRegistrationState | null, DomainError>;
  savePendingLogin(handshakeId: string, state: PendingLoginState): ResultAsync<void, DomainError>;
  consumePendingLogin(handshakeId: string): ResultAsync<PendingLoginState | null, DomainError>;
  consumeRateLimit(
    kind: RateLimitKind,
    identifier: string,
    now: number
  ): ResultAsync<RateLimitDecision, DomainError>;
  clearRateLimit(kind: RateLimitKind, identifier: string): ResultAsync<void, DomainError>;
}

/** Constructed per request from the pipeline's `c.var.redis`. */
export type AuthStateStoreFactory = (redis: RedisClient) => AuthStateStore;
