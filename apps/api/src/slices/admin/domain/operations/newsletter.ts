import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError, notFoundError, validationError } from '../../../../lib/errors/index.js';
import { err, ok, okAsync } from '../../../../lib/result/index.js';
import { wakeJobDispatcher } from '../../../../lib/jobs/index.js';
import { cancelIssueWithinTx, createIssueWithinTx } from '../../../newsletter/index.js';
import { defineAdminOp } from '../registry.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { SettlementTx } from '../../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobDispatcherNamespace } from '../../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { NewsletterIssueRow } from '../../../newsletter/index.js';
import type { AdminOpsClock } from './user.js';

/**
 * The newsletter issue lifecycle ops — the durable pair `newsletter.schedule`
 * ↔ `newsletter.cancel` plus the ephemeral `newsletter.testSend` — composed
 * from the newsletter slice's published within-tx surface. Schedule commits
 * the issue row and its dispatch job together in the settlement transaction
 * (both roll back in preview); cancel's undo re-schedules an IDENTICAL fresh
 * issue from the snapshot captured at cancel time (inverse snapshot
 * semantics), so undoing a cancel whose scheduledAt has already passed fails
 * schedule's future gate naturally — deliberate, pinned by test.
 */

const scheduleContract = ADMIN_OP_CONTRACTS['newsletter.schedule'];
const cancelContract = ADMIN_OP_CONTRACTS['newsletter.cancel'];
const testSendContract = ADMIN_OP_CONTRACTS['newsletter.testSend'];

export interface AdminNewsletterDeps {
  readonly clock: AdminOpsClock;
  /**
   * The acting admin's allowlisted Access email (the Single Auth Path
   * identity) — recorded as the issue's `createdBy` and the test-send
   * recipient. Always engine-request identity, never an input field.
   */
  actorEmail(): string;
  /** Carries the post-commit wake for the dispatch job's bulk shard. */
  readonly jobDispatcher: JobDispatcherNamespace;
  /** Curried over the composition root's job registry (the dispatch registration). */
  readonly newsletterDispatch: {
    enqueueWithinTx(
      tx: SettlementTx,
      params: { readonly issueId: string; readonly scheduledAt: Date }
    ): Promise<EnqueueJobResult>;
  };
  /** Within-tx issue read for cancel's inverse snapshot (a base-db read
   * inside the open settlement transaction would self-deadlock on the
   * max-1 connection pool, so the read must ride `ctx.tx`). */
  readonly newsletterIssueReader: {
    readWithinTx(tx: SettlementTx, issueId: string): Promise<NewsletterIssueRow | null>;
  };
  /** The rendered-issue test email over the composed EmailSender port. */
  readonly newsletterTestEmail: {
    send(params: {
      readonly subject: string;
      readonly bodyMarkdown: string;
      readonly to: string;
    }): ResultAsync<void, DomainError>;
  };
}

export const newsletterSchedule = defineAdminOp<
  AdminNewsletterDeps,
  (typeof scheduleContract)['input']
>(scheduleContract, {
  execute: async (ctx, input) => {
    const scheduledAt = new Date(input.scheduledAt);
    // Injected clock — op-body modules may not call `Date.now()` (purity lint).
    if (scheduledAt.getTime() <= ctx.deps.clock.now().getTime()) {
      return err(validationError('newsletter issue must be scheduled in the future'));
    }
    const issue = await createIssueWithinTx(ctx.tx, {
      subject: input.subject,
      bodyMarkdown: input.bodyMarkdown,
      scheduledAt,
      createdBy: ctx.deps.actorEmail(),
    });
    await ctx.deps.newsletterDispatch.enqueueWithinTx(ctx.tx, { issueId: issue.id, scheduledAt });
    const namespace = ctx.deps.jobDispatcher;
    ctx.registerEphemeral({
      name: 'newsletter.schedule.wake',
      // The lossy post-commit nudge for the bulk-shard dispatch job: a fresh
      // stack's bulk shard has no alarm armed until first contact, so without
      // it a scheduled issue waits for an unrelated wake (or the 15-minute
      // auditor). Lost wakes recover via the dispatcher's perpetual alarm
      // (wakeJobDispatcher swallows failures) — the job.redrive precedent.
      run: () => wakeJobDispatcher(namespace, 'bulk'),
    });
    return ok({
      effects: [
        {
          label: 'newsletter.issue',
          before: null,
          // No issue id here: preview and execute run in separate rolled-back
          // vs committed transactions, so a generated id would break the
          // preview ≡ execute battery. The id rides `target`/`inverseInput`.
          after: {
            subject: issue.subject,
            status: issue.status,
            scheduledAt: issue.scheduledAt.toISOString(),
          },
        },
      ],
      target: { type: 'newsletterIssue', id: issue.id },
      inverseInput: { issueId: issue.id, reason: 'undo of newsletter.schedule' },
    });
  },
});

export const newsletterCancel = defineAdminOp<
  AdminNewsletterDeps,
  (typeof cancelContract)['input']
>(cancelContract, {
  execute: async (ctx, input) => {
    const outcome = await cancelIssueWithinTx(ctx.tx, input.issueId);
    if (outcome.kind === 'not-found') {
      return err(notFoundError('newsletter issue does not exist'));
    }
    if (outcome.kind === 'illegal-state') {
      return err(conflictError('newsletter issue dispatch has already begun'));
    }
    // The snapshot read happens after the conditional cancel, inside the same
    // transaction snapshot: the row is known to exist and its content columns
    // are immutable, so a missing row here is a defect, not a state.
    const issue = await ctx.deps.newsletterIssueReader.readWithinTx(ctx.tx, input.issueId);
    /* v8 ignore next 3 -- unreachable: the cancel above saw the row in this same transaction snapshot */
    if (issue === null) {
      throw new Error('newsletter.cancel: issue row vanished within its own transaction');
    }
    return ok({
      effects: [
        {
          label: 'newsletter.issue.status',
          before: outcome.kind === 'canceled' ? 'scheduled' : 'canceled',
          after: 'canceled',
        },
      ],
      target: { type: 'newsletterIssue', id: input.issueId },
      inverseInput: {
        subject: issue.subject,
        bodyMarkdown: issue.bodyMarkdown,
        scheduledAt: issue.scheduledAt.toISOString(),
        reason: 'undo of newsletter.cancel',
      },
    });
  },
});

export const newsletterTestSend = defineAdminOp<
  AdminNewsletterDeps,
  (typeof testSendContract)['input']
>(testSendContract, {
  execute: (ctx, input) => {
    const to = ctx.deps.actorEmail();
    const { newsletterTestEmail } = ctx.deps;
    // Post-commit ephemeral: the op body performs no external call (the send
    // runs only after the audit row commits, never in preview), and a send
    // failure is captured telemetry, never a failed op.
    ctx.registerEphemeral({
      name: 'newsletter.testSend.email',
      run: async (): Promise<void> => {
        const sent = await newsletterTestEmail.send({
          subject: input.subject,
          bodyMarkdown: input.bodyMarkdown,
          to,
        });
        if (sent.isErr()) {
          throw new Error(`newsletter test send failed: ${sent.error.code}`);
        }
      },
    });
    return okAsync({
      effects: [{ label: 'newsletter.testSend', after: { subject: input.subject, to } }],
    });
  },
});
