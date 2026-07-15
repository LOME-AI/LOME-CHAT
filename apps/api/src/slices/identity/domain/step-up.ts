import { opaqueStepUpFinish, opaqueStepUpInit } from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { redisGetDel, redisSet } from '../../../lib/redis/index.js';
import { opaqueProtocolError } from './opaque.js';
import type { z } from 'zod';
import type { RedisKeyDefinition } from '../../../lib/redis/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient, stepUpPendingSchema } from './keys.js';

/** Any of the three step-up handshake registry entries (all share one shape). */
export type StepUpKeyDefinition = RedisKeyDefinition<typeof stepUpPendingSchema, [string]>;
export type StepUpPending = z.infer<typeof stepUpPendingSchema>;

export interface StartStepUpArgs {
  readonly redis: RedisClient;
  readonly definition: StepUpKeyDefinition;
  readonly ke1: number[];
  readonly userId: string;
  readonly opaqueRegistration: Uint8Array;
  /** The fail-fast-validated OPAQUE master secret. */
  readonly masterSecret: string;
}

export interface StartStepUpOutcome {
  readonly ke2: number[];
  readonly stepUpSessionId: string;
}

/**
 * Round one of an OPAQUE step-up: re-runs the AKE init against the caller's
 * own stored registration record (they are already authenticated), mints a
 * server-side handshake id, and stashes the `expected` result under it. The
 * userId rides in the stored value so the finish round can reject a stolen
 * handshake id bound to another account.
 */
export function startStepUp(args: StartStepUpArgs): ResultAsync<StartStepUpOutcome, DomainError> {
  return fromPromise(
    opaqueStepUpInit({
      masterSecret: textEncoder.encode(args.masterSecret),
      opaqueRegistration: args.opaqueRegistration,
      username: args.userId,
      ke1: new Uint8Array(args.ke1),
    }),
    opaqueProtocolError('OPAQUE step-up authInit rejected the request')
  ).andThen((init) => {
    const stepUpSessionId = crypto.randomUUID();
    return redisSet(
      args.redis,
      args.definition,
      { userId: args.userId, expectedSerialized: init.expectedSerialized },
      stepUpSessionId
    ).map((): StartStepUpOutcome => ({ ke2: [...init.ke2], stepUpSessionId }));
  });
}

/**
 * Resolves and CONSUMES the step-up handshake in one atomic Redis GETDEL —
 * strictly single-use, success or failure. A replayed or racing finish reads
 * null and takes the no-step-up path; a fresh re-auth requires a fresh init.
 */
export function consumeStepUp(
  redis: RedisClient,
  definition: StepUpKeyDefinition,
  stepUpSessionId: string
): ResultAsync<StepUpPending | null, DomainError> {
  return redisGetDel(redis, definition, stepUpSessionId);
}

export type StepUpVerdict = 'ok' | 'bad-proof' | 'session-mismatch';

/**
 * Verifies a consumed step-up handshake against the caller's session user and
 * their KE3. A handshake bound to another account is `session-mismatch`; a
 * malformed KE3 or a failed 3DH MAC is `bad-proof` — the two indistinguishable
 * failure modes never leak which account a stolen handshake id belonged to.
 */
export function verifyStepUp(pending: StepUpPending, userId: string, ke3: number[]): StepUpVerdict {
  if (pending.userId !== userId) return 'session-mismatch';
  try {
    const result = opaqueStepUpFinish({
      ke3: new Uint8Array(ke3),
      expectedSerialized: pending.expectedSerialized,
    });
    return result.ok ? 'ok' : 'bad-proof';
    // eslint-disable-next-line catch-swallow/no-silent-catch -- malformed KE3 becomes bad-proof (rejection verdict); indistinguishable from a wrong password.
  } catch {
    // A malformed KE3 throws in deserialization; collapse it onto bad-proof so
    // junk bytes are indistinguishable from a wrong password.
    return 'bad-proof';
  }
}

export type StepUpFinishOutcome<T> =
  // no-pending and session-mismatch collapse together: a stolen handshake id
  // is indistinguishable from a replayed or expired one.
  | { readonly kind: 'no-step-up' }
  | { readonly kind: 'bad-proof' }
  | { readonly kind: 'verified'; readonly value: T };

export interface StepUpFinishFlowArgs<T> {
  readonly redis: RedisClient;
  readonly definition: StepUpKeyDefinition;
  readonly userId: string;
  readonly stepUpSessionId: string;
  readonly ke3: number[];
  /** Runs only after a verified re-auth; carries the feature-specific result. */
  readonly onVerified: () => ResultAsync<T, DomainError>;
}

/**
 * The step-up finish `byEventId` composition shared by every sensitive
 * authenticated op: consuming the handshake is the first-delivery claim, and
 * verification (including the feature effect in `onVerified`) runs only on the
 * claimed state.
 */
export function createStepUpFinishFlow<T>(
  args: StepUpFinishFlowArgs<T>
): OpaqueFinishFlow<StepUpFinishOutcome<T>> {
  let pending: StepUpPending | null = null;
  return {
    claim: () =>
      consumeStepUp(args.redis, args.definition, args.stepUpSessionId).map((state) => {
        pending = state;
        return state !== null;
      }),
    execute: () => executeStepUpFinish(args, pending),
    onDuplicate: () => okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'no-step-up' }),
  };
}

function executeStepUpFinish<T>(
  args: StepUpFinishFlowArgs<T>,
  pending: StepUpPending | null
): ResultAsync<StepUpFinishOutcome<T>, DomainError> {
  if (pending === null) {
    // `execute` runs only for the delivery that won the claim; a null consume
    // can never win it.
    throw new Error('identity: step-up finish executed without a claimed handshake');
  }
  const verdict = verifyStepUp(pending, args.userId, args.ke3);
  if (verdict === 'session-mismatch') {
    return okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'no-step-up' });
  }
  if (verdict === 'bad-proof') {
    return okAsync<StepUpFinishOutcome<T>, DomainError>({ kind: 'bad-proof' });
  }
  return args.onVerified().map((value): StepUpFinishOutcome<T> => ({ kind: 'verified', value }));
}
