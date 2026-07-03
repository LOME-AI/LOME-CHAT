import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { rewrapAccountKeyForPasswordChange } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { getRecoveryWrappedKey } from './recovery.js';
import type { IdentityUsersStore } from '../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

/** Every identifier is unknown: the store answers null for all lookups. */
const emptyStore = {
  findByEmail: () => okAsync(null),
  findByUsername: () => okAsync(null),
} as unknown as IdentityUsersStore;

/** Blob index of the final X25519 ephemeral-public-key byte (key spans 1..32). */
const EPHEMERAL_KEY_END_INDEX = 32;
const MSB = 0x80;

async function dummyFor(identifier: string): Promise<Uint8Array> {
  const outcome = await getRecoveryWrappedKey({
    redis,
    store: emptyStore,
    masterSecret: 'secret-at-least-32-characters-long!!',
    identifier,
    now: Date.now(),
  });
  const value = outcome._unsafeUnwrap();
  if (value.kind !== 'ok') throw new Error('expected an ok outcome');
  return fromBase64(value.recoveryWrappedPrivateKey);
}

describe('recovery dummy X25519 canonical key-space', () => {
  it('keeps the ephemeral-key top bit clear on every derived dummy', async () => {
    const run = crypto.randomUUID();
    const dummies = await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        dummyFor(`dummy-msb-${run}-${String(index)}@identity-domain.test`)
      )
    );
    const withTopBit = dummies.filter((blob) => ((blob[EPHEMERAL_KEY_END_INDEX] ?? 0) & MSB) !== 0);
    expect(withTopBit).toHaveLength(0);
  });

  it('matches the real wraps, whose canonical keys never set that bit', () => {
    const withTopBit = Array.from({ length: 64 }, () => {
      const privateKey = crypto.getRandomValues(new Uint8Array(32));
      const exportKey = crypto.getRandomValues(new Uint8Array(32));
      return rewrapAccountKeyForPasswordChange(privateKey, exportKey);
    }).filter((blob) => ((blob[EPHEMERAL_KEY_END_INDEX] ?? 0) & MSB) !== 0);
    expect(withTopBit).toHaveLength(0);
  });
});
