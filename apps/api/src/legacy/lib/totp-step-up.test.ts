import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpSecret,
  generateTotpCodeSync,
} from '@hushbox/crypto';
import { verifyTotpStepUp, verifyTotpSetupCode } from './totp-step-up.js';
import { REDIS_REGISTRY } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

const TEST_MASTER_SECRET = new Uint8Array(32).fill(7);
const TEST_USER_ID = '00000000-0000-0000-0000-000000000099';

function createMockRedis(): Redis & {
  store: Map<string, unknown>;
  ttls: Map<string, number>;
} {
  const store = new Map<string, unknown>();
  const ttls = new Map<string, number>();
  return {
    set: vi.fn().mockImplementation((key: string, value: unknown, options?: { ex?: number }) => {
      store.set(key, value);
      if (options?.ex !== undefined) ttls.set(key, options.ex);
      return Promise.resolve('OK');
    }),
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    del: vi.fn().mockImplementation((key: string) => {
      const had = store.delete(key);
      ttls.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),
    store,
    ttls,
  } as unknown as Redis & { store: Map<string, unknown>; ttls: Map<string, number> };
}

describe('verifyTotpStepUp', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns { ok: true } and stores replay marker under totpUsedCode key with registry TTL on first valid use', async () => {
    const secret = generateTotpSecret();
    const key = deriveTotpEncryptionKey(TEST_MASTER_SECRET);
    const encryptedSecret = encryptTotpSecret(secret, key);
    const code = generateTotpCodeSync(secret);

    const result = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret,
      code,
      now: new Date(),
    });

    expect(result).toEqual({ ok: true });
    const replayKey = `totp:used:${TEST_USER_ID}:${code}`;
    expect(mockRedis.store.has(replayKey)).toBe(true);
    expect(mockRedis.ttls.get(replayKey)).toBe(REDIS_REGISTRY.totpUsedCode.ttl);
  });

  it('returns { ok: false, reason: "replay" } when the replay marker is already present', async () => {
    const secret = generateTotpSecret();
    const key = deriveTotpEncryptionKey(TEST_MASTER_SECRET);
    const encryptedSecret = encryptTotpSecret(secret, key);
    const code = generateTotpCodeSync(secret);

    mockRedis.store.set(`totp:used:${TEST_USER_ID}:${code}`, '1');

    const result = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret,
      code,
      now: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'replay' });
  });

  it('returns { ok: false, reason: "invalid-code" } and does NOT write a Redis marker on bad code', async () => {
    const secret = generateTotpSecret();
    const key = deriveTotpEncryptionKey(TEST_MASTER_SECRET);
    const encryptedSecret = encryptTotpSecret(secret, key);

    const result = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret,
      code: '000000',
      now: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-code' });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('forwards an explicit window override to the crypto layer', async () => {
    const secret = generateTotpSecret();
    const key = deriveTotpEncryptionKey(TEST_MASTER_SECRET);
    const encryptedSecret = encryptTotpSecret(secret, key);
    const codeNow = generateTotpCodeSync(secret);
    // Code is generated at time T. A `now` 90 seconds later puts the code
    // three steps in the past, which the default 1-step window rejects.
    // Passing window: 3 accepts it, proving the override reaches the crypto
    // layer.
    const ninetySecondsLater = new Date(Date.now() + 90_000);

    const defaultWindow = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret,
      code: codeNow,
      now: ninetySecondsLater,
    });
    expect(defaultWindow).toEqual({ ok: false, reason: 'invalid-code' });

    const widerWindow = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret,
      code: codeNow,
      now: ninetySecondsLater,
      window: 3,
    });
    expect(widerWindow).toEqual({ ok: true });
  });

  it('returns { ok: false, reason: "decrypt-failed" } and does NOT write a Redis marker on corrupted ciphertext', async () => {
    const secret = generateTotpSecret();
    const key = deriveTotpEncryptionKey(TEST_MASTER_SECRET);
    const encryptedSecret = encryptTotpSecret(secret, key);
    const corrupted = new Uint8Array(encryptedSecret);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0x01;
    const code = generateTotpCodeSync(secret);

    const result = await verifyTotpStepUp({
      redis: mockRedis,
      userId: TEST_USER_ID,
      masterSecret: TEST_MASTER_SECRET,
      encryptedSecret: corrupted,
      code,
      now: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'decrypt-failed' });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

describe('verifyTotpSetupCode', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns { ok: true } and stores replay marker under totpUsedCode key with registry TTL on first valid use', async () => {
    const secret = generateTotpSecret();
    const code = generateTotpCodeSync(secret);

    const result = await verifyTotpSetupCode({
      redis: mockRedis,
      userId: TEST_USER_ID,
      plaintextSecret: secret,
      code,
      now: new Date(),
    });

    expect(result).toEqual({ ok: true });
    const replayKey = `totp:used:${TEST_USER_ID}:${code}`;
    expect(mockRedis.store.has(replayKey)).toBe(true);
    expect(mockRedis.ttls.get(replayKey)).toBe(REDIS_REGISTRY.totpUsedCode.ttl);
  });

  it('returns { ok: false, reason: "replay" } when the replay marker is already present and does not invoke the crypto layer', async () => {
    const secret = generateTotpSecret();
    const code = generateTotpCodeSync(secret);

    mockRedis.store.set(`totp:used:${TEST_USER_ID}:${code}`, '1');

    const result = await verifyTotpSetupCode({
      redis: mockRedis,
      userId: TEST_USER_ID,
      plaintextSecret: secret,
      code,
      now: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'replay' });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('returns { ok: false, reason: "invalid-code" } and does NOT write a Redis marker on bad code', async () => {
    const secret = generateTotpSecret();

    const result = await verifyTotpSetupCode({
      redis: mockRedis,
      userId: TEST_USER_ID,
      plaintextSecret: secret,
      code: '000000',
      now: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'invalid-code' });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('forwards an explicit window override to the crypto layer', async () => {
    const secret = generateTotpSecret();
    const codeNow = generateTotpCodeSync(secret);
    const ninetySecondsLater = new Date(Date.now() + 90_000);

    const defaultWindow = await verifyTotpSetupCode({
      redis: mockRedis,
      userId: TEST_USER_ID,
      plaintextSecret: secret,
      code: codeNow,
      now: ninetySecondsLater,
    });
    expect(defaultWindow).toEqual({ ok: false, reason: 'invalid-code' });

    const widerWindow = await verifyTotpSetupCode({
      redis: mockRedis,
      userId: TEST_USER_ID,
      plaintextSecret: secret,
      code: codeNow,
      now: ninetySecondsLater,
      window: 3,
    });
    expect(widerWindow).toEqual({ ok: true });
  });
});
