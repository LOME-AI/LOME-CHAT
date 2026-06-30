import { z } from 'zod';
import { createFakeRegistrationRecord, createOpaqueServerFromEnv } from '@hushbox/crypto';
import { normalizeUsername, textEncoder } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { redisDel, redisGet, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { consumeRateLimit } from './rate-limit.js';
import {
  deserializeExpectedAuthResult,
  deserializeKe1,
  deserializeKe3,
  deserializeRegistrationRecord,
} from './opaque.js';
import type { OpaqueRegistrationRecord } from '@hushbox/crypto';
import type { Redis } from '@upstash/redis';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUserRecord, IdentityUsersStore } from '../ports/index.js';

export const loginInitBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke1: z.array(z.number()).min(1),
});

export const loginFinishBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke3: z.array(z.number()).min(1),
  loginSessionId: z.uuid(),
});

/**
 * Emails are stored lowercased; usernames are stored normalized. Both
 * rounds canonicalize identically, so the finish round's defense-in-depth
 * identifier comparison can never false-negative on case.
 */
export function canonicalIdentifier(identifier: string): string {
  return identifier.includes('@') ? identifier.toLowerCase() : normalizeUsername(identifier);
}

export interface LoginStartArgs {
  readonly store: IdentityUsersStore;
  readonly redis: Redis;
  readonly masterSecret: string;
  readonly identifier: string;
  readonly ke1: number[];
  readonly now: number;
}

export type LoginStartOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'started'; readonly ke2: number[]; readonly loginSessionId: string };

function lookupByIdentifier(
  store: IdentityUsersStore,
  identifier: string,
  canonical: string
): ResultAsync<IdentityUserRecord | null, DomainError> {
  return identifier.includes('@') ? store.findByEmail(canonical) : store.findByUsername(canonical);
}

/**
 * Round one of OPAQUE login. An unknown identifier takes the
 * fake-registration-record path: the response shape, status, and stored
 * pending state are identical to a real user's, so nothing distinguishes
 * "no such account" from "wrong password" — at this round or the next.
 * The rate limit keys on the user id when one exists (an attacker cannot
 * reset the window by alternating email/username forms), else on the
 * canonical identifier.
 */
export function startLogin(args: LoginStartArgs): ResultAsync<LoginStartOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return lookupByIdentifier(args.store, args.identifier, canonical).andThen((user) => {
    const rateLimitKey = user?.id ?? canonical;
    return consumeRateLimit(
      args.redis,
      IDENTITY_KEYS.loginRateLimit,
      rateLimitKey,
      args.now
    ).andThen((decision) => {
      if (!decision.allowed) {
        return okAsync<LoginStartOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return deserializeKe1(args.ke1).asyncAndThen((ke1) =>
        fromPromise(
          (async () => {
            const server = await createOpaqueServerFromEnv(args.masterSecret);
            let registrationRecord: OpaqueRegistrationRecord;
            if (user === null) {
              const fake = await createFakeRegistrationRecord(
                textEncoder.encode(args.masterSecret)
              );
              registrationRecord = fake.registrationRecord;
            } else {
              const record = deserializeRegistrationRecord([...user.opaqueRegistration]);
              if (record.isErr()) throw new Error('identity: stored OPAQUE record is corrupt');
              registrationRecord = record.value;
            }
            const credentialIdentifier = user?.id ?? canonical;
            const result = await server.authInit(ke1, registrationRecord, credentialIdentifier);
            // The library reports a malformed-but-deserializable KE1 as an
            // Error VALUE; that is client input, not a defect.
            if (result instanceof Error) throw result;
            return result;
          })(),
          (cause) => validationError('OPAQUE authInit rejected the request', cause)
        ).andThen(({ ke2, expected }) => {
          const loginSessionId = crypto.randomUUID();
          return redisSet(
            args.redis,
            IDENTITY_KEYS.opaquePendingLogin,
            {
              identifier: canonical,
              userId: user?.id ?? null,
              expectedSerialized: expected.serialize(),
            },
            loginSessionId
          ).map(
            (): LoginStartOutcome => ({
              kind: 'started',
              ke2: ke2.serialize(),
              loginSessionId,
            })
          );
        })
      );
    });
  });
}

export interface LoginFinishArgs {
  readonly store: IdentityUsersStore;
  readonly redis: Redis;
  readonly masterSecret: string;
  readonly identifier: string;
  readonly ke3: number[];
  readonly loginSessionId: string;
}

export type LoginFinishOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'success'; readonly user: IdentityUserRecord };

/**
 * Round two of OPAQUE login. The pending state is CONSUMED before the AKE
 * verification — strictly single-use, success or failure. Every
 * indistinguishable failure (mismatched identifier, malformed KE3, MAC
 * mismatch, fake-record path, vanished user) collapses onto `auth-failed`,
 * preserving the enumeration safety the init round established. The locked
 * check runs only after the password verified, so lock state leaks to no
 * one who doesn't hold the credentials.
 */
export function finishLogin(args: LoginFinishArgs): ResultAsync<LoginFinishOutcome, DomainError> {
  const authFailed = okAsync<LoginFinishOutcome, DomainError>({ kind: 'auth-failed' });
  return redisGet(args.redis, IDENTITY_KEYS.opaquePendingLogin, args.loginSessionId).andThen(
    (pending) => {
      if (pending === null) {
        return okAsync<LoginFinishOutcome, DomainError>({ kind: 'no-pending' });
      }
      return redisDel(args.redis, IDENTITY_KEYS.opaquePendingLogin, args.loginSessionId).andThen(
        () => {
          if (pending.identifier !== canonicalIdentifier(args.identifier)) return authFailed;
          const ke3 = deserializeKe3(args.ke3);
          if (ke3.isErr()) return authFailed;
          return deserializeExpectedAuthResult(pending.expectedSerialized).asyncAndThen(
            (expected) =>
              fromPromise(createOpaqueServerFromEnv(args.masterSecret), (cause) =>
                validationError('OPAQUE server construction failed', cause)
              ).andThen((server) => {
                const verdict = server.authFinish(ke3.value, expected);
                if (verdict instanceof Error || pending.userId === null) return authFailed;
                return args.store.findById(pending.userId).andThen((user) => {
                  if (user === null) return authFailed;
                  if (user.lockedAt !== null) {
                    return okAsync<LoginFinishOutcome, DomainError>({ kind: 'locked' });
                  }
                  // Reset the limiter on success (legacy parity): the window
                  // keyed on the user id, which is what init used for a
                  // found user.
                  return redisDel(args.redis, IDENTITY_KEYS.loginRateLimit, user.id).map(
                    (): LoginFinishOutcome => ({ kind: 'success', user })
                  );
                });
              })
          );
        }
      );
    }
  );
}
