import { z } from 'zod';
import { createOpaqueServerFromEnv } from '@hushbox/crypto';
import { fromBase64, normalizeUsername } from '@hushbox/shared';
import { Result, fromPromise, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { redisDel, redisGet, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import { consumeRateLimit } from './rate-limit.js';
import { deserializeRegistrationRecord, deserializeRegistrationRequest } from './opaque.js';
import type { Redis } from '@upstash/redis';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUsersStore, InsertRegisteredOutcome } from '../ports/index.js';

export const registerInitBodySchema = z.object({
  email: z.email().max(254),
  username: z.string().min(1).max(20),
  registrationRequest: z.array(z.number()).min(1),
});

export const registerFinishBodySchema = z.object({
  email: z.email().max(254),
  registrationRecord: z.array(z.number()).min(1),
  accountPublicKey: z.string().min(1),
  passwordWrappedPrivateKey: z.string().min(1),
  recoveryWrappedPrivateKey: z.string().min(1),
  registerSessionId: z.uuid(),
});

export interface RegistrationStartArgs {
  readonly store: IdentityUsersStore;
  readonly redis: Redis;
  readonly masterSecret: string;
  readonly email: string;
  readonly username: string;
  readonly registrationRequest: number[];
  readonly now: number;
}

export type RegistrationStartOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | {
      readonly kind: 'started';
      readonly registrationResponse: number[];
      readonly registerSessionId: string;
    };

/**
 * Round one of OPAQUE registration. The request is processed identically
 * whether or not the email is already registered — the existing flag rides
 * along in the pending state so the finish round can answer the same
 * fake-success shape, preventing account enumeration.
 */
export function startRegistration(
  args: RegistrationStartArgs
): ResultAsync<RegistrationStartOutcome, DomainError> {
  const email = args.email.toLowerCase();
  return consumeRateLimit(args.redis, IDENTITY_KEYS.registerRateLimit, email, args.now).andThen(
    (decision) => {
      if (!decision.allowed) {
        return okAsync<RegistrationStartOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return deserializeRegistrationRequest(args.registrationRequest).asyncAndThen((request) =>
        args.store.findByEmail(email).andThen((existingUser) => {
          const userId = crypto.randomUUID();
          return fromPromise(
            (async () => {
              const server = await createOpaqueServerFromEnv(args.masterSecret);
              const response = await server.registerInit(request, userId);
              // The library reports a malformed-but-deserializable request as
              // an Error VALUE; that is client input, not a defect.
              if (response instanceof Error) throw response;
              return response;
            })(),
            (cause) => validationError('OPAQUE registerInit rejected the request', cause)
          ).andThen((response) => {
            const registerSessionId = crypto.randomUUID();
            return redisSet(
              args.redis,
              IDENTITY_KEYS.opaquePendingRegistration,
              {
                email,
                username: normalizeUsername(args.username),
                userId,
                ...(existingUser === null ? {} : { existing: true }),
              },
              registerSessionId
            ).map(
              (): RegistrationStartOutcome => ({
                kind: 'started',
                registrationResponse: response.serialize(),
                registerSessionId,
              })
            );
          });
        })
      );
    }
  );
}

export type ConsumePendingRegistrationOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'existing' }
  | {
      readonly kind: 'pending';
      readonly userId: string;
      readonly email: string;
      readonly username: string;
    };

/**
 * Resolves and CONSUMES the pending registration state — strictly
 * single-use: the delete happens before any effect, so a replayed finish
 * (or a crash-retry) finds nothing and restarts the handshake harmlessly
 * (the opaque-protocol idempotency exemption's contract).
 */
export function consumePendingRegistration(args: {
  readonly redis: Redis;
  readonly email: string;
  readonly registerSessionId: string;
}): ResultAsync<ConsumePendingRegistrationOutcome, DomainError> {
  return redisGet(
    args.redis,
    IDENTITY_KEYS.opaquePendingRegistration,
    args.registerSessionId
  ).andThen((pending) => {
    if (pending === null) {
      return okAsync<ConsumePendingRegistrationOutcome, DomainError>({ kind: 'no-pending' });
    }
    return redisDel(
      args.redis,
      IDENTITY_KEYS.opaquePendingRegistration,
      args.registerSessionId
    ).map((): ConsumePendingRegistrationOutcome => {
      // Defense-in-depth: a stolen handshake id must not complete a
      // registration for a different email.
      if (pending.email !== args.email.toLowerCase()) return { kind: 'no-pending' };
      if (pending.existing === true) return { kind: 'existing' };
      return {
        kind: 'pending',
        userId: pending.userId,
        email: pending.email,
        username: pending.username,
      };
    });
  });
}

function decodeBase64Field(value: string, field: string): Result<Uint8Array, DomainError> {
  return Result.fromThrowable(
    () => fromBase64(value),
    (cause) => validationError(`malformed base64 ${field}`, cause)
  )();
}

export interface CompleteRegistrationArgs {
  readonly store: IdentityUsersStore;
  readonly pending: { readonly userId: string; readonly email: string; readonly username: string };
  readonly registrationRecord: number[];
  readonly accountPublicKey: string;
  readonly passwordWrappedPrivateKey: string;
  readonly recoveryWrappedPrivateKey: string;
}

/**
 * The single user INSERT (the unique constraints arbitrate duplicates —
 * `idempotent.byUpsert` contract), preceded by pure input decoding.
 */
export function completeRegistration(
  args: CompleteRegistrationArgs
): ResultAsync<InsertRegisteredOutcome, DomainError> {
  return deserializeRegistrationRecord(args.registrationRecord)
    .andThen((record) =>
      Result.combine([
        decodeBase64Field(args.accountPublicKey, 'accountPublicKey'),
        decodeBase64Field(args.passwordWrappedPrivateKey, 'passwordWrappedPrivateKey'),
        decodeBase64Field(args.recoveryWrappedPrivateKey, 'recoveryWrappedPrivateKey'),
      ]).map(([publicKey, passwordWrappedPrivateKey, recoveryWrappedPrivateKey]) => ({
        record,
        publicKey,
        passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey,
      }))
    )
    .asyncAndThen((decoded) =>
      args.store.insertRegistered({
        id: args.pending.userId,
        email: args.pending.email,
        username: args.pending.username,
        opaqueRegistration: new Uint8Array(decoded.record.serialize()),
        publicKey: decoded.publicKey,
        passwordWrappedPrivateKey: decoded.passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey: decoded.recoveryWrappedPrivateKey,
      })
    );
}
