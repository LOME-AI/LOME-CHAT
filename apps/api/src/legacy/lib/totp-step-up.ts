import {
  decryptAndVerifyTotp,
  verifyTotpToken,
  type DecryptAndVerifyTotpResult,
} from '@hushbox/crypto';
import { redisGet, redisSet } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

type CryptoFailureReason = Extract<DecryptAndVerifyTotpResult, { ok: false }>['reason'];

export type VerifyTotpStepUpResult =
  | { ok: true }
  | { ok: false; reason: CryptoFailureReason | 'replay' };

export type VerifyTotpSetupCodeResult =
  | { ok: true }
  | { ok: false; reason: Extract<CryptoFailureReason, 'invalid-code'> | 'replay' };

// Replay check runs BEFORE crypto verify to preserve the prior inline impl's
// timing profile. Reordering would change observable latency on the replay path.
async function verifyWithReplayProtection<R extends CryptoFailureReason>(args: {
  redis: Redis;
  userId: string;
  code: string;
  verify: () => Promise<{ ok: true } | { ok: false; reason: R }>;
}): Promise<{ ok: true } | { ok: false; reason: R | 'replay' }> {
  const alreadyUsed = await redisGet(args.redis, 'totpUsedCode', args.userId, args.code);
  if (alreadyUsed) {
    return { ok: false, reason: 'replay' };
  }

  const cryptoResult = await args.verify();
  if (!cryptoResult.ok) {
    return cryptoResult;
  }

  await redisSet(args.redis, 'totpUsedCode', '1', args.userId, args.code);
  return { ok: true };
}

/**
 * Step-up TOTP verification with replay protection — for routes that read
 * the user's already-confirmed encrypted secret from the DB (login 2FA,
 * 2FA disable). Use {@link verifyTotpSetupCode} for the initial enrollment
 * confirmation, which works against a plaintext pending secret.
 */
export async function verifyTotpStepUp(args: {
  redis: Redis;
  userId: string;
  masterSecret: Uint8Array;
  encryptedSecret: Uint8Array;
  code: string;
  now: Date;
  window?: number;
}): Promise<VerifyTotpStepUpResult> {
  return verifyWithReplayProtection({
    redis: args.redis,
    userId: args.userId,
    code: args.code,
    verify: () =>
      decryptAndVerifyTotp({
        masterSecret: args.masterSecret,
        encryptedSecret: args.encryptedSecret,
        code: args.code,
        now: args.now,
        ...(args.window !== undefined && { window: args.window }),
      }),
  });
}

/**
 * Setup-confirmation TOTP verification with replay protection — for the
 * one-shot enrollment route that holds the fresh secret as plaintext in
 * Redis pending state (not yet encrypted into the DB). Use
 * {@link verifyTotpStepUp} for any later step-up that reads the stored
 * encrypted secret.
 */
export async function verifyTotpSetupCode(args: {
  redis: Redis;
  userId: string;
  plaintextSecret: string;
  code: string;
  now: Date;
  window?: number;
}): Promise<VerifyTotpSetupCodeResult> {
  return verifyWithReplayProtection({
    redis: args.redis,
    userId: args.userId,
    code: args.code,
    verify: () =>
      verifyTotpToken({
        secret: args.plaintextSecret,
        code: args.code,
        now: args.now,
        ...(args.window !== undefined && { window: args.window }),
      }),
  });
}
