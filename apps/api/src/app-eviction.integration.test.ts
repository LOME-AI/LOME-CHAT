import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishRegistration,
  startRegistration,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { createEvictUserPort } from './app.js';
import { revokeSession } from './slices/identity/domain/index.js';
import { rotatePasswordCredentials } from './slices/identity/domain/credentials.js';
import {
  deserializeRegistrationRequest,
  runNewPasswordRegisterInit,
} from './slices/identity/domain/opaque.js';
import { IDENTITY_KEYS } from './slices/identity/domain/keys.js';
import { REALTIME_REDIS_KEYS } from './lib/redis/define-key.js';
import { okAsync } from './lib/result/index.js';
import type { AppEnv } from './lib/context/index.js';
import type { EvictUserPort } from './slices/identity/ports/index.js';
import type { DomainError } from './lib/errors/index.js';
import type { ResultAsync } from './lib/result/index.js';
import type { Telemetry } from './lib/telemetry/index.js';
import type {
  IdentityUserRecord,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from './slices/identity/ports/index.js';

/**
 * End-to-end wiring for session-revocation eviction (ARCHITECTURE §15): the
 * REAL `createEvictUserPort` composition — Redis `SMEMBERS` over the
 * DO-maintained active-room set, then the REAL `createRealtimeBroadcast` DO
 * client's `evict` per room — driven by the REAL `revokeSession` and
 * `rotatePasswordCredentials`. Only the DO transport (the platform seam every
 * apps/api test fakes) is stubbed: a namespace that records each room's evict.
 */

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const MASTER_SECRET = 'secret-at-least-32-characters-long!!';
const WRAPPED_KEY = toBase64(new Uint8Array([7, 8, 9]));

const createdKeys: string[] = [];

afterAll(async () => {
  if (createdKeys.length > 0) await redis.del(...createdKeys);
});

interface EvictCall {
  conversationId: string;
  principalId: string;
}

/**
 * A ConversationRoom DO namespace whose `/evict` records the (conversationId,
 * principalId) pair the real DO client posts. `idFromName` carries the
 * conversationId, so the recorded call reflects exactly which room's sockets
 * the fan-out targeted. `throwForRoom` makes `get` throw synchronously for one
 * room, exercising the port's per-room best-effort catch while its peers run.
 */
function recordingNamespace(
  evicted: EvictCall[],
  options: { throwForRoom?: string } = {}
): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => {
      if (options.throwForRoom === id.name) {
        throw new Error('conversation room unreachable');
      }
      return {
        fetch: (_url: string, init?: RequestInit) => {
          // The real DO client always posts a JSON string body (postJson).
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const body = JSON.parse(raw) as { principalId: string };
          evicted.push({ conversationId: id.name, principalId: body.principalId });
          return Promise.resolve(Response.json({ closed: 1 }));
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

function envWith(namespace: DurableObjectNamespace): AppEnv['Bindings'] {
  return { CONVERSATION_ROOM: namespace } as unknown as AppEnv['Bindings'];
}

/** Env missing the realtime binding — a deployment without the DO namespace. */
function envWithoutRealtime(): AppEnv['Bindings'] {
  return {} as unknown as AppEnv['Bindings'];
}

async function trackRooms(userId: string, rooms: readonly string[]): Promise<void> {
  const key = REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId);
  createdKeys.push(key);
  for (const room of rooms) await redis.sadd(key, room);
}

function userId(): string {
  return `evict-e2e-${crypto.randomUUID()}`;
}

/** A real OPAQUE registration record, produced by the full client/server dance. */
async function validRecord(id: string): Promise<number[]> {
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, 'rotated password');
  const request = deserializeRegistrationRequest(serialized)._unsafeUnwrap();
  const response = await runNewPasswordRegisterInit(MASTER_SECRET, id, request);
  const { record } = await finishRegistration(
    client,
    response._unsafeUnwrap(),
    OPAQUE_SERVER_IDENTIFIER
  );
  return record;
}

const noopEmailPort: PasswordChangedEmailPort = {
  sendPasswordChangedEmail: (): ResultAsync<void, DomainError> => okAsync(),
};

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
} as unknown as Telemetry;

/** findById returns null so the best-effort notification is a no-op. */
const nullFindStore = {
  findById: (): ResultAsync<IdentityUserRecord | null, DomainError> => okAsync(null),
  rotatePassword: (): ResultAsync<void, DomainError> => okAsync(),
} as unknown as IdentityUsersStore;

describe('createEvictUserPort fans out over the active-room set', () => {
  it('evicts the user from every room they hold a live socket in', async () => {
    const evicted: EvictCall[] = [];
    const id = userId();
    await trackRooms(id, ['room-a', 'room-b']);
    const port = createEvictUserPort(redis, envWith(recordingNamespace(evicted)));

    await port.evictUser(id);

    expect(
      evicted.map((call) => call.conversationId).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['room-a', 'room-b']);
    expect(evicted.every((call) => call.principalId === id)).toBe(true);
  });

  it('no-ops for a user with no tracked rooms', async () => {
    const evicted: EvictCall[] = [];
    const port = createEvictUserPort(redis, envWith(recordingNamespace(evicted)));
    await port.evictUser(userId());
    expect(evicted).toEqual([]);
  });

  it('swallows one room’s failure and still evicts its peers', async () => {
    const evicted: EvictCall[] = [];
    const id = userId();
    await trackRooms(id, ['room-x', 'room-y']);
    const port = createEvictUserPort(
      redis,
      envWith(recordingNamespace(evicted, { throwForRoom: 'room-x' }))
    );
    // room-x throws at the DO transport; the fan-out swallows it and room-y is
    // still evicted — the promise resolves.
    await expect(port.evictUser(id)).resolves.toBeUndefined();
    expect(evicted).toEqual([{ conversationId: 'room-y', principalId: id }]);
  });

  it('degrades to a no-op port (never throws) when the realtime binding is absent', async () => {
    // Realtime is best-effort (ARCHITECTURE §15): a missing CONVERSATION_ROOM
    // binding must not throw here, or it would 500 the critical auth routes
    // that construct this port as a handler argument. The port is returned;
    // its evict is a no-op (no rooms read, no DO call).
    const port = createEvictUserPort(redis, envWithoutRealtime());
    await expect(port.evictUser(userId())).resolves.toBeUndefined();
  });

  it('stays best-effort when the active-room read (SMEMBERS) fails', async () => {
    const evicted: EvictCall[] = [];
    const failingRedis = {
      smembers: () => Promise.reject(new Error('redis down')),
    } as unknown as Redis;
    const port = createEvictUserPort(failingRedis, envWith(recordingNamespace(evicted)));
    await expect(port.evictUser(userId())).resolves.toBeUndefined();
    expect(evicted).toEqual([]);
  });
});

describe('revocation flows fan the eviction out end-to-end', () => {
  it('closes both rooms on logout via the real revokeSession path', async () => {
    const evicted: EvictCall[] = [];
    const id = userId();
    await trackRooms(id, ['room-1', 'room-2']);
    const port = createEvictUserPort(redis, envWith(recordingNamespace(evicted)));

    const result = await revokeSession(redis, { userId: id, sessionId: crypto.randomUUID() }, port);

    expect(result.isOk()).toBe(true);
    expect(
      evicted.map((call) => call.conversationId).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['room-1', 'room-2']);
  });

  it('closes both rooms on a credential rotation (password change / recovery reset)', async () => {
    const evicted: EvictCall[] = [];
    const id = userId();
    await trackRooms(id, ['room-3', 'room-4']);
    const port = createEvictUserPort(redis, envWith(recordingNamespace(evicted)));

    const result = await rotatePasswordCredentials({
      redis,
      store: nullFindStore,
      emailPort: noopEmailPort,
      logger: silentLogger,
      userId: id,
      newRegistrationRecord: await validRecord(id),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
      evictUser: port,
    });

    expect(result.isOk()).toBe(true);
    expect(
      evicted.map((call) => call.conversationId).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['room-3', 'room-4']);
  });

  it('a rotation still completes when eviction fails at the DO transport', async () => {
    const id = userId();
    await trackRooms(id, ['room-5']);
    const port = createEvictUserPort(
      redis,
      envWith(recordingNamespace([], { throwForRoom: 'room-5' }))
    );

    const result = await rotatePasswordCredentials({
      redis,
      store: nullFindStore,
      emailPort: noopEmailPort,
      logger: silentLogger,
      userId: id,
      newRegistrationRecord: await validRecord(id),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
      evictUser: port,
    });

    expect(result.isOk()).toBe(true);
  });
});

describe('the security-critical revocation writes happen regardless of eviction', () => {
  // A no-op eviction port stands in for a deployment with no realtime fan-out:
  // revocation must still perform its Redis writes. Eviction is best-effort;
  // the sessionActive DELETE and the passwordChangedAt watermark are not.
  const noopEvict: EvictUserPort = { evictUser: () => Promise.resolve() };

  it('revokeSession still deletes the sessionActive key with a no-op eviction port', async () => {
    const id = userId();
    const sessionId = crypto.randomUUID();
    const key = IDENTITY_KEYS.sessionActive.buildKey(id, sessionId);
    createdKeys.push(key);
    await redis.set(key, '1');

    const result = await revokeSession(redis, { userId: id, sessionId }, noopEvict);

    expect(result.isOk()).toBe(true);
    expect(await redis.get(key)).toBeNull();
  });

  it('a credential rotation still writes the passwordChangedAt watermark with a no-op eviction port', async () => {
    const id = userId();
    const now = Date.now();
    createdKeys.push(IDENTITY_KEYS.passwordChangedAt.buildKey(id));

    const result = await rotatePasswordCredentials({
      redis,
      store: nullFindStore,
      emailPort: noopEmailPort,
      logger: silentLogger,
      userId: id,
      newRegistrationRecord: await validRecord(id),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now,
      evictUser: noopEvict,
    });

    expect(result.isOk()).toBe(true);
    expect(await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(id))).toBe(now);
  });
});
