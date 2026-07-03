import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpCodeSync,
  generateTotpSecret,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { verifyStoredTotp } from './totp.js';
import type { VerifyStoredTotpArgs } from './totp.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const MASTER_SECRET = 'secret-at-least-32-characters-long!!';

function verifyArgs(): VerifyStoredTotpArgs & { readonly code: string } {
  const secret = generateTotpSecret();
  const encryptedSecret = encryptTotpSecret(
    secret,
    deriveTotpEncryptionKey(textEncoder.encode(MASTER_SECRET))
  );
  return {
    redis,
    encryptedSecret,
    masterSecret: MASTER_SECRET,
    userId: `totp-race-${crypto.randomUUID()}`,
    code: generateTotpCodeSync(secret),
    now: new Date(),
  };
}

describe('verifyStoredTotp single-use replay claim', () => {
  it('accepts exactly one of two concurrent submissions of the same valid code', async () => {
    const args = verifyArgs();
    const [first, second] = await Promise.all([verifyStoredTotp(args), verifyStoredTotp(args)]);
    const kinds = [first._unsafeUnwrap().kind, second._unsafeUnwrap().kind].toSorted((a, b) =>
      a.localeCompare(b)
    );
    expect(kinds).toEqual(['invalid', 'ok']);
  });

  it('rejects a sequential replay of an accepted code as invalid', async () => {
    const args = verifyArgs();
    const first = await verifyStoredTotp(args);
    expect(first._unsafeUnwrap().kind).toBe('ok');
    const replay = await verifyStoredTotp(args);
    expect(replay._unsafeUnwrap().kind).toBe('invalid');
  });
});
