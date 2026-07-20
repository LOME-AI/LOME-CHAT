import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  createOpaqueServerFromEnv,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueServerConfig,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { startOpaqueStepUp, finishOpaqueStepUp } from './opaque-step-up.js';
import { REDIS_REGISTRY } from './redis-registry.js';
import type { Redis } from '@upstash/redis';

const TEST_MASTER_SECRET = 'test-master-secret-at-least-32-bytes-long-for-testing';
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

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

async function buildUserRegistration(password: string): Promise<{
  opaqueRegistration: Uint8Array;
}> {
  const server = await createOpaqueServerFromEnv(TEST_MASTER_SECRET);
  const regClient = createOpaqueClient();
  const { serialized } = await startRegistration(regClient, password);

  const request = OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized);
  const regInit = await server.registerInit(request, TEST_USER_ID);
  if (regInit instanceof Error) throw regInit;

  const { record } = await finishRegistration(
    regClient,
    regInit.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const recordObject = OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, record);
  return { opaqueRegistration: new Uint8Array(recordObject.serialize()) };
}

describe('startOpaqueStepUp', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns a ke2 and writes the expected serialized blob to Redis under the configured key with the registry-default TTL', async () => {
    const password = 'test-password-123';
    const { opaqueRegistration } = await buildUserRegistration(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const masterSecret = textEncoder.encode(TEST_MASTER_SECRET);

    const result = await startOpaqueStepUp({
      ke1: new Uint8Array(ke1),
      userId: TEST_USER_ID,
      opaqueRegistration,
      username: TEST_USER_ID,
      masterSecret,
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    expect(result.ke2).toBeInstanceOf(Uint8Array);
    expect(result.ke2.length).toBeGreaterThan(0);
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);

    const redisKey = `opaque:2fa-disable:${result.sessionId}`;
    const stored = mockRedis.store.get(redisKey) as {
      userId: string;
      expectedSerialized: number[];
    } | null;
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe(TEST_USER_ID);
    expect(Array.isArray(stored?.expectedSerialized)).toBe(true);
    expect(stored?.expectedSerialized.length).toBeGreaterThan(0);
    expect(mockRedis.ttls.get(redisKey)).toBe(REDIS_REGISTRY.opaquePending2FADisable.ttl);
  });

  it('concurrent start calls for the same user write to distinct Redis slots (no clobber)', async () => {
    const password = 'concurrent-test-password';
    const { opaqueRegistration } = await buildUserRegistration(password);
    const masterSecret = textEncoder.encode(TEST_MASTER_SECRET);

    const startOnce = async (): Promise<string> => {
      const loginClient = createOpaqueClient();
      const { ke1 } = await startLogin(loginClient, password);
      const r = await startOpaqueStepUp({
        ke1: new Uint8Array(ke1),
        userId: TEST_USER_ID,
        opaqueRegistration,
        username: TEST_USER_ID,
        masterSecret,
        redis: mockRedis,
        redisKeyName: 'opaquePending2FADisable',
      });
      return r.sessionId;
    };

    const sessionA = await startOnce();
    const sessionB = await startOnce();

    expect(sessionA).not.toBe(sessionB);
    expect(mockRedis.store.has(`opaque:2fa-disable:${sessionA}`)).toBe(true);
    expect(mockRedis.store.has(`opaque:2fa-disable:${sessionB}`)).toBe(true);
  });
});

describe('finishOpaqueStepUp', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
  });

  it('returns { ok: false, reason: "no-pending" } when no Redis entry exists for the sessionId', async () => {
    const result = await finishOpaqueStepUp({
      ke3: new Uint8Array([1, 2, 3]),
      userId: TEST_USER_ID,
      sessionId: '00000000-0000-0000-0000-deadbeefdead',
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    expect(result).toEqual({ ok: false, reason: 'no-pending' });
  });

  it('returns { ok: false, reason: "bad-proof" } and does NOT delete the Redis entry when ke3 is invalid', async () => {
    const password = 'test-password-bad-proof';
    const { opaqueRegistration } = await buildUserRegistration(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const masterSecret = textEncoder.encode(TEST_MASTER_SECRET);

    const { ke2, sessionId } = await startOpaqueStepUp({
      ke1: new Uint8Array(ke1),
      userId: TEST_USER_ID,
      opaqueRegistration,
      username: TEST_USER_ID,
      masterSecret,
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    // Produce a valid ke3 against the actual ke2, then flip a byte so the MAC
    // no longer matches the stored expected. authFinish must reject the proof.
    const { ke3: validKe3 } = await finishLogin(loginClient, [...ke2], OPAQUE_SERVER_IDENTIFIER);
    const tampered = new Uint8Array(validKe3);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;

    const redisKey = `opaque:2fa-disable:${sessionId}`;
    expect(mockRedis.store.has(redisKey)).toBe(true);

    const result = await finishOpaqueStepUp({
      ke3: tampered,
      userId: TEST_USER_ID,
      sessionId,
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    expect(result).toEqual({ ok: false, reason: 'bad-proof' });
    expect(mockRedis.store.has(redisKey)).toBe(true);
  });

  it('returns { ok: true } and DELETES the Redis entry when ke3 is valid', async () => {
    const password = 'test-password-valid';
    const { opaqueRegistration } = await buildUserRegistration(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const masterSecret = textEncoder.encode(TEST_MASTER_SECRET);

    const { ke2, sessionId } = await startOpaqueStepUp({
      ke1: new Uint8Array(ke1),
      userId: TEST_USER_ID,
      opaqueRegistration,
      username: TEST_USER_ID,
      masterSecret,
      redis: mockRedis,
      redisKeyName: 'opaquePendingChangePassword',
    });

    const { ke3 } = await finishLogin(loginClient, [...ke2], OPAQUE_SERVER_IDENTIFIER);

    const redisKey = `opaque:change-pw:${sessionId}`;
    expect(mockRedis.store.has(redisKey)).toBe(true);

    const result = await finishOpaqueStepUp({
      ke3: new Uint8Array(ke3),
      userId: TEST_USER_ID,
      sessionId,
      redis: mockRedis,
      redisKeyName: 'opaquePendingChangePassword',
    });

    expect(result).toEqual({ ok: true });
    expect(mockRedis.store.has(redisKey)).toBe(false);
  });

  it('returns { ok: false, reason: "session-mismatch" } and clears the entry when the stored userId differs', async () => {
    const password = 'test-password-mismatch';
    const { opaqueRegistration } = await buildUserRegistration(password);

    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, password);

    const masterSecret = textEncoder.encode(TEST_MASTER_SECRET);

    const { sessionId } = await startOpaqueStepUp({
      ke1: new Uint8Array(ke1),
      userId: TEST_USER_ID,
      opaqueRegistration,
      username: TEST_USER_ID,
      masterSecret,
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    const redisKey = `opaque:2fa-disable:${sessionId}`;
    expect(mockRedis.store.has(redisKey)).toBe(true);

    // Different userId than the one bound to the sessionId.
    const result = await finishOpaqueStepUp({
      ke3: new Uint8Array([1, 2, 3]),
      userId: '00000000-0000-0000-0000-000000000999',
      sessionId,
      redis: mockRedis,
      redisKeyName: 'opaquePending2FADisable',
    });

    expect(result).toEqual({ ok: false, reason: 'session-mismatch' });
    expect(mockRedis.store.has(redisKey)).toBe(false);
  });
});
