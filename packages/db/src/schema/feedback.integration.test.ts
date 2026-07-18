import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { userFactory } from '../factories';
import { feedback, users } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

let db: Database;
const insertedUserIds: string[] = [];

async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  insertedUserIds.push(row.id);
  return row.id;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}, 60_000);

afterAll(async () => {
  // Deleting the user cascades its feedback rows away, keeping local reruns clean.
  for (const id of insertedUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
  await db.$client.end();
});

describe('feedback table', () => {
  it('inserts a valid row and populates id and both timestamps', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(feedback)
      .values({ userId, kind: 'bug', status: 'triaged', body: 'it broke' })
      .returning();
    if (!row) throw new Error('feedback insert returned no row');
    expect(row.userId).toBe(userId);
    expect(row.kind).toBe('bug');
    expect(row.status).toBe('triaged');
    expect(row.body).toBe('it broke');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("defaults status to 'new' when omitted", async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(feedback)
      .values({ userId, kind: 'idea', body: 'add dark mode' })
      .returning();
    if (!row) throw new Error('feedback insert returned no row');
    expect(row.status).toBe('new');
  });

  it('removes feedback rows when their user is deleted (cascade)', async () => {
    const userId = await insertUser();
    const [row] = await db
      .insert(feedback)
      .values({ userId, kind: 'praise', body: 'love it' })
      .returning({ id: feedback.id });
    if (!row) throw new Error('feedback insert returned no row');

    await db.delete(users).where(eq(users.id, userId));

    const after = await db.select().from(feedback).where(eq(feedback.id, row.id));
    expect(after).toHaveLength(0);
  });

  it('rejects a kind outside FEEDBACK_KINDS', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db.execute(
        sql`insert into feedback (user_id, kind, body) values (${userId}::uuid, 'complaint', 'nope')`
      )
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects a status outside FEEDBACK_STATUSES', async () => {
    const userId = await insertUser();
    const error = await captureError(
      db.execute(
        sql`insert into feedback (user_id, kind, status, body) values (${userId}::uuid, 'bug', 'archived', 'nope')`
      )
    );
    expect(error).toBeInstanceOf(Error);
  });
});
