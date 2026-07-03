import { z } from 'zod';
import { createOpaqueServerFromEnv } from '@hushbox/crypto';
import { normalizeUsername } from '@hushbox/shared';
import { Result, fromPromise, okAsync } from '../../../lib/result/index.js';
import { redisGetDel, redisSet } from '../../../lib/redis/index.js';
import { decodeBase64Field } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { consumeRateLimit } from './rate-limit.js';
import {
  deserializeRegistrationRecord,
  deserializeRegistrationRequest,
  opaqueProtocolError,
  throwIfOpaqueError,
} from './opaque.js';
import type { OpaqueServerRegistrationRequest } from '@hushbox/crypto';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUsersStore, InsertRegisteredOutcome } from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';

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
  readonly redis: RedisClient;
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
    (decision) =>
      decision.allowed
        ? beginRegistrationHandshake(args, email)
        : okAsync<RegistrationStartOutcome, DomainError>({
            kind: 'rate-limited',
            retryAfterSeconds: decision.retryAfterSeconds,
          })
  );
}

function beginRegistrationHandshake(
  args: RegistrationStartArgs,
  email: string
): ResultAsync<RegistrationStartOutcome, DomainError> {
  return deserializeRegistrationRequest(args.registrationRequest)
    .asyncAndThen((request) => prepareRegistration(args, email, request))
    .andThen((prepared) => storePendingRegistration(args, email, prepared));
}

interface PreparedRegistration {
  readonly serializedResponse: number[];
  readonly existing: boolean;
  readonly userId: string;
}

function prepareRegistration(
  args: RegistrationStartArgs,
  email: string,
  request: OpaqueServerRegistrationRequest
): ResultAsync<PreparedRegistration, DomainError> {
  return args.store
    .findByEmail(email)
    .andThen((existingUser) => runRegisterInit(args, request, existingUser !== null));
}

function runRegisterInit(
  args: RegistrationStartArgs,
  request: OpaqueServerRegistrationRequest,
  existing: boolean
): ResultAsync<PreparedRegistration, DomainError> {
  const userId = crypto.randomUUID();
  return fromPromise(
    (async (): Promise<PreparedRegistration> => {
      const server = await createOpaqueServerFromEnv(args.masterSecret);
      const response = throwIfOpaqueError(await server.registerInit(request, userId));
      return { serializedResponse: response.serialize(), existing, userId };
    })(),
    opaqueProtocolError('OPAQUE registerInit rejected the request')
  );
}

function storePendingRegistration(
  args: RegistrationStartArgs,
  email: string,
  prepared: PreparedRegistration
): ResultAsync<RegistrationStartOutcome, DomainError> {
  const registerSessionId = crypto.randomUUID();
  return redisSet(
    args.redis,
    IDENTITY_KEYS.opaquePendingRegistration,
    {
      email,
      username: normalizeUsername(args.username),
      userId: prepared.userId,
      ...(prepared.existing ? { existing: true } : {}),
    },
    registerSessionId
  ).map(
    (): RegistrationStartOutcome => ({
      kind: 'started',
      registrationResponse: prepared.serializedResponse,
      registerSessionId,
    })
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
 * Resolves and CONSUMES the pending registration state in one atomic Redis
 * GETDEL — strictly single-use. The read and delete are a single operation,
 * so two concurrent finish deliveries (or a crash-retry) can never both
 * observe the state: exactly one wins it and the other reads null, taking the
 * no-pending path. This is the `opaque-protocol` finish route's atomic
 * first-delivery claim on the handshake id — a GET-then-DEL pair would let
 * both deliveries win and race the account INSERT.
 */
export function consumePendingRegistration(args: {
  readonly redis: RedisClient;
  readonly email: string;
  readonly registerSessionId: string;
}): ResultAsync<ConsumePendingRegistrationOutcome, DomainError> {
  return redisGetDel(
    args.redis,
    IDENTITY_KEYS.opaquePendingRegistration,
    args.registerSessionId
  ).map((pending): ConsumePendingRegistrationOutcome => {
    if (pending === null) return { kind: 'no-pending' };
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
 * The single user INSERT, preceded by pure input decoding. The finish route
 * composes this as the `idempotent.byEventId` execute; the email/username
 * unique constraints are the arbitration — a racing or duplicate insert
 * returns `email-taken` / `username-taken` rather than a second row.
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

export type RegisterFinishOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'existing' }
  | InsertRegisteredOutcome;

export interface RegisterFinishFlowArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly email: string;
  readonly registerSessionId: string;
  readonly registrationRecord: number[];
  readonly accountPublicKey: string;
  readonly passwordWrappedPrivateKey: string;
  readonly recoveryWrappedPrivateKey: string;
}

/**
 * The register-finish `byEventId` composition (see `OpaqueFinishFlow`):
 * consuming the pending handshake is the first-delivery claim — a replayed
 * finish finds nothing and takes the duplicate path.
 */
export function createRegisterFinishFlow(
  args: RegisterFinishFlowArgs
): OpaqueFinishFlow<RegisterFinishOutcome> {
  let consumed: ConsumePendingRegistrationOutcome = { kind: 'no-pending' };
  return {
    claim: () =>
      consumePendingRegistration({
        redis: args.redis,
        email: args.email,
        registerSessionId: args.registerSessionId,
      }).map((outcome) => {
        consumed = outcome;
        return outcome.kind !== 'no-pending';
      }),
    execute: () => executeRegisterFinish(args, consumed),
    onDuplicate: () => okAsync<RegisterFinishOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeRegisterFinish(
  args: RegisterFinishFlowArgs,
  consumed: ConsumePendingRegistrationOutcome
): ResultAsync<RegisterFinishOutcome, DomainError> {
  if (consumed.kind === 'no-pending') {
    // `execute` runs only for the delivery that won the claim; a
    // no-pending consume can never win it.
    throw new Error('identity: register finish executed without a claimed pending state');
  }
  if (consumed.kind === 'existing') {
    return okAsync<RegisterFinishOutcome, DomainError>({ kind: 'existing' });
  }
  return completeRegistration({
    store: args.store,
    pending: consumed,
    registrationRecord: args.registrationRecord,
    accountPublicKey: args.accountPublicKey,
    passwordWrappedPrivateKey: args.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: args.recoveryWrappedPrivateKey,
  });
}
