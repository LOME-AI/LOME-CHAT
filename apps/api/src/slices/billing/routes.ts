import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  ERROR_CODES,
  serializeNanoUSD,
  nanoUSD,
} from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  applyPaymentWebhookEvent,
  callerUserId,
  createErrorResponse,
  idempotencyExempt,
  idempotent,
  initiateCardPayment,
  initiatePaymentBodySchema,
  okAsync,
  payerUserId,
  readBalance,
  readIdempotencyKey,
  readUsageBreakdown,
  recordPaymentWebhookEvidence,
  runMutation,
  usageBreakdownQuerySchema,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Database } from '@hushbox/db';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  AccountDefensePort,
  AccountLockedEmailPort,
  BillingStores,
  DomainError,
  DomainErrorCode,
  JobRegistry,
  PaymentProvider,
  PaymentWebhookApplication,
  WebhookVerifier,
} from './domain/index.js';

export interface BillingRouteDeps {
  readonly stores: BillingStores;
  /** Env-selected at request time (mock locally, Helcim otherwise). */
  readonly paymentProvider: (env: AppEnv['Bindings']) => PaymentProvider;
  /** Fail-closed Helcim signature verification — never optional. */
  readonly webhookVerifier: (env: AppEnv['Bindings']) => WebhookVerifier;
  /**
   * Carries the `payment.verify.v1` registration for the pre-claim enqueue.
   * Either a ready registry (tests pass one directly) or a per-request factory
   * — the composition root has no module-scope DB, so it builds the registry
   * from `c.var.db` per request (the registration's DB is unused at enqueue,
   * which only reads the registered schema/lease/shard).
   */
  readonly jobRegistry: JobRegistry | ((env: AppEnv['Bindings'], db: Database) => JobRegistry);
  readonly accountDefense: AccountDefensePort;
  readonly accountLockedEmail: AccountLockedEmailPort;
  /**
   * The lossy post-commit dispatcher nudge, fired via `waitUntil` after a
   * successful pre-claim commit (never inside the transaction, never on
   * rollback). Optional so a test app can omit it; the dispatcher's perpetual
   * alarm is the delivery guarantee, so a missing nudge only costs latency.
   */
  readonly wakeDispatcher?: (env: AppEnv['Bindings']) => Promise<void> | void;
}

/** Resolves the enqueue registry: a ready registry, or the per-request factory built from `c.var.db`. */
function resolveJobRegistry(
  jobRegistry: BillingRouteDeps['jobRegistry'],
  env: AppEnv['Bindings'],
  db: Database
): JobRegistry {
  return typeof jobRegistry === 'function' ? jobRegistry(env, db) : jobRegistry;
}

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 504,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. Typed
 * with hono's base `Env` because the hook's `E` is not inferred from the
 * route chain (the conversations slice precedent).
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The pipeline enforced the header before the handler ran; absence here is a
 * composition defect, not a client error.
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('billing: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The caller's network address for Helcim's card-token purchase API. The
 * `cf-connecting-ip` header is absent outside Cloudflare (local dev, tests),
 * so a neutral placeholder fills Helcim's required field there.
 */
function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? '0.0.0.0';
}

/**
 * Records the webhook application where the byEventId envelope can replay it,
 * yielding the wrapper's claimed flag.
 */
function recordApplication(holder: {
  application: PaymentWebhookApplication;
}): (value: PaymentWebhookApplication) => boolean {
  return (value) => {
    holder.application = value;
    return value.claimed;
  };
}

/**
 * The billing slice's HTTP surface: the balance read, the Pattern-D charge
 * initiation, and the signature-gated payment webhook. The return type is
 * deliberately inferred: annotating it with a bare `Hono<AppEnv>` widens the
 * routes to `BlankSchema` and erases the route schema from `AppType` (the
 * typed client goes blind to this slice).
 */
export function createBillingManifest(deps: BillingRouteDeps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>()
      .get('/balance', routeClass('session'), async (c) => {
        const userId = callerUserId(c.var.principal);
        const result = await readBalance(deps.stores, c.var.db, userId, new Date());
        return result.match(
          (balance) =>
            c.json(
              {
                purchased: { balanceNanoUsd: serializeNanoUSD(nanoUSD(balance.purchasedNanoUsd)) },
                free: { balanceNanoUsd: serializeNanoUSD(nanoUSD(balance.freeNanoUsd)) },
                allowance: {
                  day: balance.allowance.day,
                  limitNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.limitNanoUsd)),
                  spentNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.spentNanoUsd)),
                  remainingNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.remainingNanoUsd)),
                },
              },
              200
            ),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/usage',
        routeClass('session'),
        zValidator('query', usageBreakdownQuerySchema, rejectInvalid),
        async (c) => {
          // Session-scoped by the pipeline principal — never client input, so
          // a caller can only ever read their own usage.
          const userId = callerUserId(c.var.principal);
          const { cursor, limit } = c.req.valid('query');
          const result = await readUsageBreakdown(deps.stores, c.var.db, {
            userId,
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (page) =>
              c.json(
                {
                  models: page.models.map((model) => ({
                    modelId: model.modelId,
                    totalNanoUsd: serializeNanoUSD(nanoUSD(model.totalNanoUsd)),
                    recordCount: model.recordCount,
                    estimatedCount: model.estimatedCount,
                  })),
                  nextCursor: page.nextCursor,
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/payments',
        // billing-token: the mobile → web handoff pays with a billing-only
        // session, so the charge route admits both session kinds.
        routeClass('billing-token'),
        zValidator('json', initiatePaymentBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            initiateCardPayment(
              {
                db: c.var.db,
                stores: deps.stores,
                provider: deps.paymentProvider(c.env),
                registry: resolveJobRegistry(deps.jobRegistry, c.env, c.var.db),
              },
              {
                userId: payerUserId(c.var.principal),
                amountNanoUsd: body.amountNanoUsd,
                cardToken: body.cardToken,
                customerCode: body.customerCode,
                ipAddress: clientIp(c),
                idempotencyKey: requiredIdempotencyKey(c),
                now: new Date(),
              }
            )
          );
          return result.match(
            (outcome) => {
              // Post-commit only: the pre-claim (and its `payment.verify.v1`
              // enqueue) have committed, so the lossy nudge is safe to fire and
              // never runs on the rollback (error) branch below.
              if (deps.wakeDispatcher !== undefined) {
                c.executionCtx.waitUntil(Promise.resolve(deps.wakeDispatcher(c.env)));
              }
              return c.json(
                {
                  paymentId: outcome.paymentId,
                  status: outcome.status,
                  amountNanoUsd: serializeNanoUSD(nanoUSD(outcome.amountNanoUsd)),
                },
                200
              );
            },
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/webhooks/payment',
        routeClass('public'),
        idempotencyExempt('webhook-event-id'),
        async (c) => {
          const rawBody = await c.req.text();
          const verified = await deps.webhookVerifier(c.env).verify(rawBody, {
            signature: c.req.header('webhook-signature'),
            timestamp: c.req.header('webhook-timestamp'),
            webhookId: c.req.header('webhook-id'),
          });
          if (verified.isErr()) return respondDomainError(c, verified.error);
          await recordPaymentWebhookEvidence(c.var.db, c.var.envUtils.isCI);
          const event = verified.value;
          // The claim runs the whole fenced application (the money claim and
          // its effect must share one transaction); execute/onDuplicate only
          // pass the recorded application through the byEventId shape.
          const holder: { application: PaymentWebhookApplication } = {
            application: { claimed: false, disposition: { kind: 'ignored' } },
          };
          const result = await runMutation(() =>
            idempotent.byEventId({
              claim: () =>
                applyPaymentWebhookEvent(
                  {
                    db: c.var.db,
                    stores: deps.stores,
                    accountDefense: deps.accountDefense,
                    accountLockedEmail: deps.accountLockedEmail,
                  },
                  event
                ).map(recordApplication(holder)),
              execute: () => okAsync<PaymentWebhookApplication, DomainError>(holder.application),
              onDuplicate: () =>
                okAsync<PaymentWebhookApplication, DomainError>(holder.application),
            })
          );
          return result.match(
            (value) => {
              // A completed event racing ahead of the charge finalize has no
              // row yet — non-2xx makes the provider redeliver; the verify
              // job remains the guaranteed reconciler.
              if (value.disposition.kind === 'unmatched') {
                return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
              }
              if (value.disposition.kind === 'ignored') {
                c.var.logger.warn('unrecognized payment webhook event ignored');
              }
              if (value.disposition.kind === 'notify-only') {
                // Covers every dispute that takes no money or lock action:
                // inquiries, retrievals, and chargebacks/reversals on payments
                // that never completed (no captured funds to claw back, no
                // capture fraud warranting a lock). Admin notification lands
                // with the admin plane; until then the log line is the watcher.
                c.var.logger.warn('payment dispute surfaced, no action taken');
              }
              return c.json({ received: true }, 200);
            },
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
