import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getIronSession } from 'iron-session';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { ERROR_CODE_LOGIN_TOKEN_INVALID, ERROR_CODE_SERVER_MISCONFIGURED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { redisGet, redisSet } from '../lib/redis-registry.js';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import type { AppEnv } from '../types.js';

export const tokenLoginRoute = new Hono<AppEnv>().post(
  '/',
  zValidator('json', z.object({ token: z.uuid() })),
  async (c) => {
    // Fail-fast on missing IRON_SESSION_SECRET BEFORE any I/O — a misconfigured
    // deployment must surface 500 immediately, not after wasting a Redis read
    // and DB query. Matches the pattern in routes/dev.ts:208-213.
    const sessionSecret = c.env.IRON_SESSION_SECRET;
    if (!sessionSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const { token } = c.req.valid('json');
    const redis = c.get('redis');
    const db = c.get('db');

    const tokenData = await redisGet(redis, 'billingLoginToken', token);
    if (!tokenData) {
      return c.json(createErrorResponse(ERROR_CODE_LOGIN_TOKEN_INVALID), 401);
    }

    // Token expires via TTL (60s) — no immediate delete.
    // This makes the endpoint idempotent: retries from StrictMode double-fire,
    // page reloads, or network retries all succeed within the TTL window.

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        emailVerified: users.emailVerified,
        totpEnabled: users.totpEnabled,
        hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
      })
      .from(users)
      .where(eq(users.id, tokenData.userId));

    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_LOGIN_TOKEN_INVALID), 401);
    }

    const { isProduction } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProduction)
    );

    // Derive deterministic session ID from token so retries within the TTL
    // window produce the same session (no orphaned sessionActive entries).
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const h = [...new Uint8Array(hashBuffer.slice(0, 16))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    session.sessionId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    session.userId = user.id;
    session.email = user.email;
    session.username = user.username;
    session.emailVerified = user.emailVerified;
    session.totpEnabled = user.totpEnabled;
    session.hasAcknowledgedPhrase = user.hasAcknowledgedPhrase;
    session.pending2FA = false;
    session.pending2FAExpiresAt = 0;
    session.createdAt = Date.now();
    session.billingOnly = true;

    await session.save();

    await redisSet(redis, 'sessionActive', '1', user.id, session.sessionId);

    return c.json({ success: true }, 200);
  }
);
