import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  jobs,
  newsletterDeliveries,
  newsletterIssues,
  newsletterSubscribers,
} from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { createJobRegistry } from '../../../lib/jobs/index.js';
import { errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createMockEmailSender } from '../../notifications/index.js';
import { createNewsletterDispatchStores } from '../adapters/dispatch-stores.js';
import { createNewsletterStores } from '../adapters/stores.js';
import { createIssueWithinTx } from '../adapters/issue-stores.js';
import {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  enqueueIssueDispatch,
  newsletterDispatchPayloadSchema,
} from './dispatch.js';
import type { z } from 'zod';
import type { JobExecution, JobOutcome } from '../../../lib/jobs/index.js';
import type { BatchEmailSender, MockEmailSender } from '../../notifications/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter dispatch tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const URLS = { apiUrl: 'https://api.hushbox.ai', frontendUrl: 'https://hushbox.ai' };

// The dev database is shared with concurrent suites that seed live
// `subscribed` rows on the launch topic — and this suite's own tests would
// couple through one topic's subscriber pool. A fresh topic per test keeps
// every recipient load deterministic (the handler's topic is deps-bound).
function nextTopic(): string {
  return `dispatch-test-${crypto.randomUUID().slice(0, 8)}`;
}

const createdIssueIds: string[] = [];
const createdEmails: string[] = [];
const createdJobIds: string[] = [];

type Payload = z.infer<typeof newsletterDispatchPayloadSchema>;

function executionOf(payload: Payload): JobExecution<Payload> {
  return {
    jobId: crypto.randomUUID(),
    payload,
    claims: 1,
    heartbeat: () => Promise.resolve('alive'),
    completeWithinTx: () => {
      throw new Error('natural-class handler must not write its own terminal transition');
    },
  };
}

async function seedIssue(overrides: { scheduledAt?: Date; status?: string } = {}): Promise<string> {
  const issue = await db.transaction((tx) =>
    createIssueWithinTx(tx, {
      subject: 'Dispatch issue',
      bodyMarkdown: 'Body **bold**',
      scheduledAt: overrides.scheduledAt ?? new Date(Date.now() - 60_000),
      createdBy: 'admin@hushbox.ai',
    })
  );
  createdIssueIds.push(issue.id);
  if (overrides.status !== undefined && overrides.status !== 'scheduled') {
    await db
      .update(newsletterIssues)
      .set({ status: overrides.status as 'canceled' | 'sending' | 'sent' })
      .where(eq(newsletterIssues.id, issue.id));
  }
  return issue.id;
}

async function seedSubscribers(
  topic: string,
  count: number,
  status: 'subscribed' | 'unsubscribed' | 'suppressed' | 'pending' = 'subscribed'
): Promise<{ id: string; email: string }[]> {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const email = `dispatch-${status}-${String(index)}-${crypto.randomUUID().slice(0, 8)}@newsletter-dispatch.test`;
    createdEmails.push(email);
    rows.push({
      email,
      status,
      topic,
      consentSource: 'marketing_site' as const,
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
    });
  }
  const inserted = await db
    .insert(newsletterSubscribers)
    .values(rows)
    .returning({ id: newsletterSubscribers.id, email: newsletterSubscribers.email });
  return inserted;
}

interface Handler {
  handler: (execution: JobExecution<Payload>) => Promise<JobOutcome>;
  sender: MockEmailSender;
}

function makeHandler(
  topic: string,
  options: { batchSize?: number; sender?: BatchEmailSender } = {}
): Handler {
  const sender = createMockEmailSender();
  const registration = createNewsletterDispatchJobRegistration({
    store: createNewsletterDispatchStores(db),
    sender: options.sender ?? sender,
    urls: URLS,
    topic,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
  });
  return { handler: registration.handler, sender };
}

/** Drives the handler through yields exactly as the dispatcher would. */
async function runToTerminal(
  handlerOf: () => Handler['handler'],
  issueId: string
): Promise<JobOutcome> {
  let payload: Payload = { issueId, nextBatchIndex: 0 };
  for (;;) {
    const outcome = await handlerOf()(executionOf(payload));
    if (outcome.kind !== 'yield') return outcome;
    payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
  }
}

async function deliveryRows(
  issueId: string
): Promise<{ subscriberId: string; status: string; resendEmailId: string | null }[]> {
  return db
    .select({
      subscriberId: newsletterDeliveries.subscriberId,
      status: newsletterDeliveries.status,
      resendEmailId: newsletterDeliveries.resendEmailId,
    })
    .from(newsletterDeliveries)
    .where(eq(newsletterDeliveries.issueId, issueId));
}

async function issueRow(issueId: string): Promise<typeof newsletterIssues.$inferSelect> {
  const rows = await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId));
  const row = rows[0];
  if (row === undefined) throw new Error('issue row missing');
  return row;
}

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await db
      .delete(newsletterDeliveries)
      .where(inArray(newsletterDeliveries.issueId, createdIssueIds));
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, createdIssueIds));
  }
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  if (createdJobIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
  }
  await db.$client.end();
});

describe('newsletter.dispatch.v1 registration', () => {
  it('registers on the bulk shard with natural idempotency and its payload schema', () => {
    const registry = createJobRegistry();
    const { sender } = makeHandler(nextTopic());
    registry.register(
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        sender,
        urls: URLS,
      })
    );

    const registered = registry.get(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(registered?.shard).toBe('bulk');
    expect(registered?.idempotency).toBe('natural');
    expect(registered?.schema).toBe(newsletterDispatchPayloadSchema);
  });

  it('defaults nextBatchIndex to zero in the payload schema', () => {
    const parsed = newsletterDispatchPayloadSchema.parse({ issueId: crypto.randomUUID() });
    expect(parsed.nextBatchIndex).toBe(0);
  });

  it('refuses a batch size over the provider cap', () => {
    const { sender } = makeHandler(nextTopic());
    expect(() =>
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        sender,
        urls: URLS,
        batchSize: 101,
      })
    ).toThrow(/batch/i);
  });
});

describe('enqueueIssueDispatch', () => {
  function registryWith(): ReturnType<typeof createJobRegistry> {
    const registry = createJobRegistry();
    registry.register(
      createNewsletterDispatchJobRegistration({
        store: createNewsletterDispatchStores(db),
        sender: createMockEmailSender(),
        urls: URLS,
      })
    );
    return registry;
  }

  it('inserts the jobs row in the caller transaction', async () => {
    const registry = registryWith();
    const scheduledAt = new Date(Date.now() + 3_600_000);
    const { issueId, jobId } = await db.transaction(async (tx) => {
      const issue = await createIssueWithinTx(tx, {
        subject: 'Enqueued issue',
        bodyMarkdown: 'body',
        scheduledAt,
        createdBy: 'admin@hushbox.ai',
      });
      const enqueued = await enqueueIssueDispatch(tx, registry, {
        issueId: issue.id,
        scheduledAt,
      });
      if (!enqueued.enqueued) throw new Error('expected enqueue');
      return { issueId: issue.id, jobId: enqueued.jobId };
    });
    createdIssueIds.push(issueId);
    createdJobIds.push(jobId);

    const rows = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(rows[0]?.type).toBe(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(rows[0]?.shard).toBe('bulk');
    expect(rows[0]?.payload).toEqual({ issueId, nextBatchIndex: 0 });
    expect(rows[0]?.scheduledAt).toEqual(scheduledAt);
  });

  it('rolls the issue and the job back together', async () => {
    const registry = registryWith();
    let issueId = '';
    let jobId = '';
    await db
      .transaction(async (tx) => {
        const issue = await createIssueWithinTx(tx, {
          subject: 'Rolled back issue',
          bodyMarkdown: 'body',
          scheduledAt: new Date(),
          createdBy: 'admin@hushbox.ai',
        });
        issueId = issue.id;
        const enqueued = await enqueueIssueDispatch(tx, registry, {
          issueId: issue.id,
          scheduledAt: new Date(),
        });
        if (enqueued.enqueued) jobId = enqueued.jobId;
        throw new Error('force rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'force rollback') throw error;
      });

    expect(
      await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId))
    ).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.id, jobId))).toEqual([]);
  });
});

describe('newsletter.dispatch.v1 handler', () => {
  it('sends every subscribed recipient across batches and completes the issue', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 5);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const outcome = await runToTerminal(() => handler, issueId);

    expect(outcome.kind).toBe('ok');
    const batches = sender.getSentBatches();
    expect(batches).toHaveLength(3);
    expect(batches.map((batch) => batch.idempotencyKey)).toEqual([
      `newsletter:${issueId}:0`,
      `newsletter:${issueId}:1`,
      `newsletter:${issueId}:2`,
    ]);
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(new Set(sentTo)).toEqual(new Set(subscribers.map((subscriber) => subscriber.email)));

    const deliveries = await deliveryRows(issueId);
    expect(deliveries).toHaveLength(5);
    expect(deliveries.every((row) => row.status === 'sent' && row.resendEmailId !== null)).toBe(
      true
    );

    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.sentAt).not.toBeNull();
    expect(issue.recipientCount).toBe(5);
    expect(issue.sentCount).toBe(5);
    expect(issue.failedCount).toBe(0);
  });

  it('yields a schema-valid checkpoint between batches without consuming retries', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 3);
    const issueId = await seedIssue();
    const { handler } = makeHandler(topic, { batchSize: 2 });

    const outcome = await handler(executionOf({ issueId, nextBatchIndex: 0 }));

    expect(outcome.kind).toBe('yield');
    if (outcome.kind !== 'yield') throw new Error('expected yield');
    expect(newsletterDispatchPayloadSchema.parse(outcome.checkpoint)).toEqual({
      issueId,
      nextBatchIndex: 1,
    });
  });

  it('excludes unsubscribed, suppressed, and pending rows at load time', async () => {
    const topic = nextTopic();
    const subscribed = await seedSubscribers(topic, 2);
    await seedSubscribers(topic, 1, 'unsubscribed');
    await seedSubscribers(topic, 1, 'suppressed');
    await seedSubscribers(topic, 1, 'pending');
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 100 });

    const outcome = await runToTerminal(() => handler, issueId);

    expect(outcome.kind).toBe('ok');
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(new Set(sentTo)).toEqual(new Set(subscribed.map((subscriber) => subscriber.email)));
    expect(await deliveryRows(issueId)).toHaveLength(2);
  });

  it('personalizes one-click unsubscribe headers per recipient, never crossing tokens', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 100 });

    const outcome = await runToTerminal(() => handler, issueId);
    expect(outcome.kind).toBe('ok');

    const tokenRows = await db
      .select({
        email: newsletterSubscribers.email,
        token: newsletterSubscribers.unsubscribeToken,
      })
      .from(newsletterSubscribers)
      .where(
        inArray(
          newsletterSubscribers.id,
          subscribers.map((subscriber) => subscriber.id)
        )
      );
    const tokenByEmail = new Map(tokenRows.map((row) => [row.email, row.token]));
    const messages = sender.getSentMessages();
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const ownToken = tokenByEmail.get(message.to);
      expect(ownToken).toBeDefined();
      expect(message.headers?.['List-Unsubscribe']).toBe(
        `<https://api.hushbox.ai/newsletter/unsubscribe?token=${String(ownToken)}>`
      );
      expect(message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    }
  });

  it('no-ops a canceled issue without creating deliveries', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const issueId = await seedIssue({ status: 'canceled' });
    const { handler, sender } = makeHandler(topic);

    const outcome = await handler(executionOf({ issueId, nextBatchIndex: 0 }));

    expect(outcome.kind).toBe('ok');
    expect(sender.getSentBatches()).toEqual([]);
    expect(await deliveryRows(issueId)).toEqual([]);
  });

  it('retries a scheduled issue that is not yet due', async () => {
    const issueId = await seedIssue({ scheduledAt: new Date(Date.now() + 3_600_000) });
    const { handler } = makeHandler(nextTopic());

    const outcome = await handler(executionOf({ issueId, nextBatchIndex: 0 }));

    expect(outcome.kind).toBe('fail');
  });

  it('dead-letters an unknown issue id', async () => {
    const { handler } = makeHandler(nextTopic());

    const outcome = await handler(executionOf({ issueId: crypto.randomUUID(), nextBatchIndex: 0 }));

    expect(outcome.kind).toBe('dead');
  });

  it('never re-sends completed batches after a mid-run send failure', async () => {
    const topic = nextTopic();
    const subscribers = await seedSubscribers(topic, 4);
    const issueId = await seedIssue();
    const recorder = createMockEmailSender();
    let calls = 0;
    let failOnCall = 2;
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        calls += 1;
        if (calls === failOnCall) {
          return errAsync(unavailableError('provider down'));
        }
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { batchSize: 2, sender: flaky });

    // First attempt: batch 0 sends, yields; second attempt: batch 1 send fails.
    const first = await handler(executionOf({ issueId, nextBatchIndex: 0 }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');
    const checkpoint = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    const second = await handler(executionOf(checkpoint));
    expect(second.kind).toBe('fail');
    const rowsAfterFailure = await deliveryRows(issueId);
    const failedRows = rowsAfterFailure.filter((row) => row.status === 'failed');
    expect(failedRows).toHaveLength(2);

    // Dispatcher retry: the same checkpoint payload re-runs; the failed batch
    // finishes; batch 0 recipients are never re-sent.
    failOnCall = -1;
    const third = await runToTerminal(() => handler, issueId);
    expect(third.kind).toBe('ok');

    const sentTo = recorder.getSentMessages().map((message) => message.to);
    expect(sentTo).toHaveLength(4);
    expect(new Set(sentTo)).toEqual(new Set(subscribers.map((subscriber) => subscriber.email)));
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.sentCount).toBe(4);
  });

  it('sends nothing twice when the whole handler re-executes after completion', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 3);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const firstRun = await runToTerminal(() => handler, issueId);
    expect(firstRun.kind).toBe('ok');
    const sentAfterFirst = sender.getSentMessages().length;

    // Lease-reclaim simulation: the original payload replays from scratch.
    const replay = await handler(executionOf({ issueId, nextBatchIndex: 0 }));

    expect(replay.kind).toBe('ok');
    expect(sender.getSentMessages()).toHaveLength(sentAfterFirst);
    const issueAfterReplay = await issueRow(issueId);
    expect(issueAfterReplay.sentCount).toBe(3);
  });

  async function seedPendingWithToken(
    topic: string
  ): Promise<{ id: string; email: string; confirmToken: string }> {
    const [row] = await seedSubscribers(topic, 1, 'pending');
    if (row === undefined) throw new Error('seed failed');
    const confirmToken = crypto.randomUUID();
    await db
      .update(newsletterSubscribers)
      .set({ confirmToken, confirmExpiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(newsletterSubscribers.id, row.id));
    return { ...row, confirmToken };
  }

  it('freezes recipients at claim: a mid-dispatch confirmation joins no in-flight issue', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    // Seeded mid-sequence so its uuidv7 id sorts inside the frozen list.
    const pending = await seedPendingWithToken(topic);
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic, { batchSize: 2 });

    const first = await handler(executionOf({ issueId, nextBatchIndex: 0 }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');

    const confirmed = await createNewsletterStores(db).consumeConfirmToken(
      pending.confirmToken,
      new Date()
    );
    expect(confirmed._unsafeUnwrap()).toBe(true);

    let payload = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    let outcome = await handler(executionOf(payload));
    while (outcome.kind === 'yield') {
      payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
      outcome = await handler(executionOf(payload));
    }
    expect(outcome.kind).toBe('ok');

    const rows = await deliveryRows(issueId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.subscriberId)).not.toContain(pending.id);
    expect(rows.every((row) => row.status === 'sent')).toBe(true);
    const sentTo = sender.getSentMessages().map((message) => message.to);
    expect(sentTo).toHaveLength(3);
    expect(sentTo).not.toContain(pending.email);
    const issue = await issueRow(issueId);
    expect(issue.recipientCount).toBe(3);
    expect(issue.sentCount).toBe(3);
    expect(issue.failedCount).toBe(0);
  });

  it('replays a failed batch with its original frozen composition after a mid-dispatch flip', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const pending = await seedPendingWithToken(topic);
    await seedSubscribers(topic, 2);
    const issueId = await seedIssue();
    const recorder = createMockEmailSender();
    const attempts: { key: string; to: string[] }[] = [];
    let calls = 0;
    const flaky: BatchEmailSender = {
      send: (message) => recorder.send(message),
      sendBatch: (messages, options) => {
        attempts.push({
          key: options.idempotencyKey,
          to: messages.map((message) => message.to),
        });
        calls += 1;
        if (calls === 2) return errAsync(unavailableError('provider down'));
        return recorder.sendBatch(messages, options);
      },
    };
    const { handler } = makeHandler(topic, { batchSize: 2, sender: flaky });

    const first = await handler(executionOf({ issueId, nextBatchIndex: 0 }));
    expect(first.kind).toBe('yield');
    if (first.kind !== 'yield') throw new Error('expected yield');
    const checkpoint = newsletterDispatchPayloadSchema.parse(first.checkpoint);
    const second = await handler(executionOf(checkpoint));
    expect(second.kind).toBe('fail');

    const confirmed = await createNewsletterStores(db).consumeConfirmToken(
      pending.confirmToken,
      new Date()
    );
    expect(confirmed._unsafeUnwrap()).toBe(true);

    const third = await handler(executionOf(checkpoint));
    expect(third.kind).toBe('ok');

    const batchOneAttempts = attempts.filter(
      (attempt) => attempt.key === `newsletter:${issueId}:1`
    );
    expect(batchOneAttempts).toHaveLength(2);
    expect(batchOneAttempts[1]?.to).toEqual(batchOneAttempts[0]?.to);
    expect(attempts.flatMap((attempt) => attempt.to)).not.toContain(pending.email);
  });

  it('fails the attempt when the lease is lost mid-run', async () => {
    const topic = nextTopic();
    await seedSubscribers(topic, 1);
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(topic);

    const outcome = await handler({
      ...executionOf({ issueId, nextBatchIndex: 0 }),
      heartbeat: () => Promise.resolve('lost'),
    });

    expect(outcome.kind).toBe('fail');
    expect(sender.getSentBatches()).toEqual([]);
  });

  it('completes an issue with zero subscribed recipients', async () => {
    const issueId = await seedIssue();
    const { handler, sender } = makeHandler(nextTopic());

    const outcome = await handler(executionOf({ issueId, nextBatchIndex: 0 }));

    expect(outcome.kind).toBe('ok');
    expect(sender.getSentBatches()).toEqual([]);
    const issue = await issueRow(issueId);
    expect(issue.status).toBe('sent');
    expect(issue.recipientCount).toBe(0);
  });
});
