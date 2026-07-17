import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { describe, expect, it } from 'vitest';
import { createBillingStores } from '../slices/billing/index.js';
import { createConversationsStores } from '../slices/conversations/index.js';
import { createAdminOpDeps } from './admin-op-bindings.js';
import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { AppEnv, Bindings } from '../lib/context/index.js';
import type { JobDispatcherNamespace } from '../lib/jobs/index.js';
import type { AdminOperationsDeps } from '../slices/admin/index.js';
import type { ConversationRoomNamespace } from '../slices/conversations/index.js';
import type { EvictUserPort } from '../slices/identity/index.js';

/** A DO namespace whose stub only records fetches and answers a fixed JSON body. */
function fakeRoomNamespace(): ConversationRoomNamespace {
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve(Response.json({ closed: 3 })) }),
  };
  return namespace as unknown as ConversationRoomNamespace;
}

function fakeJobDispatcher(): JobDispatcherNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve({}) }),
  };
}

const ENV_BASE = {
  UPSTASH_REDIS_REST_URL: 'https://redis.local',
  UPSTASH_REDIS_REST_TOKEN: 'token',
} satisfies Partial<Bindings>;

interface BuildResult {
  readonly deps: AdminOperationsDeps;
  readonly redis: Redis;
  readonly evictCalls: ReadonlyArray<{ readonly redis: Redis; readonly env: Bindings }>;
}

/** Runs `createAdminOpDeps` inside a context-storage-wrapped request, the shape the composition root provides. */
async function buildDeps(env: Partial<Bindings>): Promise<BuildResult> {
  const redis = {} as Redis;
  const evictCalls: Array<{ redis: Redis; env: Bindings }> = [];
  const evictUser = (r: Redis, e: AppEnv['Bindings']): EvictUserPort => {
    evictCalls.push({ redis: r, env: e });
    return { evictUser: () => Promise.resolve() };
  };

  let captured: AdminOperationsDeps | undefined;
  const app = new Hono<AppEnv>();
  app.use(contextStorage());
  app.post('/build', (c) => {
    c.set('redis', redis);
    captured = createAdminOpDeps({} as Database, createBillingStores(), evictUser);
    return c.json({ ok: true });
  });
  await app.request('/build', { method: 'POST' }, env as Bindings);

  if (captured === undefined) throw new Error('deps were not built');
  return { deps: captured, redis, evictCalls };
}

describe('createAdminOpDeps', () => {
  it('resolves the production dep set from the request context', async () => {
    const { deps, redis, evictCalls } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    expect(deps.billingStores).toBeDefined();
    expect(deps.identityStores).toBeDefined();
    expect(deps.jobRegistry).toBeDefined();
    expect(deps.membershipRevoker).toBeDefined();
    expect(deps.realtime).toBeDefined();
    expect(deps.redis).toBe(redis);
    expect(deps.conversationsStores).toBe(createConversationsStores);
    expect(deps.clock.now()).toBeInstanceOf(Date);
    expect(evictCalls).toHaveLength(1);
    expect(evictCalls[0]?.redis).toBe(redis);
    expect(evictCalls[0]?.env.CONVERSATION_ROOM).toBeDefined();
  });

  it('falls back to the absent-binding dispatcher when JOB_DISPATCHER is missing', async () => {
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });
    expect(() => deps.jobDispatcher.idFromName('default')).toThrow(/JOB_DISPATCHER/);
    expect(() => deps.jobDispatcher.get('default')).toThrow(/JOB_DISPATCHER/);
  });

  it('uses the bound JOB_DISPATCHER namespace when present', async () => {
    const dispatcher = fakeJobDispatcher();
    const { deps } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
      JOB_DISPATCHER: dispatcher,
    });
    expect(deps.jobDispatcher).toBe(dispatcher);
  });

  it('lazily constructs the realtime broadcast and memoizes it across calls', async () => {
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });
    const first = await deps.realtime.evict('conversation-1', 'principal-1');
    const second = await deps.realtime.evict('conversation-2', 'principal-2');
    expect(first.isOk() && first.value).toBe(3);
    expect(second.isOk() && second.value).toBe(3);
  });

  it('proxies every realtime method through the resolved broadcast', async () => {
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });
    const headers = new Headers();
    const results = await Promise.all([
      deps.realtime.broadcast('c', { type: 'presence', conversationId: 'c' } as never),
      deps.realtime.evict('c', 'p'),
      deps.realtime.presence('c'),
      deps.realtime.startRun('c', {} as never),
      deps.realtime.stopRun('c'),
      deps.realtime.upgrade('c', { principalId: 'p', isGuest: false } as never, headers),
    ]);
    // Every proxy arrow returns a Result (ok or err) — none throws synchronously.
    for (const result of results) {
      expect(typeof result.isOk).toBe('function');
    }
  });
});
