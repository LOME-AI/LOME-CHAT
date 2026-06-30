import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, lte } from 'drizzle-orm';
import { users } from '@hushbox/db';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_USER_NOT_FOUND,
  accessibilityPreferencesSchema,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

/**
 * User-preferences routes.
 *
 * Storage strategy: client-side state is the user's source of truth (localStorage),
 * but authenticated users opt into cross-device sync by pushing their settings to
 * the DB. The server uses LWW (last-write-wins) on a companion timestamp column
 * so concurrent writes from multiple devices converge without coordination.
 *
 * Three layers of enforcement on the JSONB blob (per the accessibility plan):
 *  1. Wire — `zValidator` rejects malformed requests before the handler runs.
 *  2. Storage — Drizzle `.$type<>()` narrows what TypeScript can write to the column.
 *  3. Read — defensive `parse()` on every read fills any missing/legacy keys with
 *     the schema defaults so older blobs survive migrations transparently.
 */
export const userPreferencesRoute = new Hono<AppEnv>()
  .get('/accessibility', async (c) => {
    const user = c.get('user');
    if (!user) {
      return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
    }

    const db = c.get('db');
    const row = await db
      .select({
        prefs: users.accessibilityPreferences,
        updatedAt: users.accessibilityPreferencesUpdatedAt,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .then((r) => r[0]);

    if (!row) {
      return c.json(createErrorResponse(ERROR_CODE_USER_NOT_FOUND), 404);
    }

    // Defensive parse: legacy/partial blobs get defaults filled in by Zod.
    const preferences = accessibilityPreferencesSchema.parse(row.prefs);
    return c.json({ preferences, updatedAt: row.updatedAt.toISOString() }, 200);
  })
  .put(
    '/accessibility',
    zValidator(
      'json',
      z.object({
        preferences: accessibilityPreferencesSchema,
        updatedAt: z.iso.datetime(),
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }

      const db = c.get('db');
      const { preferences, updatedAt } = c.req.valid('json');
      const incomingTs = new Date(updatedAt);

      // Atomic conditional update: only writes when the client's timestamp is at
      // least as new as the row's. The `lte` (<=) means a replay with the same
      // timestamp is a no-op write but still reports `accepted=true` — this is
      // the CODE-RULES idempotency guarantee for safe-to-retry operations.
      const result = await db
        .update(users)
        .set({
          accessibilityPreferences: preferences,
          accessibilityPreferencesUpdatedAt: incomingTs,
        })
        .where(and(eq(users.id, user.id), lte(users.accessibilityPreferencesUpdatedAt, incomingTs)))
        .returning({ id: users.id });

      return c.json({ accepted: result.length > 0 }, 200);
    }
  );
