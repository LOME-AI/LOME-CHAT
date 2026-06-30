/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from '@hushbox/shared';
import { userPreferencesRoute } from './user-preferences.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ErrorResponse {
  code: string;
  details?: Record<string, unknown>;
}

interface GetResponse {
  preferences: AccessibilityPreferences;
  updatedAt: string;
}

interface PutResponse {
  accepted: boolean;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

const mockUserStore = new Map<string, { email: string; username: string; publicKey: Uint8Array }>();

function createTestApp(db: ReturnType<typeof createDb>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);

    const testUserId = c.req.header('X-Test-User-Id');
    if (testUserId) {
      const userInfo = mockUserStore.get(testUserId);
      if (userInfo) {
        const sessionData: SessionData = {
          sessionId: `session-${testUserId}`,
          userId: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: userInfo.publicKey,
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
    } else {
      c.set('user', null);
      c.set('session', null);
      c.set('sessionData', null);
    }
    await next();
  });
  app.route('/user-preferences', userPreferencesRoute);
  return app;
}

async function createTestUser(
  db: ReturnType<typeof createDb>,
  email: string,
  username: string
): Promise<string> {
  const userData = userFactory.build({ email, username, emailVerified: true });
  const [user] = await db.insert(users).values(userData).returning();
  if (!user) throw new Error('Failed to create test user');
  mockUserStore.set(user.id, { email, username, publicKey: user.publicKey });
  return user.id;
}

function authHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId, 'Content-Type': 'application/json' };
}

describe('user-preferences routes', () => {
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  const RUN_ID = String(Date.now());
  const cleanupUserIds: string[] = [];
  let nextUserCounter = 0;

  async function freshUser(): Promise<string> {
    const counter = String(nextUserCounter++);
    const userId = await createTestUser(
      db,
      `prefs-${RUN_ID}-${counter}@test.com`,
      `up_${RUN_ID.slice(-6)}_${counter}`
    );
    cleanupUserIds.push(userId);
    return userId;
  }

  beforeAll(() => {
    db = createDb({ connectionString: DATABASE_URL!, neonDev: LOCAL_NEON_DEV_CONFIG });
    app = createTestApp(db);
  });

  afterAll(async () => {
    if (cleanupUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, cleanupUserIds));
    }
    for (const id of cleanupUserIds) mockUserStore.delete(id);
  });

  describe('GET /accessibility', () => {
    it('returns defaults for a fresh user', async () => {
      const userId = await freshUser();

      const res = await app.request('/user-preferences/accessibility', {
        headers: authHeaders(userId),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as GetResponse;
      expect(body.preferences).toEqual(ACCESSIBILITY_PREFERENCES_DEFAULTS);
      expect(typeof body.updatedAt).toBe('string');
      // ISO 8601 string must parse to a Date
      expect(Number.isFinite(new Date(body.updatedAt).getTime())).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/user-preferences/accessibility');

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorResponse;
      expect(body.code).toBe('UNAUTHORIZED');
    });

    it('returns 404 USER_NOT_FOUND when the session points at a deleted user', async () => {
      // Simulate a stale session: register a user in the in-memory store so the
      // middleware sets `c.get('user')`, but never insert the corresponding row
      // in the DB. The handler's defensive lookup must catch this.
      const ghostId = `00000000-0000-7000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
      mockUserStore.set(ghostId, {
        email: 'ghost@test.com',
        username: 'ghost_user',
        publicKey: new Uint8Array(32),
      });
      try {
        const res = await app.request('/user-preferences/accessibility', {
          headers: authHeaders(ghostId),
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as ErrorResponse;
        expect(body.code).toBe('USER_NOT_FOUND');
      } finally {
        mockUserStore.delete(ghostId);
      }
    });
  });

  describe('PUT /accessibility', () => {
    it('updates preferences when client timestamp is newer than DB', async () => {
      const userId = await freshUser();

      // Anchor at NOW + 1s (DB was defaulted to row creation time on insert).
      const futureTs = new Date(Date.now() + 1000).toISOString();
      const updated: AccessibilityPreferences = {
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        fontFamily: 'atkinson',
      };

      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: updated, updatedAt: futureTs }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as PutResponse;
      expect(body.accepted).toBe(true);

      // Verify DB row was updated
      const row = await db
        .select({
          prefs: users.accessibilityPreferences,
          updatedAt: users.accessibilityPreferencesUpdatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .then((r) => r[0]);
      expect(row?.prefs.contrast).toBe('high');
      expect(row?.prefs.fontFamily).toBe('atkinson');
      expect(row?.updatedAt.toISOString()).toBe(futureTs);
    });

    it('does NOT update when client timestamp is older than DB (returns accepted=false)', async () => {
      const userId = await freshUser();

      // Set DB timestamp to "now"
      const dbTs = new Date();
      await db
        .update(users)
        .set({
          accessibilityPreferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
          accessibilityPreferencesUpdatedAt: dbTs,
        })
        .where(eq(users.id, userId));

      // Try to PUT with an older timestamp
      const olderTs = new Date(dbTs.getTime() - 60_000).toISOString();
      const stalePrefs: AccessibilityPreferences = {
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'low',
      };

      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: stalePrefs, updatedAt: olderTs }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as PutResponse;
      expect(body.accepted).toBe(false);

      // Verify DB row was NOT changed — still has the dark theme.
      const row = await db
        .select({
          prefs: users.accessibilityPreferences,
          updatedAt: users.accessibilityPreferencesUpdatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .then((r) => r[0]);
      expect(row?.prefs.contrast).toBe('high');
      expect(row?.updatedAt.toISOString()).toBe(dbTs.toISOString());
    });

    it('rejects request body that fails Zod validation', async () => {
      const userId = await freshUser();

      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({
          preferences: { version: 1, contrast: 'mauve' }, // contrast is not a valid enum value
          updatedAt: new Date().toISOString(),
        }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects body with missing updatedAt', async () => {
      const userId = await freshUser();

      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects body with non-ISO updatedAt', async () => {
      const userId = await freshUser();

      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: 'not-a-date',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: new Date().toISOString(),
        }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrorResponse;
      expect(body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('end-to-end', () => {
    it('PUT then GET returns the put value', async () => {
      const userId = await freshUser();

      const ts = new Date(Date.now() + 1000).toISOString();
      const newPrefs: AccessibilityPreferences = {
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'increased',
        fontSize: '124',
        ttsEnabled: true,
      };

      const putRes = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: newPrefs, updatedAt: ts }),
      });
      expect(putRes.status).toBe(200);
      expect(((await putRes.json()) as PutResponse).accepted).toBe(true);

      const getRes = await app.request('/user-preferences/accessibility', {
        headers: authHeaders(userId),
      });
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as GetResponse;
      expect(body.preferences).toEqual(newPrefs);
      expect(body.updatedAt).toBe(ts);
    });

    it('PUT with same timestamp twice — LWW <= condition still accepts the replay (idempotent)', async () => {
      const userId = await freshUser();

      const ts = new Date(Date.now() + 1000).toISOString();
      const prefs: AccessibilityPreferences = {
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        muteSounds: true,
      };

      // First PUT.
      const first = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: prefs, updatedAt: ts }),
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as PutResponse).accepted).toBe(true);

      // Second PUT with the same timestamp — accepted=true (idempotent: <= comparison),
      // but the row content is unchanged, which is the safe-to-retry guarantee.
      const second = await app.request('/user-preferences/accessibility', {
        method: 'PUT',
        headers: authHeaders(userId),
        body: JSON.stringify({ preferences: prefs, updatedAt: ts }),
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as PutResponse).accepted).toBe(true);

      // Verify row state is exactly what we wrote.
      const row = await db
        .select({
          prefs: users.accessibilityPreferences,
          updatedAt: users.accessibilityPreferencesUpdatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .then((r) => r[0]);
      expect(row?.prefs.muteSounds).toBe(true);
      expect(row?.updatedAt.toISOString()).toBe(ts);
    });
  });
});
