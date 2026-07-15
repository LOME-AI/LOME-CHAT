import { afterAll, describe, expect, it } from 'vitest';
import {
  createDispatcherJobRegistry,
  openDispatcherDbFromEnv,
  openDispatcherRedis,
} from './dispatcher-job-registry.js';
import { PAYMENT_VERIFY_JOB_TYPE } from '../slices/billing/index.js';
import { SESSION_REVOKE_JOB_TYPE } from '../slices/identity/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../slices/media/index.js';
import { REALTIME_REDIS_KEYS } from '../lib/redis/define-key.js';
import { IDENTITY_KEYS } from '../slices/identity/domain/keys.js';
import type { JobExecution } from '../lib/jobs/index.js';
import type { Bindings } from '../lib/context/app-env.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`dispatcher registry tests: missing ${name}. Run via a package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');

// The env the DO's composition sees. In dev the mock payment provider is
// selected — it fails fast without API_URL/HELCIM_WEBHOOK_VERIFIER, so both are
// supplied exactly as the local stack provides them; the media-reclaim handler's
// R2 storage adapter likewise fails fast without the R2 bindings.
interface DispatcherEnv extends Bindings {
  API_URL: string;
  HELCIM_WEBHOOK_VERIFIER: string;
  R2_S3_ENDPOINT: string;
  R2_BUCKET_MEDIA: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
}

const env: DispatcherEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  API_URL: requiredEnv('API_URL'),
  HELCIM_WEBHOOK_VERIFIER: requiredEnv('HELCIM_WEBHOOK_VERIFIER'),
  R2_S3_ENDPOINT: requiredEnv('R2_S3_ENDPOINT'),
  R2_BUCKET_MEDIA: requiredEnv('R2_BUCKET_MEDIA'),
  R2_ACCESS_KEY_ID: requiredEnv('R2_ACCESS_KEY_ID'),
  R2_SECRET_ACCESS_KEY: requiredEnv('R2_SECRET_ACCESS_KEY'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
};

// A minimal execution for a resolved handler. The payment-verify handler reads
// only `payload.paymentId`; on an absent pre-claim row it returns `dead` before
// touching the fenced completion/heartbeat capabilities, so those throw if the
// handler ever reaches for them.
function executionFor(paymentId: string): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload: { paymentId },
    claims: 1,
    heartbeat: () => Promise.reject(new Error('heartbeat unexpectedly invoked')),
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

describe('openDispatcherDbFromEnv', () => {
  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development' })).toThrow('DATABASE_URL');
  });

  it('fails fast when DATABASE_URL is empty', () => {
    expect(() => openDispatcherDbFromEnv({ NODE_ENV: 'development', DATABASE_URL: '' })).toThrow(
      'DATABASE_URL'
    );
  });

  it('opens a working client from the env binding', async () => {
    const db = openDispatcherDbFromEnv(env);
    expect(db).toBeDefined();
    await db.$client.end();
  });
});

describe('openDispatcherRedis', () => {
  it('fails fast when the Upstash binding is missing', () => {
    expect(() => openDispatcherRedis({ NODE_ENV: 'development', DATABASE_URL })).toThrow(
      'UPSTASH_REDIS_REST_URL/TOKEN'
    );
  });

  it('builds a client from the env binding', () => {
    expect(openDispatcherRedis(env)).toBeDefined();
  });
});

interface EvictCall {
  readonly conversationId: string;
  readonly principalId: string;
}

// A ConversationRoom DO namespace fake that records the /evict fan-out (the DO
// receives the principalId in the body) and answers the expected `{closed}`.
function recordingNamespace(evicted: EvictCall[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: (_url: string, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        const body = JSON.parse(raw) as { principalId: string };
        evicted.push({ conversationId: id.name, principalId: body.principalId });
        return Promise.resolve(Response.json({ closed: 1 }));
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function revokeExecutionFor(userId: string): JobExecution<unknown> {
  return {
    jobId: crypto.randomUUID(),
    payload: { userId },
    claims: 1,
    heartbeat: () => Promise.reject(new Error('heartbeat unexpectedly invoked')),
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

describe('createDispatcherJobRegistry — the registry the live JobDispatcher DO runs', () => {
  const db = openDispatcherDbFromEnv(env);
  const redis = openDispatcherRedis(env);
  const createdKeys: string[] = [];
  afterAll(async () => {
    if (createdKeys.length > 0) await redis.del(...createdKeys);
    await db.$client.end();
  });

  it('registers and resolves payment.verify.v1 (not the empty lib-composed default)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(PAYMENT_VERIFY_JOB_TYPE);
    const registered = registry.get(PAYMENT_VERIFY_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.schema.safeParse({ paymentId: crypto.randomUUID() }).success).toBe(true);
  });

  it('registers and resolves media.reclaimUser.v1 (E1 deletion enqueues it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(MEDIA_RECLAIM_USER_JOB_TYPE);
    const registered = registry.get(MEDIA_RECLAIM_USER_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(
      registered?.schema.safeParse({ userId: crypto.randomUUID(), storageKeys: [] }).success
    ).toBe(true);
  });

  it('registers and resolves session.revoke.v1 (the webhook and admin ops enqueue it — must not dead-letter as unknown)', () => {
    const registry = createDispatcherJobRegistry(env, db);
    expect(registry.types()).toContain(SESSION_REVOKE_JOB_TYPE);
    const registered = registry.get(SESSION_REVOKE_JOB_TYPE);
    expect(registered).toBeDefined();
    expect(registered?.shard).toBe('bulk');
    expect(registered?.schema.safeParse({ userId: crypto.randomUUID() }).success).toBe(true);
  });

  it('resolves the row to its handler — dead-by-handler, never "unregistered job type"', async () => {
    // The registry built exactly as the DO composition builds it (job-dispatcher.ts).
    // Before the relocation the DO ran an empty registry, so this type resolved
    // to nothing and the executor dead-lettered it as "unregistered job type".
    // Through the adapter-composed registry it resolves to the payment-verify
    // handler, which dead-letters on the absent pre-claim row with ITS reason —
    // proving live resolution, not the unknown-type path. Invoking the handler
    // directly (rather than a shard-wide pass) keeps this test off the shared
    // jobs table, so it cannot race the other bulk-shard jobs tests.
    const registered = createDispatcherJobRegistry(env, db).get(PAYMENT_VERIFY_JOB_TYPE);
    if (registered === undefined) throw new Error('payment.verify.v1 did not resolve');
    const outcome = await registered.handler(executionFor(crypto.randomUUID()));
    expect(outcome).toEqual({ kind: 'dead', error: 'payment pre-claim row does not exist' });
  });

  it('binds the session-revoke handler to the realtime eviction fan-out when CONVERSATION_ROOM is present', async () => {
    const userId = crypto.randomUUID();
    const roomKey = REALTIME_REDIS_KEYS.userActiveRooms.buildKey(userId);
    createdKeys.push(roomKey, IDENTITY_KEYS.passwordChangedAt.buildKey(userId));
    await redis.sadd(roomKey, 'room-cb');

    const evicted: EvictCall[] = [];
    const envWithRoom = { ...env, CONVERSATION_ROOM: recordingNamespace(evicted) };
    const registered = createDispatcherJobRegistry(envWithRoom, db).get(SESSION_REVOKE_JOB_TYPE);
    if (registered === undefined) throw new Error('session.revoke.v1 did not resolve');

    const outcome = await registered.handler(revokeExecutionFor(userId));

    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
    // The handler bumped the watermark (revoke-all) and fanned the eviction out
    // to the user's active room through the realtime binding.
    expect(evicted).toEqual([{ conversationId: 'room-cb', principalId: userId }]);
  });

  it('runs the session-revoke handler with a no-op eviction when CONVERSATION_ROOM is absent', async () => {
    const userId = crypto.randomUUID();
    createdKeys.push(IDENTITY_KEYS.passwordChangedAt.buildKey(userId));
    const registered = createDispatcherJobRegistry(env, db).get(SESSION_REVOKE_JOB_TYPE);
    if (registered === undefined) throw new Error('session.revoke.v1 did not resolve');
    const outcome = await registered.handler(revokeExecutionFor(userId));
    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
  });
});
