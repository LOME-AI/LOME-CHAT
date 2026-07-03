import { z } from 'zod';
import { createFakeRegistrationRecord, createOpaqueServerFromEnv } from '@hushbox/crypto';
import { normalizeUsername, textEncoder } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { redisDel, redisGetDel, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { consumeRateLimit } from './rate-limit.js';
import { issueSession } from './session.js';
import {
  deserializeExpectedAuthResult,
  deserializeKe1,
  deserializeKe3,
  deserializeRegistrationRecord,
  opaqueProtocolError,
  throwIfOpaqueError,
} from './opaque.js';
import type {
  OpaqueExpectedAuthResult,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueRegistrationRecord,
} from '@hushbox/crypto';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUserRecord, IdentityUsersStore } from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';

export const loginInitBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke1: z.array(z.number()).min(1),
});

export const loginFinishBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke3: z.array(z.number()).min(1),
  loginSessionId: z.uuid(),
});

/** The pending OPAQUE login handshake as stored in the Redis registry. */
export type PendingLogin = z.infer<(typeof IDENTITY_KEYS.opaquePendingLogin)['schema']>;

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
  readonly redis: RedisClient;
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
 *
 * The rate limit keys on the user id when one exists, else on the canonical
 * identifier. Keying a found user on user.id (rather than the submitted
 * identifier string) is deliberate: it unifies email and username into ONE
 * brute-force budget — the window's primary guarantee — and matches the
 * on-success reset below, which also keys on user.id. It admits a minor
 * linkage oracle: exhausting the window via one identifier form and then
 * hitting 429 via the other confirms both name the same account. Accepted —
 * closing it by keying on the submitted identifier would (a) multiply the
 * per-account guessing budget by the number of identifier forms and
 * (b) desynchronize the on-success reset, trading the core brute-force
 * guarantee for a lesser concern an attacker can only exploit once they
 * already hold both identifiers.
 */
export function startLogin(args: LoginStartArgs): ResultAsync<LoginStartOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return lookupByIdentifier(args.store, args.identifier, canonical).andThen((user) =>
    admitLoginAttempt(args, user, canonical)
  );
}

function admitLoginAttempt(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string
): ResultAsync<LoginStartOutcome, DomainError> {
  const rateLimitKey = user?.id ?? canonical;
  return consumeRateLimit(args.redis, IDENTITY_KEYS.loginRateLimit, rateLimitKey, args.now).andThen(
    (decision) =>
      decision.allowed
        ? beginLoginHandshake(args, user, canonical)
        : okAsync<LoginStartOutcome, DomainError>({
            kind: 'rate-limited',
            retryAfterSeconds: decision.retryAfterSeconds,
          })
  );
}

function beginLoginHandshake(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string
): ResultAsync<LoginStartOutcome, DomainError> {
  return deserializeKe1(args.ke1)
    .asyncAndThen((ke1) => runAuthInit(args, user, canonical, ke1))
    .andThen((initialized) => storePendingLogin(args.redis, user, canonical, initialized));
}

type OpaqueServerInstance = Awaited<ReturnType<typeof createOpaqueServerFromEnv>>;
/** `{ ke2, expected }` — the library exports no KE2 type, so derive it. */
type AuthInitResult = Exclude<Awaited<ReturnType<OpaqueServerInstance['authInit']>>, Error>;

/**
 * Deserializes the server-stored OPAQUE registration record. A failure here
 * is corruption in data the slice itself wrote — a DEFECT, resolved OUTSIDE
 * the protocol-error mapper below so its throw surfaces as a 500 to telemetry
 * (an invariant break), never the client-input validation channel. Routing it
 * to a 400 would both hide the corruption and make a corrupt account
 * distinguishable from a healthy one at login init. A malformed CLIENT-supplied
 * record stays a 400 through the codec's validation mapping.
 */
function deserializeStoredRegistrationRecord(user: IdentityUserRecord): OpaqueRegistrationRecord {
  const record = deserializeRegistrationRecord([...user.opaqueRegistration]);
  if (record.isErr()) {
    throw new Error('identity: stored OPAQUE registration record is corrupt', {
      cause: record.error,
    });
  }
  return record.value;
}

function runAuthInit(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string,
  ke1: OpaqueKE1
): ResultAsync<AuthInitResult, DomainError> {
  const storedRecord = user === null ? null : deserializeStoredRegistrationRecord(user);
  return fromPromise(
    (async (): Promise<AuthInitResult> => {
      const server = await createOpaqueServerFromEnv(args.masterSecret);
      let registrationRecord = storedRecord;
      if (registrationRecord === null) {
        const fake = await createFakeRegistrationRecord(textEncoder.encode(args.masterSecret));
        registrationRecord = fake.registrationRecord;
      }
      const credentialIdentifier = user?.id ?? canonical;
      return throwIfOpaqueError(
        await server.authInit(ke1, registrationRecord, credentialIdentifier)
      );
    })(),
    opaqueProtocolError('OPAQUE authInit rejected the request')
  );
}

function storePendingLogin(
  redis: RedisClient,
  user: IdentityUserRecord | null,
  canonical: string,
  initialized: AuthInitResult
): ResultAsync<LoginStartOutcome, DomainError> {
  const loginSessionId = crypto.randomUUID();
  return redisSet(
    redis,
    IDENTITY_KEYS.opaquePendingLogin,
    {
      identifier: canonical,
      userId: user?.id ?? null,
      expectedSerialized: initialized.expected.serialize(),
    },
    loginSessionId
  ).map(
    (): LoginStartOutcome => ({
      kind: 'started',
      ke2: initialized.ke2.serialize(),
      loginSessionId,
    })
  );
}

/**
 * Resolves and CONSUMES the pending login handshake in one atomic Redis
 * GETDEL — strictly single-use, success or failure. The read and delete are
 * a single operation, so two concurrent finish deliveries can never both
 * observe the handshake: exactly one wins the value and the other reads null
 * (restarting the handshake harmlessly). This is the `opaque-protocol` finish
 * route's atomic first-delivery claim on the handshake id — a GET-then-DEL
 * pair would let both deliveries win and mint two sessions from one
 * handshake.
 */
export function consumePendingLogin(args: {
  readonly redis: RedisClient;
  readonly loginSessionId: string;
}): ResultAsync<PendingLogin | null, DomainError> {
  return redisGetDel(args.redis, IDENTITY_KEYS.opaquePendingLogin, args.loginSessionId);
}

export interface LoginFinishArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly masterSecret: string;
  readonly identifier: string;
  readonly ke3: number[];
  /** The already-consumed pending handshake (see `consumePendingLogin`). */
  readonly pending: PendingLogin;
}

export type LoginFinishOutcome =
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'success'; readonly user: IdentityUserRecord };

function authFailed(): ResultAsync<LoginFinishOutcome, DomainError> {
  return okAsync<LoginFinishOutcome, DomainError>({ kind: 'auth-failed' });
}

/**
 * Round two of OPAQUE login, verifying an already-consumed pending state.
 * Every indistinguishable failure (mismatched identifier, malformed KE3,
 * MAC mismatch, fake-record path, vanished user) collapses onto
 * `auth-failed`, preserving the enumeration safety the init round
 * established. The locked check runs only after the password verified, so
 * lock state leaks to no one who doesn't hold the credentials.
 */
export function finishLogin(args: LoginFinishArgs): ResultAsync<LoginFinishOutcome, DomainError> {
  if (args.pending.identifier !== canonicalIdentifier(args.identifier)) return authFailed();
  const ke3 = deserializeKe3(args.ke3);
  if (ke3.isErr()) return authFailed();
  return deserializeExpectedAuthResult(args.pending.expectedSerialized).asyncAndThen((expected) =>
    verifyHandshake(args, ke3.value, expected)
  );
}

function verifyHandshake(
  args: LoginFinishArgs,
  ke3: OpaqueKE3,
  expected: OpaqueExpectedAuthResult
): ResultAsync<LoginFinishOutcome, DomainError> {
  return fromPromise(
    createOpaqueServerFromEnv(args.masterSecret),
    opaqueProtocolError('OPAQUE server construction failed')
  ).andThen((server) => {
    const verdict = server.authFinish(ke3, expected);
    if (verdict instanceof Error || args.pending.userId === null) return authFailed();
    return resolveVerifiedUser(args, args.pending.userId);
  });
}

function resolveVerifiedUser(
  args: LoginFinishArgs,
  userId: string
): ResultAsync<LoginFinishOutcome, DomainError> {
  return args.store.findById(userId).andThen((user) => {
    if (user === null) return authFailed();
    if (user.lockedAt !== null) {
      return okAsync<LoginFinishOutcome, DomainError>({ kind: 'locked' });
    }
    // Reset the limiter on success (legacy parity): the window is keyed on
    // the user id, which is what init used for a found user.
    return redisDel(args.redis, IDENTITY_KEYS.loginRateLimit, user.id).map(
      (): LoginFinishOutcome => ({ kind: 'success', user })
    );
  });
}

export type LoginRouteOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'locked' }
  | {
      readonly kind: 'logged-in';
      readonly user: IdentityUserRecord;
      readonly requires2FA: boolean;
    };

export interface LoginFinishFlowArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly masterSecret: string;
  readonly identifier: string;
  readonly ke3: number[];
  readonly loginSessionId: string;
  readonly request: Request;
  readonly response: Response;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly now: number;
}

/**
 * The login-finish `byEventId` composition (see `OpaqueFinishFlow`):
 * consuming the pending handshake is the first-delivery claim, and
 * verification — including minting the session on success — runs only on
 * the claimed state, so every failure mode flows through the one Result.
 */
export function createLoginFinishFlow(
  args: LoginFinishFlowArgs
): OpaqueFinishFlow<LoginRouteOutcome> {
  let pending: PendingLogin | null = null;
  return {
    claim: () =>
      consumePendingLogin({ redis: args.redis, loginSessionId: args.loginSessionId }).map(
        (state) => {
          pending = state;
          return state !== null;
        }
      ),
    execute: () => executeLoginFinish(args, pending),
    onDuplicate: () => okAsync<LoginRouteOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeLoginFinish(
  args: LoginFinishFlowArgs,
  pending: PendingLogin | null
): ResultAsync<LoginRouteOutcome, DomainError> {
  if (pending === null) {
    // `execute` runs only for the delivery that won the claim; a null
    // consume can never win it.
    throw new Error('identity: login finish executed without a claimed pending state');
  }
  return finishLogin({
    store: args.store,
    redis: args.redis,
    masterSecret: args.masterSecret,
    identifier: args.identifier,
    ke3: args.ke3,
    pending,
  }).andThen((outcome) =>
    outcome.kind === 'success'
      ? issueVerifiedSession(args, outcome.user)
      : okAsync<LoginRouteOutcome, DomainError>(outcome)
  );
}

/** A TOTP-enabled user gets a pending-2fa session; anyone else, full. */
function issueVerifiedSession(
  args: LoginFinishFlowArgs,
  user: IdentityUserRecord
): ResultAsync<LoginRouteOutcome, DomainError> {
  return issueSession({
    request: args.request,
    response: args.response,
    redis: args.redis,
    secret: args.secret,
    isProduction: args.isProduction,
    userId: user.id,
    kind: user.totpEnabled ? 'pending-2fa' : 'full',
    now: args.now,
  }).map((): LoginRouteOutcome => ({ kind: 'logged-in', user, requires2FA: user.totpEnabled }));
}
