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
import type { Principal } from '../lib/context/index.js';
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

/** The exact drizzle call chain `enqueueWithinTx` runs for a deduped insert. */
function fakeEnqueueTx(
  jobId: string
): Parameters<AdminOperationsDeps['newsletterDispatch']['enqueueWithinTx']>[0] {
  const chain = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: jobId }]) }),
      }),
    }),
  };
  return chain as unknown as Parameters<
    AdminOperationsDeps['newsletterDispatch']['enqueueWithinTx']
  >[0];
}

function fakeJobDispatcher(): JobDispatcherNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({ fetch: () => Promise.resolve({}) }),
  };
}

/** The composed env under test: `Bindings` plus the optional DO bindings the adapter consumes. */
type OpBindingsEnv = Partial<Bindings> & {
  CONVERSATION_ROOM?: ConversationRoomNamespace;
  JOB_DISPATCHER?: JobDispatcherNamespace;
  API_URL?: string;
  MARKETING_URL?: string;
};

const ENV_BASE = {
  UPSTASH_REDIS_REST_URL: 'https://redis.local',
  UPSTASH_REDIS_REST_TOKEN: 'token',
} satisfies OpBindingsEnv;

interface BuildResult {
  readonly deps: AdminOperationsDeps;
  readonly redis: Redis;
  readonly evictCalls: readonly { readonly redis: Redis; readonly env: OpBindingsEnv }[];
  readonly probed?: { readonly ok: boolean; readonly value: unknown } | undefined;
}

interface BuildOptions {
  readonly principal?: Principal;
  /** Runs with the built deps INSIDE the request context (context-dependent
   * members — actorEmail, the lazy newsletter constructions — resolve there). */
  readonly inContext?: (deps: AdminOperationsDeps) => unknown;
}

/** Runs `createAdminOpDeps` inside a context-storage-wrapped request, the shape the composition root provides. */
async function buildDeps(env: OpBindingsEnv, options: BuildOptions = {}): Promise<BuildResult> {
  const redis = {} as Redis;
  const evictCalls: { redis: Redis; env: OpBindingsEnv }[] = [];
  const evictUser = (r: Redis, e: AppEnv['Bindings']): EvictUserPort => {
    evictCalls.push({ redis: r, env: e });
    return { evictUser: () => Promise.resolve() };
  };

  let captured: AdminOperationsDeps | undefined;
  let probed: { ok: boolean; value: unknown } | undefined;
  const app = new Hono<AppEnv>();
  app.use(contextStorage());
  app.post('/build', async (c) => {
    c.set('redis', redis);
    if (options.principal !== undefined) c.set('principal', options.principal);
    captured = createAdminOpDeps({} as Database, createBillingStores(), evictUser);
    if (options.inContext !== undefined) {
      try {
        probed = { ok: true, value: await options.inContext(captured) };
      } catch (error) {
        probed = { ok: false, value: error };
      }
    }
    return c.json({ ok: true });
  });
  await app.request('/build', { method: 'POST' }, env as Bindings);

  if (captured === undefined) throw new Error('deps were not built');
  return { deps: captured, redis, evictCalls, probed };
}

describe('createAdminOpDeps', () => {
  it('resolves the production dep set from the request context', async () => {
    const { deps, redis, evictCalls } = await buildDeps({
      ...ENV_BASE,
      CONVERSATION_ROOM: fakeRoomNamespace(),
    });

    expect(deps.bannerConfig).toBeDefined();
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

  it('resolves actorEmail from the admin-actor principal at call time', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        principal: { kind: 'admin-actor', email: 'ops@hushbox.ai', audience: 'aud' },
        inContext: (deps) => deps.actorEmail(),
      }
    );
    expect(probed).toEqual({ ok: true, value: 'ops@hushbox.ai' });
  });

  it('refuses actorEmail for a non-admin principal (pipeline defect, thrown)', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        principal: { kind: 'trial-session', sessionId: 'trial-1' },
        inContext: (deps) => deps.actorEmail(),
      }
    );
    expect(probed?.ok).toBe(false);
    expect(String(probed?.value)).toMatch(/admin-actor/);
  });

  it('reads a newsletter issue row within the caller transaction', async () => {
    const row = { id: 'issue-1', subject: 's' };
    const tx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    } as unknown as Parameters<AdminOperationsDeps['newsletterIssueReader']['readWithinTx']>[0];
    const emptyTx = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as typeof tx;
    const { deps } = await buildDeps({ ...ENV_BASE, CONVERSATION_ROOM: fakeRoomNamespace() });

    expect(await deps.newsletterIssueReader.readWithinTx(tx, 'issue-1')).toBe(row);
    expect(await deps.newsletterIssueReader.readWithinTx(emptyTx, 'issue-2')).toBeNull();
  });

  it('fails fast on a dispatch enqueue when the issue email urls are unconfigured', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, NODE_ENV: 'development', CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        inContext: (deps) =>
          deps.newsletterDispatch.enqueueWithinTx(fakeEnqueueTx('job-1'), {
            issueId: crypto.randomUUID(),
            scheduledAt: new Date('2999-01-01T00:00:00.000Z'),
          }),
      }
    );
    expect(probed?.ok).toBe(false);
    expect(String(probed?.value)).toMatch(/API_URL\/MARKETING_URL/);
  });

  it('enqueues the dispatch job through the lazily built registration', async () => {
    const { probed } = await buildDeps(
      {
        ...ENV_BASE,
        NODE_ENV: 'development',
        API_URL: 'http://api.test.local',
        MARKETING_URL: 'http://marketing.test.local',
        CONVERSATION_ROOM: fakeRoomNamespace(),
      },
      {
        inContext: (deps) =>
          deps.newsletterDispatch.enqueueWithinTx(fakeEnqueueTx('job-9'), {
            issueId: crypto.randomUUID(),
            scheduledAt: new Date('2999-01-01T00:00:00.000Z'),
          }),
      }
    );
    expect(probed).toEqual({ ok: true, value: { enqueued: true, jobId: 'job-9' } });
  });

  it('sends the newsletter test email through the env-selected sender', async () => {
    const { probed } = await buildDeps(
      { ...ENV_BASE, NODE_ENV: 'development', CONVERSATION_ROOM: fakeRoomNamespace() },
      {
        inContext: async (deps) => {
          const sent = await deps.newsletterTestEmail.send({
            subject: 'preview',
            bodyMarkdown: '# body',
            to: 'ops@hushbox.ai',
          });
          return sent.isOk();
        },
      }
    );
    expect(probed).toEqual({ ok: true, value: true });
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
