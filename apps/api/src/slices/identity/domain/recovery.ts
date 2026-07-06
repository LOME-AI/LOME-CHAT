import { z } from 'zod';
import { rewrapAccountKeyForPasswordChange } from '@hushbox/crypto';
import { textEncoder, toBase64 } from '@hushbox/shared';
import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { redisGetDel, redisSet } from '../../../lib/redis/index.js';
import { rotatePasswordCredentials } from './credentials.js';
import { IDENTITY_KEYS } from './keys.js';
import { canonicalIdentifier } from './login.js';
import { reserveAttempt } from './lockout.js';
import { deserializeRegistrationRequest, runNewPasswordRegisterInit } from './opaque.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  IdentityUserRecord,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';

export const recoveryGetKeyBodySchema = z.object({
  identifier: z.string().min(1).max(254),
});

export const recoveryResetInitBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRequest: z.array(z.number()).min(1),
});

export const recoveryResetFinishBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRecord: z.array(z.number()).min(1),
  newPasswordWrappedPrivateKey: z.string().min(1),
  recoverySessionId: z.uuid(),
});

/**
 * A real stored recovery blob is an ECIES wrap of the 32-byte X25519 account
 * private key: one fixed version byte, then wrap-specific bytes (ephemeral
 * public key + ciphertext + tag). This reference wrap measures both facts —
 * total length and the version byte — against the crypto package itself, so
 * a blob-format change can never reopen the gap.
 */
const REFERENCE_WRAPPED_KEY = rewrapAccountKeyForPasswordChange(
  new Uint8Array(32),
  new Uint8Array(32)
);

const DUMMY_INFO_TAG = 'hushbox/recovery-dummy-wrapped-key/v1';

/**
 * Deterministic per-identifier dummy for unknown accounts on the public
 * wrapped-key endpoint. Every distinguisher an attacker could read off the
 * response must match a real account's blob: same length, same leading
 * version byte, a body that looks like ciphertext (never a recognizable
 * constant such as all-zeros), and stability across repeated queries (a real
 * account answers the same blob every time, so a per-query random dummy
 * would leak too). HKDF-SHA-256 over the OPAQUE server secret, domain-
 * separated by the info tag and bound to the canonical identifier, gives all
 * four at once — indistinguishable from ciphertext without the server
 * secret. X25519 accepts any 32 bytes, so HKDF output is valid for the
 * key-shaped region — with one canonical-encoding correction: a real
 * ephemeral public key is a little-endian u-coordinate below 2^255−19, so
 * the top bit of its final byte (blob index 32) is ALWAYS clear, while
 * uniform HKDF output would set it half the time — a certainty-grade
 * non-existence oracle. The mask keeps the dummy inside the real key-space
 * (the residual non-canonical range above the prime is ~19/2^255 —
 * negligible).
 */
function dummyWrappedKey(masterSecret: string, canonicalId: string): Promise<Uint8Array> {
  return (async (): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(masterSecret),
      'HKDF',
      false,
      ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: textEncoder.encode(`${DUMMY_INFO_TAG}:${canonicalId}`),
      },
      key,
      (REFERENCE_WRAPPED_KEY.length - 1) * 8
    );
    // Body index 31 is blob index 32 — the final ephemeral-key byte.
    const body = new Uint8Array(bits).map((byte, index) => (index === 31 ? byte & 0x7f : byte));
    const blob = new Uint8Array(REFERENCE_WRAPPED_KEY.length);
    blob.set(REFERENCE_WRAPPED_KEY.subarray(0, 1), 0);
    blob.set(body, 1);
    return blob;
  })();
}

function lookup(
  store: IdentityUsersStore,
  identifier: string
): ResultAsync<IdentityUserRecord | null, DomainError> {
  const canonical = canonicalIdentifier(identifier);
  return identifier.includes('@') ? store.findByEmail(canonical) : store.findByUsername(canonical);
}

export interface RecoveryGetKeyArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly identifier: string;
}

export type RecoveryGetKeyOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'ok'; readonly recoveryWrappedPrivateKey: string };

/**
 * Enumeration-safe wrapped-key retrieval: a known account returns its stored
 * recovery-wrapped key; an unknown one returns a fixed-length dummy of the
 * same response shape, so neither the status nor the body distinguishes the
 * two. The recovery phrase never reaches the server — the client rewraps
 * locally with the returned blob.
 *
 * The returned blob is offline-attackable ciphertext, so retrieval is a
 * secret-guessing surface: the attempt is reserved with an atomic increment
 * BEFORE the lookup, admitting at most the cap per window even under
 * concurrency. The lockout wraps OUTSIDE the enumeration-safe body — known
 * and unknown identifiers share one code path from here down, so the limiter
 * adds no distinguisher.
 */
export function getRecoveryWrappedKey(
  args: RecoveryGetKeyArgs
): ResultAsync<RecoveryGetKeyOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return reserveAttempt(args.redis, IDENTITY_KEYS.recoveryGetKeyLockout, canonical).andThen(
    (decision) => {
      if (decision.lockedOut) {
        return okAsync<RecoveryGetKeyOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return lookup(args.store, args.identifier).andThen((user) => {
        const bytes =
          user === null
            ? ResultAsync.fromSafePromise<Uint8Array, DomainError>(
                dummyWrappedKey(args.masterSecret, canonical)
              )
            : okAsync<Uint8Array, DomainError>(user.recoveryWrappedPrivateKey);
        return bytes.map(
          (blob): RecoveryGetKeyOutcome => ({
            kind: 'ok',
            recoveryWrappedPrivateKey: toBase64(blob),
          })
        );
      });
    }
  );
}

export interface RecoveryResetInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly identifier: string;
  readonly newRegistrationRequest: number[];
}

export type RecoveryResetInitOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | {
      readonly kind: 'started';
      readonly newRegistrationResponse: number[];
      readonly recoverySessionId: string;
    };

/**
 * Round one of a recovery reset: attempt-reservation lockout (the atomic
 * increment gates BEFORE anything runs — a secret-guessing surface), then a
 * new-password registerInit against the account's id when known, or a
 * throwaway id when not — the response shape and stored pending state are
 * identical either way, so nothing distinguishes a real identifier from an
 * unknown one.
 */
export function startRecoveryReset(
  args: RecoveryResetInitArgs
): ResultAsync<RecoveryResetInitOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return reserveAttempt(args.redis, IDENTITY_KEYS.recoveryResetLockout, canonical).andThen(
    (decision) => {
      if (decision.lockedOut) {
        return okAsync<RecoveryResetInitOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return lookup(args.store, args.identifier).andThen((user) =>
        beginReset(args, user?.id ?? crypto.randomUUID(), canonical)
      );
    }
  );
}

function beginReset(
  args: RecoveryResetInitArgs,
  credentialIdentifier: string,
  canonical: string
): ResultAsync<RecoveryResetInitOutcome, DomainError> {
  return deserializeRegistrationRequest(args.newRegistrationRequest)
    .asyncAndThen((request) =>
      runNewPasswordRegisterInit(args.masterSecret, credentialIdentifier, request)
    )
    .andThen((newRegistrationResponse) => {
      const recoverySessionId = crypto.randomUUID();
      return redisSet(
        args.redis,
        IDENTITY_KEYS.opaquePendingRecoveryReset,
        { identifier: canonical },
        recoverySessionId
      ).map(
        (): RecoveryResetInitOutcome => ({
          kind: 'started',
          newRegistrationResponse,
          recoverySessionId,
        })
      );
    });
}

export interface RecoveryResetFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly emailPort: PasswordChangedEmailPort;
  readonly logger: Telemetry;
  readonly identifier: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly recoverySessionId: string;
  readonly now: number;
}

export type RecoveryResetOutcome = { readonly kind: 'no-pending' } | { readonly kind: 'reset' };

/**
 * Round two: consuming the pending handshake (atomic GETDEL) is the
 * first-delivery claim. A mismatched identifier or a vanished account both
 * collapse onto `no-pending`, so a replay or a stolen handshake id reveals
 * nothing. On success the OPAQUE record + wrapped key are rotated and the
 * pw-changed watermark stales every prior session.
 */
export function createRecoveryResetFinishFlow(
  args: RecoveryResetFinishArgs
): OpaqueFinishFlow<RecoveryResetOutcome> {
  let pending: { identifier: string } | null = null;
  return {
    claim: () =>
      redisGetDel(args.redis, IDENTITY_KEYS.opaquePendingRecoveryReset, args.recoverySessionId).map(
        (state) => {
          pending = state;
          return state !== null;
        }
      ),
    execute: () => executeReset(args, pending),
    onDuplicate: () => okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeReset(
  args: RecoveryResetFinishArgs,
  pending: { identifier: string } | null
): ResultAsync<RecoveryResetOutcome, DomainError> {
  if (pending === null) {
    throw new Error('identity: recovery reset executed without a claimed handshake');
  }
  if (pending.identifier !== canonicalIdentifier(args.identifier)) {
    return okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' });
  }
  return lookup(args.store, args.identifier).andThen((user) => {
    if (user === null) return okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' });
    return rotatePasswordCredentials({ ...args, userId: user.id }).map(
      (): RecoveryResetOutcome => ({ kind: 'reset' })
    );
  });
}
