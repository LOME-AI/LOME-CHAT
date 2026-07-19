import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  idempotencyKeys,
  jobs,
  newsletterDeliveries,
  newsletterIssues,
  newsletterSubscribers,
} from '@hushbox/db';
import {
  NEWSLETTER_CONSENT_TEXT_VERSION,
  NEWSLETTER_DEFAULT_TOPIC,
  NEWSLETTER_POSTAL_ADDRESS,
  ROUTES,
} from '@hushbox/shared';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createEmailSenderFromEnv, listCapturedEmails } from '../notifications/index.js';
import { createIdentityStores } from '../identity/index.js';
import { createAppJobRegistry } from '../../lib/jobs/index.js';
import { okAsync } from '../../lib/result/index.js';
import {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  createNewsletterDispatchStores,
  createNewsletterManifest,
  createNewsletterStores,
  createResendWebhookVerifier,
  enqueueIssueDispatch,
  newsletterDispatchPayloadSchema,
} from './index.js';
import {
  NEWSLETTER_CONFIRM_EMAIL_SUBJECT,
  createNewsletterConfirmEmailAdapter,
} from '../../adapters/newsletter-confirmation-email.js';
import { createAdminStores } from '../admin/adapters/stores.js';
import { createAdminOpEngine } from '../admin/domain/engine.js';
import { createAdminOpRegistry } from '../admin/domain/registry.js';
import { adminNewsletterOperations } from '../admin/domain/operations/index.js';
import type { z } from 'zod';
import type { Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv, Telemetry } from '../../lib/telemetry/index.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { JobDispatcherNamespace, JobExecution, JobOutcome } from '../../lib/jobs/index.js';
import type { AdminOpEngine, AdminOpRunResult } from '../admin/domain/engine.js';
import type { AdminNewsletterDeps } from '../admin/domain/operations/newsletter.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_* are required for the newsletter lifecycle test'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';

/**
 * The two public origins issue links are asserted against — the confirm link
 * and the visible unsubscribe footer must live on MARKETING_URL, the
 * RFC 8058 one-click header on API_URL. These are the constants the adapters
 * receive, so the assertions pin the real routing, not incidental literals.
 */
const MARKETING_URL = 'https://hushbox.ai';
const API_URL = 'https://api.hushbox.ai';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const WEBHOOK_SECRET_B64 = Buffer.from('newsletter-lifecycle-webhook-secret').toString('base64');
const WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_B64}`;

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

// Every lifecycle subscriber lives on a unique topic so dispatch loads
// exactly this run's audience — the shared dev DB holds `subscribed` rows on
// the launch topic from concurrent suites, and the handler freezes recipients
// by topic (deps-bound), not by issue.
const TOPIC = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;

// The schedule op refuses a `scheduledAt` at or before its injected clock, but
// the dispatch handler only fires a `scheduledAt` already in the past. A fixed
// far-past clock lets a real just-past timestamp pass the future gate while
// staying due for dispatch — no post-schedule row surgery needed.
const SCHEDULE_CLOCK = new Date('2000-01-01T00:00:00.000Z');

const createdEmails: string[] = [];
const createdIssueIds: string[] = [];
const mintedIdemKeys: string[] = [];
const actor = `nl-lifecycle-${crypto.randomUUID()}@hushbox.ai`;

let emailCounter = 0;
function nextEmail(tag: string): string {
  emailCounter += 1;
  const email = `${tag}${String(emailCounter)}-${crypto.randomUUID().slice(0, 8)}@newsletter-lifecycle.test`;
  createdEmails.push(email);
  return email;
}

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop, emitMetric: noop };
}

/** One capturing sender shared by the confirm adapter and the dispatch job. */
const sender = createEmailSenderFromEnv(testEnv, db);

/** The full newsletter manifest wired to the REAL confirm-email adapter. */
function buildApp(): Hono<AppEnv> {
  const confirmEmail = createNewsletterConfirmEmailAdapter(() => ({
    sender,
    logger: noopTelemetry(),
    marketingUrl: MARKETING_URL,
  }));
  const manifest = createNewsletterManifest({
    stores: createNewsletterStores,
    confirmEmail,
    identityUsers: (dbArgument) => createIdentityStores(dbArgument).users,
    webhookVerifier: () => createResendWebhookVerifier({ secret: WEBHOOK_SECRET }),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

const app = buildApp();

interface SendOptions {
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly contentType?: string;
  readonly query?: string;
  readonly headers?: Record<string, string>;
}

async function send(options: SendOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-for': `10.0.0.${String(emailCounter + 1)}`,
  };
  if (options.rawBody !== undefined || options.body !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  const init: RequestInit = {
    method: options.method ?? 'POST',
    headers: { ...headers, ...options.headers },
  };
  if (options.rawBody !== undefined) init.body = options.rawBody;
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return app.request(`${options.path}${options.query ?? ''}`, init, testEnv);
}

async function subscriberRow(email: string): Promise<typeof newsletterSubscribers.$inferSelect> {
  const rows = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email));
  const row = rows[0];
  if (row === undefined) throw new Error(`no subscriber row for ${email}`);
  return row;
}

interface Seeded {
  readonly email: string;
  readonly unsubscribeToken: string;
}

/**
 * Directly seed a row. The audience lives on this run's isolated topic so
 * dispatch loads a deterministic set; the complaint subject lives on
 * NEWSLETTER_DEFAULT_TOPIC because the public routes and the webhook
 * suppression are single-topic (they only touch the launch list).
 */
async function seedSubscriber(
  tag: string,
  status: 'subscribed' | 'unsubscribed' | 'suppressed',
  options: { topic?: string; suppressReason?: 'complaint' | 'bounce' } = {}
): Promise<Seeded> {
  const email = nextEmail(tag);
  const unsubscribeToken = crypto.randomUUID();
  await db.insert(newsletterSubscribers).values({
    email,
    status,
    topic: options.topic ?? TOPIC,
    consentSource: 'marketing_site',
    consentIp: '192.0.2.1',
    consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
    unsubscribeToken,
    ...(status === 'unsubscribed' ? { unsubscribedAt: new Date() } : {}),
    ...(status === 'suppressed'
      ? { suppressReason: options.suppressReason ?? 'complaint', suppressedAt: new Date() }
      : {}),
  });
  return { email, unsubscribeToken };
}

// --- email-capture helpers ------------------------------------------------

function capturedFor(email: string, subject: string): readonly string[] {
  return listCapturedEmails()
    .filter((entry) => entry.message.to === email && entry.message.subject === subject)
    .map((entry) => entry.message.html);
}

interface IssueEmailView {
  readonly html: string;
  readonly headers?: Record<string, string> | undefined;
}

function capturedIssueMessages(email: string, subject: string): readonly IssueEmailView[] {
  return listCapturedEmails()
    .filter((entry) => entry.message.to === email && entry.message.subject === subject)
    .map((entry) => ({ html: entry.message.html, headers: entry.message.headers }));
}

function extractLink(html: string, pathFragment: string): URL {
  const match = new RegExp(`href="([^"]*${pathFragment}[^"]*)"`).exec(html);
  const href = match?.[1];
  if (href === undefined) throw new Error(`no href containing ${pathFragment}`);
  return new URL(href.replaceAll('&amp;', '&'));
}

/** The visible footer link + one-click header + postal address of one issue email. */
function assertIssueEmailContents(message: IssueEmailView, ownToken: string): void {
  const footer = extractLink(message.html, 'newsletter/unsubscribed');
  expect(footer.origin).toBe(new URL(MARKETING_URL).origin);
  expect(footer.pathname).toBe(ROUTES.NEWSLETTER_UNSUBSCRIBED);
  expect(footer.searchParams.get('token')).toBe(ownToken);

  const header = message.headers?.['List-Unsubscribe'];
  if (header === undefined) throw new Error('issue email missing List-Unsubscribe header');
  const oneClick = new URL(header.replaceAll(/^<|>$/g, ''));
  expect(oneClick.origin).toBe(new URL(API_URL).origin);
  expect(oneClick.pathname).toBe('/newsletter/unsubscribe');
  expect(oneClick.searchParams.get('token')).toBe(ownToken);

  expect(message.html).toContain(NEWSLETTER_POSTAL_ADDRESS);
}

// --- dispatch job driver --------------------------------------------------

type DispatchPayload = z.infer<typeof newsletterDispatchPayloadSchema>;

const dispatchRegistration = createNewsletterDispatchJobRegistration({
  store: createNewsletterDispatchStores(db),
  sender,
  urls: { apiUrl: API_URL, marketingUrl: MARKETING_URL },
  topic: TOPIC,
});
const dispatchRegistry = createAppJobRegistry([dispatchRegistration]);

function executionOf(payload: DispatchPayload): JobExecution<DispatchPayload> {
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

async function runDispatch(issueId: string): Promise<JobOutcome> {
  let payload: DispatchPayload = { issueId, nextBatchIndex: 0 };
  for (;;) {
    const outcome = await dispatchRegistration.handler(executionOf(payload));
    if (outcome.kind !== 'yield') return outcome;
    payload = newsletterDispatchPayloadSchema.parse(outcome.checkpoint);
  }
}

async function deliveryRows(issueId: string): Promise<{ subscriberId: string; status: string }[]> {
  return db
    .select({
      subscriberId: newsletterDeliveries.subscriberId,
      status: newsletterDeliveries.status,
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

async function dispatchJob(
  issueId: string
): Promise<{ status: string; type: string; shard: string } | undefined> {
  const rows = await db
    .select({ status: jobs.status, type: jobs.type, shard: jobs.shard })
    .from(jobs)
    .where(eq(jobs.dedupeKey, `newsletter.dispatch:${issueId}`));
  return rows[0];
}

// --- admin schedule engine ------------------------------------------------

const wakeLog: string[] = [];
const jobDispatcher: JobDispatcherNamespace = {
  idFromName: (name: string) => name,
  get: (id: unknown) => ({
    fetch: (): Promise<unknown> => {
      wakeLog.push(`wake:${String(id)}`);
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  }),
};

const adminDeps: AdminNewsletterDeps = {
  clock: { now: (): Date => SCHEDULE_CLOCK },
  actorEmail: (): string => actor,
  jobDispatcher,
  newsletterDispatch: {
    enqueueWithinTx: (tx, params) => enqueueIssueDispatch(tx, dispatchRegistry, params),
  },
  newsletterIssueReader: {
    readWithinTx: async (tx, issueId) => {
      const rows = await tx.select().from(newsletterIssues).where(eq(newsletterIssues.id, issueId));
      return rows[0] ?? null;
    },
  },
  newsletterTestEmail: { send: () => okAsync() },
};

const engine: AdminOpEngine = createAdminOpEngine({
  db,
  registry: createAdminOpRegistry<AdminNewsletterDeps>([...adminNewsletterOperations]),
  stores: createAdminStores(),
  telemetry: noopTelemetry(),
  opDeps: adminDeps,
  executorId: `nl-lifecycle-${crypto.randomUUID()}`,
});

async function scheduleIssue(subject: string): Promise<string> {
  const idempotencyKey = crypto.randomUUID();
  mintedIdemKeys.push(idempotencyKey);
  const runResult = await engine.run({
    name: 'newsletter.schedule',
    actor,
    mode: 'execute',
    idempotencyKey,
    input: {
      subject,
      bodyMarkdown: `# ${subject}\n\nHello **subscriber**`,
      // Just-past real time: future vs the fixed schedule clock, due for dispatch.
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      reason: 'lifecycle test issue',
    },
  });
  const result: AdminOpRunResult = runResult._unsafeUnwrap();
  const issueId = result.inverseInput?.['issueId'];
  if (typeof issueId !== 'string') throw new Error('schedule returned no issueId');
  createdIssueIds.push(issueId);
  return issueId;
}

// --- signed webhook -------------------------------------------------------

async function complaintWebhook(email: string): Promise<Response> {
  const rawBody = JSON.stringify({ type: 'email.complained', data: { to: [email] } });
  const svixId = `msg_${crypto.randomUUID()}`;
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const svixSignature = await signHmacSha256Webhook({
    secret: WEBHOOK_SECRET_B64,
    payload: rawBody,
    timestamp: svixTimestamp,
    webhookId: svixId,
  });
  return send({
    path: '/newsletter/webhooks/resend',
    rawBody,
    headers: {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    },
  });
}

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await db
      .delete(newsletterDeliveries)
      .where(inArray(newsletterDeliveries.issueId, createdIssueIds));
    await db.delete(jobs).where(
      inArray(
        jobs.dedupeKey,
        createdIssueIds.map((id) => `newsletter.dispatch:${id}`)
      )
    );
    await db.delete(newsletterIssues).where(inArray(newsletterIssues.id, createdIssueIds));
  }
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  if (mintedIdemKeys.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.key, mintedIdemKeys));
  }
  // admin_audit is append-only (UPDATE/DELETE-raising trigger); its rows are
  // left to accrue and prune on retention, exactly as the admin op suites do.
  await db.$client.end();
});

describe('newsletter lifecycle', () => {
  it('walks subscribe → confirm → schedule → dispatch → unsubscribe → complaint end to end', async () => {
    // STEP 1 — anonymous subscribe mints a pending row and one confirm email
    // whose link points at the marketing /newsletter/confirmed page.
    const subAEmail = nextEmail('sub-a');
    const subscribeRes = await send({ path: '/newsletter/subscribe', body: { email: subAEmail } });
    expect(subscribeRes.status).toBe(200);
    const pendingA = await subscriberRow(subAEmail);
    expect(pendingA.status).toBe('pending');
    expect(pendingA.confirmToken).not.toBeNull();

    const confirmHtmls = capturedFor(subAEmail, NEWSLETTER_CONFIRM_EMAIL_SUBJECT);
    expect(confirmHtmls).toHaveLength(1);
    const confirmLink = extractLink(confirmHtmls[0] ?? '', 'newsletter/confirmed');
    expect(confirmLink.origin).toBe(new URL(MARKETING_URL).origin);
    expect(confirmLink.pathname).toBe(ROUTES.NEWSLETTER_CONFIRMED);
    expect(confirmLink.searchParams.get('token')).toBe(pendingA.confirmToken);

    // STEP 2 — confirm flips to subscribed; a replayed confirm is a no-op.
    const confirmRes = await send({
      path: '/newsletter/confirm',
      body: { token: pendingA.confirmToken },
    });
    expect(confirmRes.status).toBe(200);
    const confirmedA = await subscriberRow(subAEmail);
    expect(confirmedA.status).toBe('subscribed');
    expect(confirmedA.confirmedAt).not.toBeNull();

    const replayRes = await send({
      path: '/newsletter/confirm',
      body: { token: pendingA.confirmToken },
    });
    expect(replayRes.status).toBe(200);
    const replayed = await subscriberRow(subAEmail);
    expect(replayed.status).toBe('subscribed');

    // The public route lands subA on the launch topic; move it onto this
    // run's isolated topic so dispatch loads a deterministic audience.
    await db
      .update(newsletterSubscribers)
      .set({ topic: TOPIC })
      .where(eq(newsletterSubscribers.email, subAEmail));
    const subA: Seeded = { email: subAEmail, unsubscribeToken: confirmedA.unsubscribeToken };

    // STEP 3 — the rest of the audience plus the excluded rows (all on the
    // isolated topic so dispatch loads exactly this run's subscribers).
    const subB = await seedSubscriber('sub-b', 'subscribed');
    const subC = await seedSubscriber('sub-c', 'subscribed');
    const unsubZero = await seedSubscriber('unsub-zero', 'unsubscribed');
    const supprZero = await seedSubscriber('suppr-zero', 'suppressed', {
      suppressReason: 'complaint',
    });

    // STEP 4 — admin schedules issue one through the ops engine: issue row +
    // dispatch job commit together, the bulk shard is woken post-commit.
    const issue1Subject = `Lifecycle issue one ${crypto.randomUUID().slice(0, 8)}`;
    const issue1 = await scheduleIssue(issue1Subject);
    const scheduled = await issueRow(issue1);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.subject).toBe(issue1Subject);
    expect(scheduled.createdBy).toBe(actor);
    const job1 = await dispatchJob(issue1);
    expect(job1?.status).toBe('pending');
    expect(job1?.type).toBe(NEWSLETTER_DISPATCH_JOB_TYPE);
    expect(job1?.shard).toBe('bulk');
    expect(wakeLog).toContain('wake:bulk');

    // STEP 5 — dispatch issue one: exactly the three subscribed recipients,
    // each with a personalized, correctly-routed issue email.
    const dispatch1 = await runDispatch(issue1);
    expect(dispatch1.kind).toBe('ok');
    const audience1: readonly Seeded[] = [subA, subB, subC];
    expect(await deliveryRows(issue1)).toHaveLength(audience1.length);
    for (const recipient of audience1) {
      const messages = capturedIssueMessages(recipient.email, issue1Subject);
      expect(messages).toHaveLength(1);
      const message = messages[0];
      if (message === undefined) throw new Error('missing captured issue email');
      assertIssueEmailContents(message, recipient.unsubscribeToken);
    }
    for (const excluded of [unsubZero, supprZero]) {
      expect(capturedIssueMessages(excluded.email, issue1Subject)).toHaveLength(0);
    }
    const sent1 = await issueRow(issue1);
    expect(sent1.status).toBe('sent');
    expect(sent1.recipientCount).toBe(3);
    expect(sent1.sentCount).toBe(3);
    expect(sent1.failedCount).toBe(0);

    // STEP 6 — subC unsubscribes via its emailed token.
    const unsubRes = await send({
      path: '/newsletter/unsubscribe',
      body: { token: subC.unsubscribeToken },
    });
    expect(unsubRes.status).toBe(200);
    const unsubscribedC = await subscriberRow(subC.email);
    expect(unsubscribedC.status).toBe('unsubscribed');

    // STEP 7 — issue two excludes the just-unsubscribed subC; the remaining
    // three each receive exactly one new email.
    const issue2Subject = `Lifecycle issue two ${crypto.randomUUID().slice(0, 8)}`;
    const issue2 = await scheduleIssue(issue2Subject);
    const dispatch2 = await runDispatch(issue2);
    expect(dispatch2.kind).toBe('ok');
    const deliveries2 = await deliveryRows(issue2);
    expect(deliveries2).toHaveLength(2);
    const subCRow = await subscriberRow(subC.email);
    expect(deliveries2.map((row) => row.subscriberId)).not.toContain(subCRow.id);
    expect(capturedIssueMessages(subC.email, issue2Subject)).toHaveLength(0);
    for (const recipient of [subA, subB]) {
      expect(capturedIssueMessages(recipient.email, issue2Subject)).toHaveLength(1);
    }
    const issue2Sent = await issueRow(issue2);
    expect(issue2Sent.recipientCount).toBe(2);

    // STEP 8 — a signed complaint webhook suppresses a subscribed address; a
    // fresh subscribe attempt stays suppressed and sends no confirmation email.
    // The webhook and the public routes operate on the launch topic, so this
    // subject is seeded there rather than on the dispatch audience's topic.
    const complainer = await seedSubscriber('complainer', 'subscribed', {
      topic: NEWSLETTER_DEFAULT_TOPIC,
    });
    const webhookRes = await complaintWebhook(complainer.email);
    expect(webhookRes.status).toBe(200);
    const suppressed = await subscriberRow(complainer.email);
    expect(suppressed.status).toBe('suppressed');
    expect(suppressed.suppressReason).toBe('complaint');

    const resubscribeRes = await send({
      path: '/newsletter/subscribe',
      body: { email: complainer.email },
    });
    expect(resubscribeRes.status).toBe(200);
    const stillSuppressed = await subscriberRow(complainer.email);
    expect(stillSuppressed.status).toBe('suppressed');
    expect(stillSuppressed.suppressReason).toBe('complaint');
    expect(capturedFor(complainer.email, NEWSLETTER_CONFIRM_EMAIL_SUBJECT)).toHaveLength(0);

    // STEP 9 — re-running the dispatch job for the already-sent issue two
    // sends nothing new (natural idempotency).
    const messagesBefore = listCapturedEmails().length;
    const rerun = await runDispatch(issue2);
    expect(rerun.kind).toBe('ok');
    expect(await deliveryRows(issue2)).toHaveLength(2);
    expect(listCapturedEmails()).toHaveLength(messagesBefore);
    const issue2Rerun = await issueRow(issue2);
    expect(issue2Rerun.sentCount).toBe(2);
  });
});
