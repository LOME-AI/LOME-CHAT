import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, feedback, users } from '@hushbox/db';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  createFeedbackStores,
  getFeedbackById,
  listFeedbackForInbox,
  listFeedbackForUser,
  setFeedbackStatusWithinTx,
} from './stores.js';
import type { ResultAsync } from '../../../lib/result/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for feedback store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
let counter = 0;

/** Await a Result-async and unwrap it without an await-expression member access. */
async function unwrap<T>(r: ResultAsync<T, unknown>): Promise<T> {
  const result = await r;
  return result._unsafeUnwrap();
}

/** Unwrap an insert that must have landed a row (never deduped for these cases). */
async function insertRow(
  r: ResultAsync<{ readonly id: string } | null, unknown>
): Promise<{ readonly id: string }> {
  const row = await unwrap(r);
  if (row === null) throw new Error('feedback insert unexpectedly deduped');
  return row;
}

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `fbstore${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@feedback-store.test`,
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

async function setStatus(
  feedbackId: string,
  status: 'triaged' | 'resolved' | 'wont_fix' | 'spam'
): Promise<void> {
  const result = await runSettlement(db, async (tx) =>
    setFeedbackStatusWithinTx(tx, { feedbackId, status })
  );
  result._unsafeUnwrap();
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // The `feedback` FK cascades on user delete, so removing the seeded users
    // reclaims their rows.
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('createFeedbackStores.insert', () => {
  it('persists one row with the given kind and body, defaulted to status new', async () => {
    const userId = await seedUser();
    const { id } = await insertRow(
      createFeedbackStores(db).insert(userId, { kind: 'bug', body: 'boom' })
    );
    const [row] = await db.select().from(feedback).where(eq(feedback.id, id));
    expect(row?.userId).toBe(userId);
    expect(row?.kind).toBe('bug');
    expect(row?.body).toBe('boom');
    expect(row?.status).toBe('new');
  });
});

describe('createFeedbackStores.insert dedup', () => {
  it('returns null when an identical body exists for the user within the window', async () => {
    const userId = await seedUser();
    const store = createFeedbackStores(db);
    const first = await unwrap(store.insert(userId, { kind: 'bug', body: 'dupe body' }));
    expect(first).not.toBeNull();
    const second = await unwrap(store.insert(userId, { kind: 'bug', body: 'dupe body' }));
    expect(second).toBeNull();
    const rows = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(eq(feedback.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('inserts when the body differs from the recent one', async () => {
    const userId = await seedUser();
    const store = createFeedbackStores(db);
    await unwrap(store.insert(userId, { kind: 'bug', body: 'first note' }));
    const second = await unwrap(store.insert(userId, { kind: 'bug', body: 'second note' }));
    expect(second).not.toBeNull();
  });

  it('inserts an identical body for a different user', async () => {
    const userA = await seedUser();
    const userB = await seedUser();
    const store = createFeedbackStores(db);
    await unwrap(store.insert(userA, { kind: 'idea', body: 'shared idea' }));
    const other = await unwrap(store.insert(userB, { kind: 'idea', body: 'shared idea' }));
    expect(other).not.toBeNull();
  });

  it('inserts an identical body once the prior row is older than the window', async () => {
    const userId = await seedUser();
    // A row committed two hours ago sits outside the one-hour dedup window, so
    // the same body may be filed again.
    await db.insert(feedback).values({
      userId,
      kind: 'bug',
      body: 'aged body',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const again = await unwrap(
      createFeedbackStores(db).insert(userId, { kind: 'bug', body: 'aged body' })
    );
    expect(again).not.toBeNull();
  });
});

describe('setFeedbackStatusWithinTx', () => {
  it('flips the status and returns the prior status', async () => {
    const userId = await seedUser();
    const { id } = await insertRow(
      createFeedbackStores(db).insert(userId, { kind: 'idea', body: 'x' })
    );
    const result = await runSettlement(db, async (tx) =>
      setFeedbackStatusWithinTx(tx, { feedbackId: id, status: 'triaged' })
    );
    expect(result._unsafeUnwrap().priorStatus).toBe('new');
    const [row] = await db.select().from(feedback).where(eq(feedback.id, id));
    expect(row?.status).toBe('triaged');
  });

  it('returns not_found for an unknown feedback id', async () => {
    const result = await runSettlement(db, async (tx) =>
      setFeedbackStatusWithinTx(tx, { feedbackId: crypto.randomUUID(), status: 'spam' })
    );
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

// The inbox read is global (all users), so each case uses a status value no
// other test in the suite writes — `feedback` is a new table and only these
// tests set these triage statuses — keeping the assertions deterministic under
// parallel test files.
describe('listFeedbackForInbox', () => {
  it('returns rows newest-first with a truncated body preview', async () => {
    const userId = await seedUser();
    const store = createFeedbackStores(db);
    const { id: firstId } = await insertRow(store.insert(userId, { kind: 'bug', body: 'first' }));
    const { id: secondId } = await insertRow(
      store.insert(userId, { kind: 'praise', body: 'z'.repeat(300) })
    );
    await setStatus(firstId, 'spam');
    await setStatus(secondId, 'spam');
    const page = await unwrap(listFeedbackForInbox(db, { status: 'spam', limit: 50 }));
    const newest = page.rows[0];
    expect(newest?.id).toBe(secondId);
    expect(newest?.bodyPreview).toBe('z'.repeat(140));
    expect(newest?.bodyPreview.length).toBe(140);
  });

  it('pages through with nextCursor and filters by status', async () => {
    const userId = await seedUser();
    const store = createFeedbackStores(db);
    const first = await insertRow(store.insert(userId, { kind: 'bug', body: 'a' }));
    const second = await insertRow(store.insert(userId, { kind: 'bug', body: 'b' }));
    await setStatus(first.id, 'wont_fix');
    await setStatus(second.id, 'wont_fix');

    const pageOne = await unwrap(listFeedbackForInbox(db, { status: 'wont_fix', limit: 1 }));
    expect(pageOne.rows).toHaveLength(1);
    expect(pageOne.rows[0]?.id).toBe(second.id);
    expect(pageOne.nextCursor).toBe(second.id);

    const pageTwo = await unwrap(
      listFeedbackForInbox(db, { status: 'wont_fix', limit: 1, cursor: second.id })
    );
    expect(pageTwo.rows[0]?.id).toBe(first.id);
  });

  it('reports a null nextCursor when the page is not full', async () => {
    const userId = await seedUser();
    const { id } = await insertRow(
      createFeedbackStores(db).insert(userId, { kind: 'idea', body: 'lone' })
    );
    await setStatus(id, 'resolved');
    const page = await unwrap(listFeedbackForInbox(db, { status: 'resolved', limit: 500 }));
    expect(page.nextCursor).toBeNull();
  });

  it('reads across every status when no status filter is given', async () => {
    const page = await unwrap(listFeedbackForInbox(db, { limit: 1 }));
    expect(Array.isArray(page.rows)).toBe(true);
  });
});

describe('feedback store query failures', () => {
  it('maps a rejected query (malformed uuid) to an unavailable error', async () => {
    const result = await getFeedbackById(db, 'not-a-uuid');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('getFeedbackById', () => {
  it('returns the full detail for an existing row', async () => {
    const userId = await seedUser();
    const { id } = await insertRow(
      createFeedbackStores(db).insert(userId, { kind: 'praise', body: 'full body' })
    );
    const detail = await unwrap(getFeedbackById(db, id));
    expect(detail?.body).toBe('full body');
    expect(detail?.kind).toBe('praise');
    expect(detail?.userId).toBe(userId);
  });

  it('returns null for an unknown id', async () => {
    const detail = await unwrap(getFeedbackById(db, crypto.randomUUID()));
    expect(detail).toBeNull();
  });
});

describe('listFeedbackForUser', () => {
  it('returns the user rows newest-first', async () => {
    const userId = await seedUser();
    const store = createFeedbackStores(db);
    await unwrap(store.insert(userId, { kind: 'bug', body: 'one' }));
    const { id: newest } = await insertRow(store.insert(userId, { kind: 'idea', body: 'two' }));
    const rows = await unwrap(listFeedbackForUser(db, userId));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(newest);
  });
});
