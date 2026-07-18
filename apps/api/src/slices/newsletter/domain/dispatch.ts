import { z } from 'zod';
import { NEWSLETTER_DEFAULT_TOPIC } from '@hushbox/shared';
import { enqueueWithinTx, jobOutcome } from '../../../lib/jobs/index.js';
import { renderIssueEmail } from './issue-email.js';
import type { DbWriter } from '../../../lib/idempotency/transaction.js';
import type {
  EnqueueJobResult,
  JobOutcome,
  JobRegistration,
  JobRegistry,
} from '../../../lib/jobs/index.js';
import type { BatchEmailSender } from '../../notifications/index.js';
import type { DeliveryTarget, NewsletterDispatchStore } from '../ports/index.js';
import type { IssueEmailUrls } from './issue-email.js';

export const NEWSLETTER_DISPATCH_JOB_TYPE = 'newsletter.dispatch.v1';

/**
 * Only transient provider failures consume the budget (a failed batch send);
 * every terminal issue state maps to `ok`. Sibling precedent:
 * `media.reclaimUser.v1`.
 */
export const NEWSLETTER_DISPATCH_MAX_FAILURES = 8;

/** Resend's `/emails/batch` hard cap — also the default dispatch batch size. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * `nextBatchIndex` is the yield checkpoint: the executor replaces the payload
 * with the checkpoint, so completed batches are skipped by construction on
 * the next claim (and re-verified by the delivery-row fence regardless).
 */
export const newsletterDispatchPayloadSchema = z.object({
  issueId: z.uuid(),
  nextBatchIndex: z.number().int().min(0).default(0),
});

type DispatchPayload = z.infer<typeof newsletterDispatchPayloadSchema>;

export interface NewsletterDispatchDeps {
  readonly store: NewsletterDispatchStore;
  readonly sender: BatchEmailSender;
  readonly urls: IssueEmailUrls;
  /** The list this dispatch serves; the launch topic unless bound otherwise. */
  readonly topic?: string | undefined;
  /** Test seam, only narrowing-down; never above the provider cap. */
  readonly batchSize?: number | undefined;
}

/**
 * The admin scheduling op's enqueue, atomic with its issue insert: the jobs
 * row lands in the caller's transaction, first attempted at `scheduledAt`,
 * deduped so one issue can never carry two active dispatch rows.
 */
export function enqueueIssueDispatch(
  tx: DbWriter,
  registry: JobRegistry,
  params: { readonly issueId: string; readonly scheduledAt: Date }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: NEWSLETTER_DISPATCH_JOB_TYPE,
    payload: { issueId: params.issueId, nextBatchIndex: 0 },
    dedupeKey: `newsletter.dispatch:${params.issueId}`,
    scheduledAt: params.scheduledAt,
  });
}

function terminalOutcomeFor(kind: 'missing' | 'canceled' | 'sent' | 'not-due'): JobOutcome {
  switch (kind) {
    case 'missing': {
      return jobOutcome.dead('dispatch issue does not exist');
    }
    case 'canceled': {
      return jobOutcome.ok('canceled');
    }
    case 'sent': {
      return jobOutcome.ok('already-sent');
    }
    case 'not-due': {
      // An early wake; the retry backoff carries it forward.
      return jobOutcome.fail('dispatch issue is not yet due');
    }
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * `newsletter.dispatch.v1` — sends one issue to every subscribed recipient.
 *
 * Idempotency is layered, `natural` class:
 * - the issue's atomic `scheduled → sending` claim admits exactly one live run
 *   (lease-reclaimed retries re-enter through the `sending` branch);
 * - each recipient's delivery row (`UNIQUE(issueId, subscriberId)`, inserted
 *   `claimed` before any send) is the per-recipient fence — rows already
 *   `sent` are never re-marked, and a batch whose rows are all finished is
 *   skipped without a provider call;
 * - each batch's send carries the deterministic `newsletter:{issueId}:{index}`
 *   Idempotency-Key, and a retry re-sends the FULL batch under that same key:
 *   the provider replays the original accepted request (delivering at most
 *   once per recipient) and returns the original index-matched ids, which is
 *   what lets the retry finish `claimed`-but-unsent rows safely.
 *
 * Batch composition is frozen at claim time: the winning `scheduled →
 * sending` transition inserts every delivery row in its own transaction, and
 * no later attempt inserts any — batches derive solely from those rows
 * (ordered by subscriberId), immutable for the issue's lifetime. A subscriber
 * who joins mid-dispatch is simply not in this issue; one who unsubscribes
 * keeps their row (they were subscribed at the freeze).
 *
 * Batches send sequentially (the provider's 5 req/s budget) with a `yield`
 * checkpoint after each, so long lists consume no failure budget.
 */
export function createNewsletterDispatchJobRegistration(
  deps: NewsletterDispatchDeps
): JobRegistration<typeof newsletterDispatchPayloadSchema> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > DEFAULT_BATCH_SIZE) {
    throw new Error(
      `newsletter dispatch: batchSize must be an integer between 1 and ${String(DEFAULT_BATCH_SIZE)}`
    );
  }
  const topic = deps.topic ?? NEWSLETTER_DEFAULT_TOPIC;

  async function sendBatch(
    issue: { readonly subject: string; readonly bodyMarkdown: string },
    issueId: string,
    batchIndex: number,
    batch: readonly DeliveryTarget[]
  ): Promise<JobOutcome | null> {
    const unfinished = batch.filter((target) => target.status !== 'sent');
    if (unfinished.length === 0) return null;

    // The FULL batch replays under the fixed key (see the registration doc);
    // only unfinished rows are (re-)marked from the index-matched response.
    const messages = batch.map((target) => {
      const rendered = renderIssueEmail({
        subject: issue.subject,
        bodyMarkdown: issue.bodyMarkdown,
        unsubscribeToken: target.unsubscribeToken,
        urls: deps.urls,
      });
      return { to: target.email, ...rendered };
    });
    const sent = await deps.sender.sendBatch(messages, {
      idempotencyKey: `newsletter:${issueId}:${String(batchIndex)}`,
    });
    if (sent.isErr()) {
      await deps.store.markDeliveries(
        unfinished
          .filter((target) => target.status === 'claimed')
          .map((target) => target.deliveryId),
        'failed'
      );
      return jobOutcome.fail(`newsletter batch send failed: ${sent.error.code}`);
    }
    const resendIdByDeliveryId = new Map(
      // The adapters reject a response whose id count mismatches the batch,
      /* v8 ignore next -- so the `?? ''` arm only narrows the indexed type */
      batch.map((target, index) => [target.deliveryId, sent.value.ids[index] ?? ''])
    );
    await deps.store.markDeliveries(
      unfinished.map((target) => target.deliveryId),
      'sent',
      resendIdByDeliveryId
    );
    return null;
  }

  return {
    type: NEWSLETTER_DISPATCH_JOB_TYPE,
    schema: newsletterDispatchPayloadSchema,
    leaseSeconds: 300,
    maxFailures: NEWSLETTER_DISPATCH_MAX_FAILURES,
    idempotency: 'natural',
    shard: 'bulk',
    handler: async (execution): Promise<JobOutcome> => {
      const { issueId, nextBatchIndex }: DispatchPayload = execution.payload;
      const claim = await deps.store.claimIssue(issueId, topic, new Date());
      if (claim.kind !== 'claimed') {
        return terminalOutcomeFor(claim.kind);
      }

      const targets = await deps.store.loadTargets(issueId);
      const batches = chunk(targets, batchSize);

      for (let index = nextBatchIndex; index < batches.length; index += 1) {
        if ((await execution.heartbeat()) === 'lost') {
          return jobOutcome.fail('newsletter dispatch lease lost mid-run');
        }
        const batch = batches[index];
        /* v8 ignore next -- unreachable: `index < batches.length` bounds the read */
        if (batch === undefined) break;
        const failure = await sendBatch(claim, issueId, index, batch);
        if (failure !== null) return failure;
        if (index < batches.length - 1) {
          return jobOutcome.yield({ issueId, nextBatchIndex: index + 1 });
        }
      }

      await deps.store.completeIssue(issueId, new Date());
      return jobOutcome.ok('sent');
    },
  };
}
