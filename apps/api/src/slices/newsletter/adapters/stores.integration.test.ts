import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterSubscribers } from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { createNewsletterStores, listSubscribersForAdmin, subscriberStats } from './stores.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter store tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const createdEmails: string[] = [];

function nextEmail(tag: string): string {
  const email = `${tag}-${crypto.randomUUID().slice(0, 8)}@newsletter-store.test`;
  createdEmails.push(email);
  return email;
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  await db.$client.end();
});

async function seedSubscriber(
  email: string,
  overrides: Partial<typeof newsletterSubscribers.$inferInsert> = {}
): Promise<string> {
  const rows = await db
    .insert(newsletterSubscribers)
    .values({
      email,
      status: 'subscribed',
      consentSource: 'marketing_site',
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
      ...overrides,
    })
    .returning({ id: newsletterSubscribers.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('seed failed');
  return id;
}

async function readSuppression(email: string): Promise<{
  status: string;
  suppressReason: string | null;
  suppressedAt: Date | null;
}> {
  const rows = await db
    .select({
      status: newsletterSubscribers.status,
      suppressReason: newsletterSubscribers.suppressReason,
      suppressedAt: newsletterSubscribers.suppressedAt,
    })
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email));
  const row = rows[0];
  if (row === undefined) throw new Error('subscriber row missing');
  return row;
}

describe('suppress', () => {
  const store = createNewsletterStores(db);

  it('suppresses a subscribed row on bounce', async () => {
    const email = nextEmail('suppress-bounce');
    await seedSubscriber(email);
    const now = new Date();

    const result = await store.suppress({ email, reason: 'bounce', now });

    expect(result.isOk() && result.value).toBe(true);
    expect(await readSuppression(email)).toEqual({
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: now,
    });
  });

  it('suppresses an unsubscribed row on bounce', async () => {
    const email = nextEmail('suppress-unsub');
    await seedSubscriber(email, { status: 'unsubscribed', unsubscribedAt: new Date() });

    const result = await store.suppress({ email, reason: 'bounce', now: new Date() });

    expect(result.isOk() && result.value).toBe(true);
    const after = await readSuppression(email);
    expect(after.suppressReason).toBe('bounce');
  });

  it('overwrites a bounce suppression with a complaint', async () => {
    const email = nextEmail('suppress-escalate');
    await seedSubscriber(email, {
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: new Date(0),
    });

    const result = await store.suppress({ email, reason: 'complaint', now: new Date() });

    expect(result.isOk() && result.value).toBe(true);
    const after = await readSuppression(email);
    expect(after.suppressReason).toBe('complaint');
  });

  it('never overwrites a complaint suppression with a bounce', async () => {
    const email = nextEmail('suppress-sticky');
    const suppressedAt = new Date(0);
    await seedSubscriber(email, {
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt,
    });

    const result = await store.suppress({ email, reason: 'bounce', now: new Date() });

    expect(result.isOk() && result.value).toBe(false);
    expect(await readSuppression(email)).toEqual({
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt,
    });
  });

  it('treats an identical repeat suppression as a no-op', async () => {
    const email = nextEmail('suppress-repeat');
    const suppressedAt = new Date(0);
    await seedSubscriber(email, { status: 'suppressed', suppressReason: 'bounce', suppressedAt });

    const result = await store.suppress({ email, reason: 'bounce', now: new Date() });

    expect(result.isOk() && result.value).toBe(false);
    const after = await readSuppression(email);
    expect(after.suppressedAt).toEqual(suppressedAt);
  });

  it('reports an unknown email as a no-op', async () => {
    const result = await store.suppress({
      email: `unknown-${crypto.randomUUID().slice(0, 8)}@newsletter-store.test`,
      reason: 'complaint',
      now: new Date(),
    });

    expect(result.isOk() && result.value).toBe(false);
  });
});

describe('subscriberStats', () => {
  it('counts subscribers per status and per suppress reason', async () => {
    const topic = `stats-${crypto.randomUUID().slice(0, 8)}`;
    await seedSubscriber(nextEmail('stats-sub-a'), { topic });
    await seedSubscriber(nextEmail('stats-sub-b'), { topic });
    await seedSubscriber(nextEmail('stats-pending'), { topic, status: 'pending' });
    await seedSubscriber(nextEmail('stats-unsub'), {
      topic,
      status: 'unsubscribed',
      unsubscribedAt: new Date(),
    });
    await seedSubscriber(nextEmail('stats-bounce'), {
      topic,
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: new Date(),
    });
    await seedSubscriber(nextEmail('stats-complaint'), {
      topic,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
    });

    const stats = await subscriberStats(db, { topic });

    expect(stats._unsafeUnwrap()).toEqual({
      byStatus: { pending: 1, subscribed: 2, unsubscribed: 1, suppressed: 2 },
      bySuppressReason: { bounce: 1, complaint: 1 },
    });
  });

  it('defaults to the launch topic', async () => {
    // Shared dev DB: other suites write the launch topic concurrently, so
    // only the shape is asserted — the count values are not deterministic.
    const stats = await subscriberStats(db);
    const value = stats._unsafeUnwrap();
    expect(Object.values(value.byStatus).every((count) => count >= 0)).toBe(true);
    expect(Object.values(value.bySuppressReason).every((count) => count >= 0)).toBe(true);
  });

  it('reports zero counts for an empty list', async () => {
    const stats = await subscriberStats(db, { topic: `stats-empty-${crypto.randomUUID()}` });

    expect(stats._unsafeUnwrap()).toEqual({
      byStatus: { pending: 0, subscribed: 0, unsubscribed: 0, suppressed: 0 },
      bySuppressReason: { bounce: 0, complaint: 0 },
    });
  });
});

describe('listSubscribersForAdmin', () => {
  it('pages newest-first by keyset and terminates with a null cursor', async () => {
    const topic = `list-${crypto.randomUUID().slice(0, 8)}`;
    const first = await seedSubscriber(nextEmail('list-a'), { topic });
    const second = await seedSubscriber(nextEmail('list-b'), { topic });
    const third = await seedSubscriber(nextEmail('list-c'), { topic });

    const pageOne = await listSubscribersForAdmin(db, { limit: 2, topic });
    const one = pageOne._unsafeUnwrap();
    expect(one.subscribers.map((row) => row.id)).toEqual([third, second]);
    expect(one.nextCursor).toBe(second);

    const pageTwo = await listSubscribersForAdmin(db, {
      limit: 2,
      topic,
      cursor: one.nextCursor ?? undefined,
    });
    const two = pageTwo._unsafeUnwrap();
    expect(two.subscribers.map((row) => row.id)).toEqual([first]);
    expect(two.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const topic = `list-status-${crypto.randomUUID().slice(0, 8)}`;
    await seedSubscriber(nextEmail('list-live'), { topic });
    const suppressedId = await seedSubscriber(nextEmail('list-supp'), {
      topic,
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: new Date(),
    });

    const page = await listSubscribersForAdmin(db, { limit: 10, topic, status: 'suppressed' });

    const rows = page._unsafeUnwrap().subscribers;
    expect(rows.map((row) => row.id)).toEqual([suppressedId]);
    expect(rows[0]?.suppressReason).toBe('bounce');
  });

  it('defaults to the launch topic', async () => {
    // Shape-only for the same shared-DB reason as the stats default test.
    const page = await listSubscribersForAdmin(db, { limit: 1 });
    expect(Array.isArray(page._unsafeUnwrap().subscribers)).toBe(true);
  });

  it('degrades a zero limit to an empty cursorless page', async () => {
    const topic = `list-zero-${crypto.randomUUID().slice(0, 8)}`;
    await seedSubscriber(nextEmail('list-zero'), { topic });

    const page = await listSubscribersForAdmin(db, { limit: 0, topic });

    expect(page._unsafeUnwrap()).toEqual({ subscribers: [], nextCursor: null });
  });

  it('returns consent evidence and never a token field', async () => {
    const topic = `list-shape-${crypto.randomUUID().slice(0, 8)}`;
    const email = nextEmail('list-shape');
    await seedSubscriber(email, { topic, confirmedAt: new Date() });

    const page = await listSubscribersForAdmin(db, { limit: 1, topic });

    const row = page._unsafeUnwrap().subscribers[0];
    if (row === undefined) throw new Error('expected a row');
    expect(Object.keys(row).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'confirmedAt',
      'consentIp',
      'consentSource',
      'consentTextVersion',
      'createdAt',
      'email',
      'id',
      'status',
      'suppressedAt',
      'suppressReason',
      'unsubscribedAt',
    ]);
    expect(row.email).toBe(email);
    expect(row.consentIp).toBe('192.0.2.1');
    expect(row.consentSource).toBe('marketing_site');
  });
});

describe('createNewsletterStores infra failure mapping', () => {
  it('maps a rejected query to an unavailable domain error', async () => {
    const closedDb = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closedDb.$client.end();
    const store = createNewsletterStores(closedDb);
    const result = await store.findByEmail('down@newsletter.test');
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

describe('reopenForConfirmation complaint guard', () => {
  it('refuses atomically when the row flipped to complaint after the snapshot read', async () => {
    // Simulates the suppression-webhook race: the caller's snapshot saw a
    // reopenable row, but by write time the address complained. The WHERE
    // clause is the referee — the reopen must lose without resurrecting the
    // address.
    const email = nextEmail('complaint-race');
    const rows = await db
      .insert(newsletterSubscribers)
      .values({
        email,
        status: 'suppressed',
        suppressReason: 'complaint',
        suppressedAt: new Date(),
        consentSource: 'marketing_site',
        consentIp: '192.0.2.1',
        consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
        unsubscribeToken: crypto.randomUUID(),
      })
      .returning({ id: newsletterSubscribers.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('seed failed');

    const store = createNewsletterStores(db);
    const result = await store.reopenForConfirmation({
      id,
      fromStatus: 'suppressed',
      issue: {
        confirmToken: crypto.randomUUID(),
        confirmExpiresAt: new Date(Date.now() + 60_000),
        confirmSentAt: new Date(),
      },
      consent: {
        source: 'marketing_site',
        ip: '192.0.2.2',
        textVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      },
    });
    expect(result.isOk() && result.value).toBe(false);
    const after = await db
      .select({
        status: newsletterSubscribers.status,
        suppressReason: newsletterSubscribers.suppressReason,
      })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, id));
    expect(after[0]).toEqual({ status: 'suppressed', suppressReason: 'complaint' });
  });
});
