import { opaqueStepUpInit, opaqueStepUpFinish } from '@hushbox/crypto';
import { redisGet, redisSet, redisDel } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

/**
 * OPAQUE step-up Redis key names. Both entries share the same schema shape
 * ({ userId, expectedSerialized }), so the helper can persist and reload
 * pending state under any of them without branching on key identity.
 */
export type OpaqueStepUpKeyName =
  | 'opaquePendingChangePassword'
  | 'opaquePending2FADisable'
  | 'opaquePendingDeleteAccount';

interface StartArgs {
  ke1: Uint8Array;
  userId: string;
  opaqueRegistration: Uint8Array;
  username: string;
  masterSecret: Uint8Array;
  redis: Redis;
  redisKeyName: OpaqueStepUpKeyName;
}

interface FinishArgs {
  ke3: Uint8Array;
  userId: string;
  sessionId: string;
  redis: Redis;
  redisKeyName: OpaqueStepUpKeyName;
}

export type FinishResult =
  | { ok: true }
  | { ok: false; reason: 'no-pending' | 'bad-proof' | 'session-mismatch' };

/**
 * Persists a per-handshake session token. The token is the Redis key — the
 * stored `userId` moves into the value so the finish step can verify the
 * caller's session is bound to the same user. Concurrent step-ups for the
 * same user therefore can't clobber each other's `expected`.
 */
export async function startOpaqueStepUp(
  args: StartArgs
): Promise<{ ke2: Uint8Array; sessionId: string }> {
  const { ke2, expectedSerialized } = await opaqueStepUpInit({
    masterSecret: args.masterSecret,
    opaqueRegistration: args.opaqueRegistration,
    username: args.username,
    ke1: args.ke1,
  });

  const sessionId = crypto.randomUUID();
  await redisSet(
    args.redis,
    args.redisKeyName,
    { userId: args.userId, expectedSerialized },
    sessionId
  );

  return { ke2, sessionId };
}

/**
 * On bad-proof, the Redis entry is intentionally left in place so clients can
 * retry within the configured TTL. Only a successful proof clears it.
 *
 * `session-mismatch` indicates a stolen sessionId being used to step up a
 * different account — clears the entry and reports failure.
 */
export async function finishOpaqueStepUp(args: FinishArgs): Promise<FinishResult> {
  const pending = await redisGet(args.redis, args.redisKeyName, args.sessionId);
  if (!pending) {
    return { ok: false, reason: 'no-pending' };
  }

  if (pending.userId !== args.userId) {
    await redisDel(args.redis, args.redisKeyName, args.sessionId);
    return { ok: false, reason: 'session-mismatch' };
  }

  const result = opaqueStepUpFinish({
    ke3: args.ke3,
    expectedSerialized: pending.expectedSerialized,
  });

  if (!result.ok) {
    return result;
  }

  await redisDel(args.redis, args.redisKeyName, args.sessionId);
  return { ok: true };
}
