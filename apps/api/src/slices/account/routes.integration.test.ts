import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  users,
} from '@hushbox/db';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS, ERROR_CODES, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createAccountManifest, createAccountStores } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for account route integration tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let userCounter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function createUser(usernameSuffix: string): Promise<string> {
  const username = `${PREFIX}${usernameSuffix}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@account-slice.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

/** A fresh user + session per state test, so no test depends on another's writes. */
async function newSessionUser(): Promise<{ userId: string; cookie: string }> {
  userCounter += 1;
  const userId = await createUser(`u${String(userCounter)}`);
  return { userId, cookie: await sessionCookie(userId) };
}

function createApp(): Hono<AppEnv> {
  const manifest = createAccountManifest({ stores: createAccountStores });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function get(path: string, cookie: string): Promise<Response> {
  return createApp().request(path, { headers: { cookie } }, testEnv);
}

async function send(
  path: string,
  method: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  return createApp().request(
    path,
    {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    testEnv
  );
}

afterAll(async () => {
  // Conversations first: deleting a user SET-NULLs other users' member rows,
  // which the members identity check forbids for still-active rows.
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('account routes: pipeline enforcement', () => {
  const routes: [string, string][] = [
    ['GET', '/account/users/search?q=a&conversationId=0197a000-0000-7000-8000-000000000001'],
    ['GET', '/account/instructions'],
    ['PUT', '/account/instructions'],
    ['DELETE', '/account/instructions'],
    ['GET', '/account/preferences/accessibility'],
    ['PUT', '/account/preferences/accessibility'],
  ];

  it.each(routes)('answers 401 to an anonymous %s %s', async (method, path) => {
    const res = await createApp().request(path, { method }, testEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('account routes: user search', () => {
  let callerId: string;
  let formerMemberId: string;
  let outsiderId: string;
  let conversationId: string;
  let cookie: string;

  interface SearchBody {
    users: { id: string; username: string; publicKey: string }[];
  }

  beforeAll(async () => {
    callerId = await createUser('scal');
    const activeMemberId = await createUser('smem');
    formerMemberId = await createUser('sold');
    outsiderId = await createUser('sout');
    await createUser('sx_y');
    await createUser('sxzy');
    const conversationRows = await db
      .insert(conversations)
      .values({ userId: callerId, title: BYTES })
      .returning({ id: conversations.id });
    const createdConversationId = conversationRows[0]?.id;
    if (createdConversationId === undefined) throw new Error('conversation seed failed');
    conversationId = createdConversationId;
    createdConversationIds.push(conversationId);
    await db.insert(conversationMembers).values([
      { conversationId, userId: callerId, visibleFromEpoch: 1 },
      { conversationId, userId: activeMemberId, visibleFromEpoch: 1 },
      {
        conversationId,
        userId: formerMemberId,
        visibleFromEpoch: 1,
        leftAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    cookie = await sessionCookie(callerId);
  });

  function searchPath(q: string, limit?: number): string {
    const params = new URLSearchParams({ q, conversationId });
    if (limit !== undefined) params.set('limit', String(limit));
    return `/account/users/search?${params.toString()}`;
  }

  async function searchUsernames(q: string, limit?: number): Promise<string[]> {
    const res = await get(searchPath(q, limit), cookie);
    expect(res.status).toBe(200);
    const body: SearchBody = await res.json();
    return body.users.map((u) => u.username);
  }

  it('excludes the caller from the results', async () => {
    expect(await searchUsernames(`${PREFIX}s`)).not.toContain(`${PREFIX}scal`);
  });

  it('excludes active members of the conversation', async () => {
    expect(await searchUsernames(`${PREFIX}s`)).not.toContain(`${PREFIX}smem`);
  });

  it('includes a former member who has left the conversation', async () => {
    expect(await searchUsernames(`${PREFIX}s`)).toContain(`${PREFIX}sold`);
  });

  it('returns matching non-members sorted by username', async () => {
    expect(await searchUsernames(`${PREFIX}so`)).toEqual([`${PREFIX}sold`, `${PREFIX}sout`]);
  });

  it('returns each match with its base64 public key', async () => {
    const res = await get(searchPath(`${PREFIX}sout`), cookie);
    const body: SearchBody = await res.json();
    expect(body.users[0]?.publicKey).toBe(toBase64(BYTES));
  });

  it('treats an underscore in the query as a literal character', async () => {
    expect(await searchUsernames(`${PREFIX}sx_`)).toEqual([`${PREFIX}sx_y`]);
  });

  it('caps the result count at the requested limit', async () => {
    expect(await searchUsernames(`${PREFIX}s`, 1)).toHaveLength(1);
  });

  it('rejects a malformed conversationId with the uniform validation body', async () => {
    const res = await get('/account/users/search?q=a&conversationId=not-a-uuid', cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('answers 403 with no results to a caller who is not a member of the conversation', async () => {
    const res = await get(searchPath(`${PREFIX}s`), await sessionCookie(outsiderId));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers 403 to a former member who has left the conversation', async () => {
    const res = await get(searchPath(`${PREFIX}s`), await sessionCookie(formerMemberId));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });
});

describe('account routes: database unavailability', () => {
  // Session unsealing never touches the database, so any sealed identity
  // reaches the handlers and the store failure surfaces as 503.
  const deadDbEnv = {
    ...testEnv,
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox',
  };

  const cases: [string, string, unknown][] = [
    [
      'GET',
      '/account/users/search?q=a&conversationId=0197a000-0000-7000-8000-000000000001',
      undefined,
    ],
    ['GET', '/account/instructions', undefined],
    ['PUT', '/account/instructions', { instructions: 'AQID' }],
    ['DELETE', '/account/instructions', undefined],
    ['GET', '/account/preferences/accessibility', undefined],
    [
      'PUT',
      '/account/preferences/accessibility',
      { preferences: { version: 1 }, updatedAt: '2026-06-01T00:00:00.000Z' },
    ],
  ];

  it.each(cases)(
    'answers 503 to %s %s when the database is unreachable',
    async (method, path, body) => {
      const cookie = await sessionCookie('0197a000-0000-7000-8000-00000000dead');
      const res = await createApp().request(
        path,
        {
          method,
          headers: { cookie, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        deadDbEnv
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
    }
  );
});

describe('account routes: custom instructions', () => {
  it('returns null before any instructions are stored', async () => {
    const { cookie } = await newSessionUser();
    const res = await get('/account/instructions', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ instructions: null });
  });

  it('stores and returns the opaque encrypted blob', async () => {
    const { cookie } = await newSessionUser();
    const blob = toBase64(new Uint8Array([42, 43, 44]));
    const put = await send('/account/instructions', 'PUT', cookie, { instructions: blob });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ success: true });
    const res = await get('/account/instructions', cookie);
    expect(await res.json()).toEqual({ instructions: blob });
  });

  it('overwrites the blob on a second put', async () => {
    const { cookie } = await newSessionUser();
    await send('/account/instructions', 'PUT', cookie, {
      instructions: toBase64(new Uint8Array([1])),
    });
    const blob = toBase64(new Uint8Array([7, 7, 7, 7]));
    await send('/account/instructions', 'PUT', cookie, { instructions: blob });
    const res = await get('/account/instructions', cookie);
    expect(await res.json()).toEqual({ instructions: blob });
  });

  it('rejects a blob that is not base64', async () => {
    const { cookie } = await newSessionUser();
    const res = await send('/account/instructions', 'PUT', cookie, { instructions: '!!!' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects a blob over the encoded size cap', async () => {
    const { cookie } = await newSessionUser();
    const res = await send('/account/instructions', 'PUT', cookie, {
      instructions: 'A'.repeat(43_692),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('clears the stored blob', async () => {
    const { cookie } = await newSessionUser();
    await send('/account/instructions', 'PUT', cookie, {
      instructions: toBase64(new Uint8Array([5])),
    });
    const res = await send('/account/instructions', 'DELETE', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const after = await get('/account/instructions', cookie);
    expect(await after.json()).toEqual({ instructions: null });
  });

  it('treats clearing absent instructions as a no-op success', async () => {
    const { cookie } = await newSessionUser();
    const res = await send('/account/instructions', 'DELETE', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});

describe('account routes: accessibility preferences (LWW)', () => {
  const T1 = '2026-06-01T00:00:00.000Z';
  const T2 = '2026-06-02T00:00:00.000Z';
  const T3 = '2026-06-03T00:00:00.000Z';

  function putPrefs(cookie: string, preferences: object, updatedAt: string): Promise<Response> {
    return send('/account/preferences/accessibility', 'PUT', cookie, { preferences, updatedAt });
  }

  it('returns the defaults with a null timestamp before any sync', async () => {
    const { cookie } = await newSessionUser();
    const res = await get('/account/preferences/accessibility', cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
      updatedAt: null,
    });
  });

  it('accepts the first write', async () => {
    const { cookie } = await newSessionUser();
    const res = await putPrefs(cookie, { version: 1, contrast: 'high' }, T2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accepted: true,
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
      updatedAt: T2,
    });
  });

  it('rejects a stale write and returns the authoritative stored state', async () => {
    const { cookie } = await newSessionUser();
    await putPrefs(cookie, { version: 1, contrast: 'high' }, T2);
    const res = await putPrefs(cookie, { version: 1, saturation: '50' }, T1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      accepted: false,
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
      updatedAt: T2,
    });
  });

  it('leaves the stored state untouched after a stale write', async () => {
    const { cookie } = await newSessionUser();
    await putPrefs(cookie, { version: 1, contrast: 'high' }, T2);
    await putPrefs(cookie, { version: 1, saturation: '50' }, T1);
    const res = await get('/account/preferences/accessibility', cookie);
    expect(await res.json()).toEqual({
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
      updatedAt: T2,
    });
  });

  it('applies an equal-timestamp write (deterministic tie-break: incoming wins)', async () => {
    const { cookie } = await newSessionUser();
    await putPrefs(cookie, { version: 1, contrast: 'high' }, T2);
    const res = await putPrefs(cookie, { version: 1, contrast: 'low' }, T2);
    expect(await res.json()).toEqual({
      accepted: true,
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'low' },
      updatedAt: T2,
    });
    const after = await get('/account/preferences/accessibility', cookie);
    expect(await after.json()).toEqual({
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'low' },
      updatedAt: T2,
    });
  });

  it('applies a newer write over the stored state', async () => {
    const { cookie } = await newSessionUser();
    await putPrefs(cookie, { version: 1, contrast: 'high' }, T2);
    const res = await putPrefs(cookie, { version: 1, fontSize: '124' }, T3);
    expect(await res.json()).toEqual({
      accepted: true,
      preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '124' },
      updatedAt: T3,
    });
  });

  it('rejects a malformed preferences body', async () => {
    const { cookie } = await newSessionUser();
    const res = await putPrefs(cookie, { version: 1, contrast: 'sideways' }, T3);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});
