import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { userFactory } from '../factories';
import { newsletterDeliveries, newsletterIssues, newsletterSubscribers, users } from './index';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle'
);

let db: Database;
const insertedSubscriberIds: string[] = [];
const insertedIssueIds: string[] = [];

let tokenCounter = 0;

function subscriberValues(
  overrides: Partial<typeof newsletterSubscribers.$inferInsert> = {}
): typeof newsletterSubscribers.$inferInsert {
  tokenCounter += 1;
  return {
    email: `sub-${String(tokenCounter)}-${String(Date.now())}@example.com`,
    status: 'pending',
    consentSource: 'marketing_site',
    consentIp: '203.0.113.7',
    consentTextVersion: '2026-07-17',
    unsubscribeToken: `unsub-${String(tokenCounter)}-${String(Date.now())}`,
    ...overrides,
  };
}

async function insertSubscriber(
  overrides: Partial<typeof newsletterSubscribers.$inferInsert> = {}
): Promise<string> {
  const [row] = await db
    .insert(newsletterSubscribers)
    .values(subscriberValues(overrides))
    .returning({ id: newsletterSubscribers.id });
  if (!row) throw new Error('subscriber insert returned no row');
  insertedSubscriberIds.push(row.id);
  return row.id;
}

async function insertIssue(): Promise<string> {
  const [row] = await db
    .insert(newsletterIssues)
    .values({
      subject: 'Launch notes',
      bodyMarkdown: '# Hello',
      status: 'scheduled',
      scheduledAt: new Date(),
      createdBy: 'admin@example.com',
    })
    .returning({ id: newsletterIssues.id });
  if (!row) throw new Error('issue insert returned no row');
  insertedIssueIds.push(row.id);
  return row.id;
}

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(' | ');
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
  // Deliveries reference issues and subscribers with delete-blocking FKs, so
  // they must go first for local reruns to stay clean.
  for (const id of insertedIssueIds) {
    await db.delete(newsletterDeliveries).where(eq(newsletterDeliveries.issueId, id));
  }
  for (const id of insertedIssueIds) {
    await db.delete(newsletterIssues).where(eq(newsletterIssues.id, id));
  }
  for (const id of insertedSubscriberIds) {
    await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, id));
  }
  await db.$client.end();
});

describe('newsletter_subscribers table', () => {
  it('inserts a valid row, defaulting topic and populating id and createdAt', async () => {
    const values = subscriberValues();
    const [row] = await db.insert(newsletterSubscribers).values(values).returning();
    if (!row) throw new Error('subscriber insert returned no row');
    insertedSubscriberIds.push(row.id);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.topic).toBe('general');
    expect(row.status).toBe('pending');
    expect(row.consentSource).toBe('marketing_site');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.confirmedAt).toBeNull();
    expect(row.suppressReason).toBeNull();
  });

  it('rejects a second row for the same email and topic', async () => {
    const values = subscriberValues();
    await db.insert(newsletterSubscribers).values(values).returning();
    const inserted = await db
      .select({ id: newsletterSubscribers.id })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, values.email));
    insertedSubscriberIds.push(...inserted.map((r) => r.id));

    const error = await captureError(
      db
        .insert(newsletterSubscribers)
        .values(
          subscriberValues({ email: values.email, unsubscribeToken: `other-${String(Date.now())}` })
        )
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('allows the same email on a different topic', async () => {
    const values = subscriberValues();
    await insertSubscriber({ email: values.email });
    const secondId = await insertSubscriber({
      email: values.email,
      topic: 'security',
      unsubscribeToken: `topic2-${String(Date.now())}`,
    });
    expect(secondId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a duplicate unsubscribeToken', async () => {
    const values = subscriberValues();
    await insertSubscriber({ unsubscribeToken: values.unsubscribeToken });
    const error = await captureError(
      db
        .insert(newsletterSubscribers)
        .values(subscriberValues({ unsubscribeToken: values.unsubscribeToken }))
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('rejects a duplicate confirmToken', async () => {
    const confirmToken = `confirm-${String(Date.now())}`;
    await insertSubscriber({ confirmToken });
    const error = await captureError(
      db.insert(newsletterSubscribers).values(subscriberValues({ confirmToken }))
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('severs the user link on user deletion (SET NULL), keeping the subscription', async () => {
    const [userRow] = await db
      .insert(users)
      .values(userFactory.build())
      .returning({ id: users.id });
    if (!userRow) throw new Error('user insert returned no row');
    const subscriberId = await insertSubscriber({ userId: userRow.id });

    await db.delete(users).where(eq(users.id, userRow.id));

    const [after] = await db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.id, subscriberId));
    if (!after) throw new Error('subscriber vanished with its user');
    expect(after.userId).toBeNull();
  });

  it('rejects a status outside NEWSLETTER_STATUSES', async () => {
    const error = await captureError(
      db.execute(
        sql`insert into newsletter_subscribers
              (email, status, consent_source, consent_ip, consent_text_version, unsubscribe_token)
            values ('bad-status@example.com', 'paused', 'marketing_site', '203.0.113.7', 'v1', 'bad-status-token')`
      )
    );
    expect(error).toBeInstanceOf(Error);
    expect(errorChainText(error)).toMatch(/invalid input value for enum/i);
  });
});

describe('newsletter_issues table', () => {
  it('inserts a valid row and populates id and createdAt', async () => {
    const id = await insertIssue();
    const [row] = await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, id));
    if (!row) throw new Error('issue not found');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('scheduled');
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.sentAt).toBeNull();
    expect(row.recipientCount).toBeNull();
  });

  it('rejects a status outside NEWSLETTER_ISSUE_STATUSES', async () => {
    const error = await captureError(
      db.execute(
        sql`insert into newsletter_issues (subject, body_markdown, status, scheduled_at, created_by)
            values ('s', 'b', 'draft', now(), 'admin@example.com')`
      )
    );
    expect(error).toBeInstanceOf(Error);
    expect(errorChainText(error)).toMatch(/invalid input value for enum/i);
  });
});

describe('newsletter_deliveries table', () => {
  it('inserts a valid row keyed to an issue and a subscriber', async () => {
    const issueId = await insertIssue();
    const subscriberId = await insertSubscriber();
    const [row] = await db
      .insert(newsletterDeliveries)
      .values({ issueId, subscriberId, status: 'claimed' })
      .returning();
    if (!row) throw new Error('delivery insert returned no row');
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.status).toBe('claimed');
    expect(row.resendEmailId).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('rejects a second delivery for the same issue and subscriber', async () => {
    const issueId = await insertIssue();
    const subscriberId = await insertSubscriber();
    await db.insert(newsletterDeliveries).values({ issueId, subscriberId, status: 'claimed' });
    const error = await captureError(
      db.insert(newsletterDeliveries).values({ issueId, subscriberId, status: 'sent' })
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('blocks deleting an issue that has deliveries (delivery rows are kept forever)', async () => {
    const issueId = await insertIssue();
    const subscriberId = await insertSubscriber();
    await db.insert(newsletterDeliveries).values({ issueId, subscriberId, status: 'sent' });
    const error = await captureError(
      db.delete(newsletterIssues).where(eq(newsletterIssues.id, issueId))
    );
    expect(error).toBeInstanceOf(Error);
  });

  it('blocks deleting a subscriber that has deliveries', async () => {
    const issueId = await insertIssue();
    const subscriberId = await insertSubscriber();
    await db.insert(newsletterDeliveries).values({ issueId, subscriberId, status: 'failed' });
    const error = await captureError(
      db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, subscriberId))
    );
    expect(error).toBeInstanceOf(Error);
  });
});
