import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  jobs,
  newsletterIssues,
} from '@hushbox/db';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { createAppJobRegistry } from '../../../../lib/jobs/index.js';
import {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
  enqueueIssueDispatch,
} from '../../../newsletter/index.js';
import { createAdminStores } from '../../adapters/stores.js';
import { createAdminOpEngine } from '../engine.js';
import { createAdminOpRegistry } from '../registry.js';
import { describeAdminOp } from '../describe-admin-op.js';
import { adminNewsletterOperations } from './index.js';
import type { BatchEmailSender } from '../../../notifications/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks, AdminOpRunResult } from '../engine.js';
import type { AdminOpHarnessInstance } from '../describe-admin-op.js';
import type { AdminNewsletterDeps } from './newsletter.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('DATABASE_URL is required for admin newsletter op tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const adminStores = createAdminStores();

const SCHEDULE_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.schedule'];
const CANCEL_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.cancel'];
const TEST_SEND_CONTRACT = ADMIN_OP_CONTRACTS['newsletter.testSend'];

/** Every harness subject starts with this, so cleanup targets only this run. */
const RUN_MARKER = `admin-nl-op ${crypto.randomUUID()}`;

const FUTURE_ISO = '2999-01-01T00:00:00.000Z';
const PAST_ISO = '2001-01-01T00:00:00.000Z';

afterAll(async () => {
  const issueRows = await db
    .select({ id: newsletterIssues.id })
    .from(newsletterIssues)
    .where(like(newsletterIssues.subject, `${RUN_MARKER}%`));
  const issueIds = issueRows.map((row) => row.id);
  if (issueIds.length > 0) {
    const dedupeKeys = issueIds.map((id) => `newsletter.dispatch:${id}`);
    await db.delete(jobs).where(inArray(jobs.dedupeKey, dedupeKeys));
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, issueIds));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/newsletter.%'));
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError: noop,
    emitMetric: noop,
  };
}

/** Dispatch never runs in these tests; the registration only shapes enqueue. */
const inertBatchSender: BatchEmailSender = {
  send: () => okAsync(),
  sendBatch: () => okAsync({ ids: [] }),
};

const dispatchRegistry = createAppJobRegistry([
  createNewsletterDispatchJobRegistration({
    store: createNewsletterDispatchStores(db),
    sender: inertBatchSender,
    urls: { apiUrl: 'http://api.test.local', frontendUrl: 'http://web.test.local' },
  }),
]);

interface NewsletterHarness extends AdminOpHarnessInstance {
  readonly marker: string;
  readonly sentTestEmails: readonly { readonly to: string; readonly subject: string }[];
}

interface HarnessOptions {
  hooks?: AdminOpEngineHooks;
}

function createNewsletterHarness(options: HarnessOptions = {}): NewsletterHarness {
  const actor = `nl-admin-${crypto.randomUUID()}@hushbox.ai`;
  const marker = `${RUN_MARKER} ${crypto.randomUUID()}`;
  const sentTestEmails: { to: string; subject: string }[] = [];
  let testSendArmedToFail = false;
  const deps: AdminNewsletterDeps = {
    clock: { now: (): Date => new Date() },
    actorEmail: (): string => actor,
    newsletterDispatch: {
      enqueueWithinTx: (tx, params) => enqueueIssueDispatch(tx, dispatchRegistry, params),
    },
    newsletterIssueReader: {
      readWithinTx: async (tx, issueId) => {
        const rows = await tx
          .select()
          .from(newsletterIssues)
          .where(eq(newsletterIssues.id, issueId));
        return rows[0] ?? null;
      },
    },
    newsletterTestEmail: {
      send: (params) => {
        if (testSendArmedToFail) {
          return errAsync(unavailableError('armed test-send failure'));
        }
        sentTestEmails.push({ to: params.to, subject: params.subject });
        return okAsync();
      },
    },
  };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<AdminNewsletterDeps>([...adminNewsletterOperations]),
    stores: adminStores,
    telemetry: noopTelemetry(),
    opDeps: deps,
    executorId: `admin-newsletter-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    marker,
    sentTestEmails,
    /** Iron Law projection: the still-scheduled subjects under this marker. */
    projection: async (): Promise<readonly string[]> => {
      const rows = await db
        .select({ subject: newsletterIssues.subject })
        .from(newsletterIssues)
        .where(
          and(
            like(newsletterIssues.subject, `${marker}%`),
            eq(newsletterIssues.status, 'scheduled')
          )
        );
      return rows.map((row) => row.subject).toSorted((a, b) => a.localeCompare(b));
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: (): readonly string[] => sentTestEmails.map((email) => email.to),
      armFailure: (): void => {
        testSendArmedToFail = true;
      },
    },
  };
}

function scheduleInput(marker: string, scheduledAt = FUTURE_ISO): Record<string, unknown> {
  return {
    subject: `${marker} issue ${crypto.randomUUID()}`,
    bodyMarkdown: '# hello\n\nnewsletter body',
    scheduledAt,
    reason: 'scheduling a test issue',
  };
}

async function seedIssue(
  marker: string,
  overrides: Partial<typeof newsletterIssues.$inferInsert> = {}
): Promise<{ id: string; subject: string }> {
  const subject = `${marker} seeded ${crypto.randomUUID()}`;
  const rows = await db
    .insert(newsletterIssues)
    .values({
      subject,
      bodyMarkdown: 'seeded body',
      status: 'scheduled',
      scheduledAt: new Date(FUTURE_ISO),
      createdBy: 'seed@hushbox.ai',
      ...overrides,
    })
    .returning({ id: newsletterIssues.id });
  const row = rows[0];
  if (row === undefined) throw new Error('newsletter harness: seed insert returned no row');
  return { id: row.id, subject };
}

type Engine = NewsletterHarness['engine'];

function execute(
  harness: NewsletterHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): ReturnType<Engine['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
    ...(undoes === undefined ? {} : { undoes }),
  });
}

async function executeOk(
  harness: NewsletterHarness,
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<AdminOpRunResult> {
  const result = await execute(harness, name, input, undoes);
  return result._unsafeUnwrap();
}

async function issueRowById(id: string): Promise<typeof newsletterIssues.$inferSelect | null> {
  const rows = await db.select().from(newsletterIssues).where(eq(newsletterIssues.id, id));
  return rows[0] ?? null;
}

async function dispatchJobFor(issueId: string): Promise<{ status: string } | null> {
  const rows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(eq(jobs.dedupeKey, `newsletter.dispatch:${issueId}`));
  return rows[0] ?? null;
}

// --- The mandatory per-op batteries ---------------------------------------

const scheduleHolder = { marker: '' };
describeAdminOp({
  contract: SCHEDULE_CONTRACT,
  createHarness: (options) => {
    const harness = createNewsletterHarness(options);
    scheduleHolder.marker = harness.marker;
    return Promise.resolve(harness);
  },
  validInput: () => scheduleInput(scheduleHolder.marker),
  invalidInput: { subject: '', bodyMarkdown: 'x', scheduledAt: FUTURE_ISO, reason: 'r' },
});

const cancelHolder = { marker: '', issueId: '' };
describeAdminOp({
  contract: CANCEL_CONTRACT,
  createHarness: async (options) => {
    const harness = createNewsletterHarness(options);
    const seeded = await seedIssue(harness.marker);
    cancelHolder.marker = harness.marker;
    cancelHolder.issueId = seeded.id;
    return harness;
  },
  validInput: () => ({ issueId: cancelHolder.issueId, reason: 'canceling the seeded issue' }),
  invalidInput: { issueId: 'not-a-uuid', reason: 'r' },
});

const testSendHolder = { marker: '' };
describeAdminOp({
  contract: TEST_SEND_CONTRACT,
  createHarness: (options) => {
    const harness = createNewsletterHarness(options);
    testSendHolder.marker = harness.marker;
    return Promise.resolve(harness);
  },
  validInput: () => ({
    subject: `${testSendHolder.marker} preview`,
    bodyMarkdown: 'preview body',
    reason: 'previewing an issue',
  }),
  invalidInput: { subject: '', bodyMarkdown: 'x', reason: 'r' },
  hasEphemeralEffects: true,
});

// --- Semantic pins beyond the shared battery ------------------------------

describe('newsletter.schedule', () => {
  it('previews without committing an issue row or a dispatch jobs row', async () => {
    const harness = createNewsletterHarness();

    const result = await harness.engine.run({
      name: 'newsletter.schedule',
      input: scheduleInput(harness.marker),
      actor: harness.actor,
      mode: 'preview',
    });

    const previewed = result._unsafeUnwrap();
    const issueId = previewed.inverseInput?.['issueId'];
    if (typeof issueId !== 'string') throw new Error('preview returned no issueId');
    expect(await issueRowById(issueId)).toBeNull();
    expect(await dispatchJobFor(issueId)).toBeNull();
  });

  it('commits the issue, its dispatch job, and the audit row atomically', async () => {
    const harness = createNewsletterHarness();
    const input = scheduleInput(harness.marker);

    const executed = await executeOk(harness, 'newsletter.schedule', input);

    const issueId = executed.inverseInput?.['issueId'];
    if (typeof issueId !== 'string') throw new Error('execute returned no issueId');
    const issue = await issueRowById(issueId);
    expect(issue?.status).toBe('scheduled');
    expect(issue?.subject).toBe(input['subject']);
    expect(issue?.createdBy).toBe(harness.actor);
    expect(issue?.scheduledAt.toISOString()).toBe(FUTURE_ISO);
    const dispatchJob = await dispatchJobFor(issueId);
    expect(dispatchJob?.status).toBe('pending');
    expect(await harness.auditCount()).toBe(1);
  });

  it('rejects a scheduledAt in the past with no committed effect', async () => {
    const harness = createNewsletterHarness();

    const result = await execute(
      harness,
      'newsletter.schedule',
      scheduleInput(harness.marker, PAST_ISO)
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toEqual([]);
    expect(await harness.auditCount()).toBe(0);
  });
});

describe('newsletter.cancel', () => {
  it('treats canceling an already-canceled issue as a no-op success, audited', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker);
    const input = { issueId: seeded.id, reason: 'first cancel' };
    await executeOk(harness, 'newsletter.cancel', input);

    const second = await executeOk(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'second cancel',
    });

    expect(second.effects).toEqual([
      { label: 'newsletter.issue.status', before: 'canceled', after: 'canceled' },
    ]);
    const canceledRow = await issueRowById(seeded.id);
    expect(canceledRow?.status).toBe('canceled');
    expect(await harness.auditCount()).toBe(2);
  });

  it('refuses with conflict once dispatch has begun (sending)', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker, { status: 'sending' });

    const result = await execute(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'too late',
    });

    expect(result._unsafeUnwrapErr().code).toBe('conflict');
    const untouchedRow = await issueRowById(seeded.id);
    expect(untouchedRow?.status).toBe('sending');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an unknown issue id with not_found and no audit row', async () => {
    const harness = createNewsletterHarness();

    const result = await execute(harness, 'newsletter.cancel', {
      issueId: crypto.randomUUID(),
      reason: 'missing',
    });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('round-trips: schedule → undo-cancel → redo-schedule reproduces an equivalent issue', async () => {
    const harness = createNewsletterHarness();
    const input = scheduleInput(harness.marker);

    const scheduled = await executeOk(harness, 'newsletter.schedule', input);
    const canceled = await executeOk(
      harness,
      'newsletter.cancel',
      scheduled.inverseInput ?? {},
      scheduled.auditId
    );
    const rescheduled = await executeOk(
      harness,
      'newsletter.schedule',
      canceled.inverseInput ?? {},
      canceled.auditId
    );

    const newIssueId = rescheduled.inverseInput?.['issueId'];
    if (typeof newIssueId !== 'string') throw new Error('redo returned no issueId');
    const reproduced = await issueRowById(newIssueId);
    expect(reproduced?.subject).toBe(input['subject']);
    expect(reproduced?.bodyMarkdown).toBe(input['bodyMarkdown']);
    expect(reproduced?.scheduledAt.toISOString()).toBe(FUTURE_ISO);
    expect(reproduced?.status).toBe('scheduled');
  });

  it('lets undo of a cancel fail schedule’s future gate when scheduledAt has passed', async () => {
    const harness = createNewsletterHarness();
    const seeded = await seedIssue(harness.marker, { scheduledAt: new Date(PAST_ISO) });

    const canceled = await executeOk(harness, 'newsletter.cancel', {
      issueId: seeded.id,
      reason: 'canceling a stale issue',
    });
    expect(canceled.inverseInput?.['scheduledAt']).toBe(PAST_ISO);

    const undo = await execute(
      harness,
      'newsletter.schedule',
      canceled.inverseInput ?? {},
      canceled.auditId
    );

    expect(undo._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.projection()).toEqual([]);
  });
});

describe('newsletter.testSend', () => {
  it('emails the rendered preview to the acting admin and writes no issue row', async () => {
    const harness = createNewsletterHarness();

    await executeOk(harness, 'newsletter.testSend', {
      subject: `${harness.marker} preview`,
      bodyMarkdown: 'body',
      reason: 'checking the layout',
    });

    expect(harness.sentTestEmails).toEqual([
      { to: harness.actor, subject: `${harness.marker} preview` },
    ]);
    const issues = await db
      .select({ id: newsletterIssues.id })
      .from(newsletterIssues)
      .where(like(newsletterIssues.subject, `${harness.marker}%`));
    expect(issues).toEqual([]);
    expect(await harness.auditCount()).toBe(1);
  });
});

describe('registration', () => {
  it('registers schedule↔cancel as an inverse pair and testSend as ephemeral', () => {
    const registry = createAdminOpRegistry<AdminNewsletterDeps>([...adminNewsletterOperations]);

    expect(registry.get('newsletter.schedule')?.contract.inverse).toBe('newsletter.cancel');
    expect(registry.get('newsletter.cancel')?.contract.inverse).toBe('newsletter.schedule');
    expect(registry.get('newsletter.testSend')?.contract.effectClass).toBe('ephemeral');
    expect(registry.list()).toHaveLength(3);
  });

  it('keeps the dispatch job type stable for the enqueue seam', () => {
    expect(NEWSLETTER_DISPATCH_JOB_TYPE).toBe('newsletter.dispatch.v1');
  });
});
