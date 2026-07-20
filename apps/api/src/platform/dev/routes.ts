import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { newsletterSubscribers, sharedMessages, users } from '@hushbox/db';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES, NewsletterStatus } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from '../../middleware/pipeline-admin.js';
import { setVersionOverride } from '../../middleware/version-override.js';
import { createErrorResponse, notFoundError, unavailableError } from '../../lib/errors/index.js';
import { idempotencyExempt, idempotent, runMutation } from '../../lib/idempotency/index.js';
import { fromPromise } from '../../lib/result/index.js';
import { listFeedbackForUser } from '../../slices/feedback/index.js';
import { createIdentityStores } from '../../slices/identity/index.js';
import { createR2StorageFromEnv } from '../../slices/media/index.js';
import {
  accountDeletedEmail,
  accountLockedEmail,
  adminDailyDigestEmail,
  adminOpNotificationEmail,
  chargebackLockEmail,
  findCapturedEmail,
  listCapturedEmails,
  newsletterConfirmationEmail,
  newsletterIssueEmail,
  passwordChangedEmail,
  passwordResetEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
  verificationEmail,
  welcomeEmail,
} from '../../slices/notifications/index.js';
import { mintNewsletterSubscribers } from './newsletter-fixtures.js';
import {
  DevSeedError,
  requireSeed,
  createDevConversation,
  createDevGroupChat,
  createDevMediaConversation,
  createDevMultiModelConversation,
  pickSeedTextModels,
} from './factories.js';
import { ADMIN_TARGET_KINDS, mintAdminTargets } from './mint-admin-targets.js';
import { listDevPersonas } from './personas.js';
import { conversationCost, countLlmCompletions, listMessagePayers } from './reads.js';
import {
  clearTotpReplayMarkers,
  resetAuthRateLimits,
  resetTrialUsage,
  resetUsageRateLimits,
} from './redis-resets.js';
import { DevWalletNotFoundError, setWalletBalance } from './wallet.js';
import type { Context, Env } from 'hono';
import type { Database } from '@hushbox/db';
import type { Storage } from '../../slices/media/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ResultAsync } from '../../lib/result/index.js';
import type { DomainError, DomainErrorCode } from '../../lib/errors/index.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/** One shared err-arm for every route's `result.match` (all map identically). */
function domainErrorResponder(c: Context<AppEnv>): (error: DomainError) => Response {
  return (error) => respondDomainError(c, error);
}

/** Malformed input answers the uniform `{code}` body (hook typed with hono's base Env). */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * Dev tooling promises lifted into the Result channel: the seed factories'
 * 404-shaped errors (unknown persona/wallet — expected E2E states) map to
 * `not_found`; anything else is `unavailable`.
 */
function liftDevWork<T>(work: Promise<T>): ResultAsync<T, DomainError> {
  return fromPromise(work, (cause) =>
    cause instanceof DevSeedError || cause instanceof DevWalletNotFoundError
      ? notFoundError('dev route target not found', cause)
      : unavailableError('dev route work failed', cause)
  );
}

const conversationBodySchema = z.object({
  ownerEmail: z.email(),
  messages: z
    .array(z.object({ content: z.string(), senderType: z.enum(['user', 'ai']) }))
    .optional(),
  // Multi-model fan-out seed: one user prompt with `responseCount` sibling
  // AI tiles; when present it takes the multi-model path.
  aiTurn: z.object({ userContent: z.string(), responseCount: z.number().int().min(1) }).optional(),
});

const groupChatBodySchema = z.object({
  ownerEmail: z.email(),
  memberEmails: z.array(z.email()),
  pendingMemberEmails: z.array(z.email()).optional(),
  messages: z
    .array(
      z.object({
        senderEmail: z.email().optional(),
        content: z.string(),
        senderType: z.enum(['user', 'ai']),
      })
    )
    .optional(),
});

/**
 * The email-template preview gallery served at `GET /dev/emails` and rendered
 * (one iframe per entry) by the web `dev/emails` route. Sample params mirror
 * the notifications-slice template schemas; the response carries only the
 * rendered `html`, never a real send.
 */
const EMAIL_TEMPLATE_PREVIEWS: readonly { name: string; label: string; render: () => string }[] = [
  {
    name: 'verification',
    label: 'Email Verification',
    render: (): string =>
      verificationEmail({
        verificationUrl: 'https://hushbox.ai/verify?token=sample-token-abc123',
        userName: 'Alice',
        expiresInHours: 24,
      }).html,
  },
  {
    name: 'password-changed',
    label: 'Password Changed',
    render: (): string => passwordChangedEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'password-reset',
    label: 'Password Reset',
    render: (): string => passwordResetEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'two-factor-enabled',
    label: 'Two-Factor Enabled',
    render: (): string => twoFactorEnabledEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'two-factor-disabled',
    label: 'Two-Factor Disabled',
    render: (): string => twoFactorDisabledEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'account-locked',
    label: 'Account Locked',
    render: (): string => accountLockedEmail({ userName: 'Alice', lockoutMinutes: 15 }).html,
  },
  {
    name: 'welcome',
    label: 'Welcome',
    render: (): string => welcomeEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'account-deleted',
    label: 'Account Deleted',
    render: (): string => accountDeletedEmail({}).html,
  },
  {
    name: 'chargeback-lock',
    label: 'Chargeback Lock',
    render: (): string => chargebackLockEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'admin-op-notification',
    label: 'Admin Op Notification',
    render: (): string =>
      adminOpNotificationEmail({
        opName: 'user.lock',
        actorEmail: 'admin@hushbox.ai',
        targetType: 'user',
        targetId: '01890a5d-ac96-774b-bcce-b302099a8057',
        reason: 'Chargeback dispute on payment pay_1234',
        occurredAt: '2026-07-17T09:30:00Z',
        isUndo: false,
        auditId: '01890a5d-ac96-774b-bcce-b302099a8058',
      }).html,
  },
  {
    name: 'admin-daily-digest',
    label: 'Admin Daily Digest',
    render: (): string =>
      adminDailyDigestEmail({
        day: '2026-07-17',
        actions: [
          {
            opName: 'user.lock',
            actorEmail: 'admin@hushbox.ai',
            targetType: 'user',
            targetId: '01890a5d-ac96-774b-bcce-b302099a8057',
            occurredAt: '2026-07-17T09:30:00Z',
          },
          {
            opName: 'job.redrive',
            actorEmail: 'admin@hushbox.ai',
            targetType: 'job',
            targetId: '01890a5d-ac96-774b-bcce-b302099a8059',
            occurredAt: '2026-07-17T14:05:00Z',
          },
        ],
      }).html,
  },
  {
    name: 'newsletter-confirmation',
    label: 'Newsletter Confirmation',
    render: (): string =>
      newsletterConfirmationEmail({
        confirmUrl: 'https://hushbox.ai/newsletter/confirm?token=sample-token-abc123',
      }).html,
  },
  {
    name: 'newsletter-issue',
    label: 'Newsletter Issue',
    render: (): string =>
      newsletterIssueEmail({
        subject: 'What shipped this month',
        bodyMarkdown: [
          '## New this month',
          '',
          'We shipped **group conversations** and a faster composer.',
          '',
          'Read the full changelog at [hushbox.ai/blog](https://hushbox.ai/blog).',
        ].join('\n'),
        unsubscribeUrl: '#',
      }).html,
  },
];

/** Distinct, positive seed costs ((2+i)/1000 USD) so cost badges render. */
function multiModelCostNanoUsd(index: number): bigint {
  return BigInt(2 + index) * 1_000_000n;
}

/** The media seed's fixed content-item cost (0.003 USD). */
const MEDIA_SEED_COST_NANO_USD = 3_000_000n;

type ConversationBody = z.infer<typeof conversationBodySchema>;
type GroupChatBody = z.infer<typeof groupChatBodySchema>;

async function seedConversationWork(
  db: Database,
  logger: Telemetry,
  body: ConversationBody
): Promise<{ conversationId: string }> {
  const { aiTurn, ...rest } = body;
  if (aiTurn !== undefined) {
    const models = await pickSeedTextModels(db, logger, aiTurn.responseCount);
    return createDevMultiModelConversation(db, {
      ownerEmail: rest.ownerEmail,
      userContent: aiTurn.userContent,
      aiResponses: models.map((modelName, index) => ({
        content: `Echo: ${aiTurn.userContent}`,
        modelName,
        costNanoUsd: multiModelCostNanoUsd(index),
      })),
    });
  }
  const [seedAiModel] = await pickSeedTextModels(db, logger, 1);
  return createDevConversation(db, {
    ownerEmail: rest.ownerEmail,
    seedAiModel: requireSeed(seedAiModel, 'seed model'),
    ...(rest.messages === undefined ? {} : { messages: rest.messages }),
  });
}

async function seedMediaWork(
  db: Database,
  storage: Storage,
  logger: Telemetry,
  body: { ownerEmail: string; userContent: string; mediaType: 'image' | 'video' }
): Promise<{ conversationId: string; assistantMessageId: string }> {
  const [modelId] = await pickSeedTextModels(db, logger, 1);
  return createDevMediaConversation(db, storage, {
    ...body,
    modelId: requireSeed(modelId, 'seed model'),
    costNanoUsd: MEDIA_SEED_COST_NANO_USD,
  });
}

async function seedGroupChatWork(
  db: Database,
  logger: Telemetry,
  body: GroupChatBody
): Promise<{
  conversationId: string;
  members: { userId: string; username: string; email: string }[];
}> {
  const { messages: rawMessages, pendingMemberEmails, ...rest } = body;
  const [seedAiModel] = await pickSeedTextModels(db, logger, 1);
  return createDevGroupChat(db, {
    ...rest,
    seedAiModel: requireSeed(seedAiModel, 'seed model'),
    ...(pendingMemberEmails === undefined ? {} : { pendingMemberEmails }),
    ...(rawMessages === undefined ? {} : { messages: rawMessages }),
  });
}

async function revokeShareWork(db: Database, shareId: string): Promise<{ rowsAffected: number }> {
  const deleted = await db.delete(sharedMessages).where(eq(sharedMessages.id, shareId));
  return { rowsAffected: deleted.rowCount ?? 0 };
}

function setVersionWork(version: string): Promise<{ version: string }> {
  setVersionOverride(version);
  return Promise.resolve({ version });
}

/**
 * The E2E tooling family. Every route is `dev-only` (404 in production).
 * Mutating routes declare the `naturally-idempotent` exemption — the legacy
 * E2E callers send no Idempotency-Key — and run through `idempotent.byUpsert`
 * as dev-tooling convergent writes (the seed factories mint fresh uuids, so
 * a repeat creates a fresh fixture rather than duplicating a domain effect;
 * the resets and setters genuinely converge on the same end state).
 *
 * Two legacy dev routes are deliberately NOT ported and must not be re-added:
 * `DELETE /dev/test-data` (bulk test-data wipe) is superseded by per-test DB
 * isolation + `pnpm db:reset`; `POST /dev/expire-session` (destroy the session
 * cookie) is superseded by the real `/logout` route and session revocation.
 * Their absence is a decision, not an accidental gap.
 */
export function createDevManifest() {
  return defineSliceManifest({
    basePath: '/dev',
    routes: new Hono<AppEnv>()
      // The dev-admin mint: an Access-shaped JWT for a
      // chosen email, signed by the committed dev key, so the SPA/CLI/e2e
      // drive the REAL jose verification stage locally. Choosing the email
      // gives actor switching; a non-allowlisted email mints fine and is then
      // refused by verification — itself a useful denial fixture. Read-shaped
      // (GET, no state written), so no idempotency concern. Production is
      // safe twice over: this class 404s there, and the production env
      // registry carries no dev signing key to mint with.
      .get(
        '/admin-token',
        routeClass('dev-only'),
        zValidator('query', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const token = await mintDevAdminToken(c.env, { email: c.req.valid('query').email });
          return c.json({ token, header: CF_ACCESS_JWT_HEADER });
        }
      )
      .get(
        '/personas',
        routeClass('dev-only'),
        zValidator('query', z.object({ type: z.enum(['test', 'dev']).optional() }), rejectInvalid),
        async (c) => {
          const { type } = c.req.valid('query');
          const personas = await listDevPersonas(c.var.db, type ?? 'dev');
          return c.json({ personas });
        }
      )
      .post(
        '/conversation',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', conversationBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(seedConversationWork(c.var.db, c.var.logger, c.req.valid('json')))
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/media-conversation',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            ownerEmail: z.email(),
            userContent: z.string(),
            mediaType: z.enum(['image', 'video']),
          }),
          rejectInvalid
        ),
        async (c) => {
          const storage = createR2StorageFromEnv(c.env, c.var.db);
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(seedMediaWork(c.var.db, storage, c.var.logger, c.req.valid('json')))
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/group-chat',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', groupChatBodySchema, rejectInvalid),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(seedGroupChatWork(c.var.db, c.var.logger, c.req.valid('json')))
            )
          );
          return result.match((created) => c.json(created, 201), domainErrorResponder(c));
        }
      )
      // Fresh admin-op target rows (unique ids per call) so parallel E2E
      // specs mutate their own targets instead of racing over the fixed
      // seeded set (`seedAdminOpTargets`). Minting only what's asked keeps
      // specs fast; minted users are disposable, never OPAQUE-loginable.
      .post(
        '/admin-targets',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({ kinds: z.array(z.enum(ADMIN_TARGET_KINDS)).min(1) }),
          rejectInvalid
        ),
        async (c) => {
          const { kinds } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(mintAdminTargets(c.var.db, kinds)))
          );
          return result.match((minted) => c.json(minted, 201), domainErrorResponder(c));
        }
      )
      .post(
        '/wallet-balance',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            email: z.email(),
            walletType: z.enum(['purchased', 'free_tier']),
            balance: z.string().min(1),
          }),
          rejectInvalid
        ),
        async (c) => {
          const params = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(setWalletBalance(c.var.db, c.var.redis, params)))
          );
          return result.match(
            (outcome) => c.json({ success: true, newBalance: outcome.newBalance }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/trial-usage',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetTrialUsage(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/auth-rate-limits',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetAuthRateLimits(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/usage-rate-limits',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(resetUsageRateLimits(c.var.redis)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .delete(
        '/totp-replay',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('json');
          const [user] = await c.var.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
          if (user === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(clearTotpReplayMarkers(c.var.redis, user.id)))
          );
          return result.match(
            (outcome) => c.json({ success: true, deleted: outcome.deleted }),
            domainErrorResponder(c)
          );
        }
      )
      .post(
        '/set-version',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ version: z.string().min(1) }), rejectInvalid),
        async (c) => {
          const { version } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(setVersionWork(version)))
          );
          return result.match(
            (outcome) => c.json({ success: true, version: outcome.version }, 200),
            domainErrorResponder(c)
          );
        }
      )
      .get(
        '/verify-token/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const token = await createIdentityStores(
            c.var.db
          ).verification.findLatestVerificationToken(email.toLowerCase(), new Date());
          return token.match(
            (value) =>
              value === null
                ? c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404)
                : c.json({ token: value }),
            domainErrorResponder(c)
          );
        }
      )
      // E2E read-back for feedback persistence: the submit endpoint is
      // session-class (dev routes are anonymous), so the caller identity comes
      // from a path-param email, never a principal. 404s in production via the
      // dev-only class.
      .get(
        '/feedback/by-email/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const [user] = await c.var.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email.toLowerCase()));
          if (user === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          const result = await listFeedbackForUser(c.var.db, user.id);
          return result.match((rows) => c.json({ rows }), domainErrorResponder(c));
        }
      )
      .get(
        '/llm-completions-count/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          return c.json({ count: await countLlmCompletions(c.var.db, conversationId) });
        }
      )
      .get(
        '/message-payers/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const payers = await listMessagePayers(c.var.db, conversationId);
          return c.json({ payers });
        }
      )
      .get(
        '/conversation-cost/:conversationId',
        routeClass('dev-only'),
        zValidator('param', z.object({ conversationId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          return c.json({ cost: await conversationCost(c.var.db, conversationId) });
        }
      )
      .post(
        '/revoke-message-share',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', z.object({ shareId: z.uuid() }), rejectInvalid),
        async (c) => {
          const { shareId } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() => liftDevWork(revokeShareWork(c.var.db, shareId)))
          );
          return result.match(
            (outcome) => c.json({ success: true, rowsAffected: outcome.rowsAffected }),
            domainErrorResponder(c)
          );
        }
      )
      .get('/emails', routeClass('dev-only'), (c) => {
        const templates = EMAIL_TEMPLATE_PREVIEWS.map(({ name, label, render }) => ({
          name,
          label,
          html: render(),
        }));
        return c.json({ templates });
      })
      // E2E read-back for the double-opt-in and unsubscribe flows: the live
      // tokens straight from the subscriber row (the verify-token/:email
      // precedent).
      .get(
        '/newsletter/tokens/:email',
        routeClass('dev-only'),
        zValidator('param', z.object({ email: z.email() }), rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('param');
          const rows = await c.var.db
            .select({
              confirmToken: newsletterSubscribers.confirmToken,
              unsubscribeToken: newsletterSubscribers.unsubscribeToken,
              status: newsletterSubscribers.status,
            })
            .from(newsletterSubscribers)
            .where(eq(newsletterSubscribers.email, email.toLowerCase()));
          const row = rows[0];
          if (row === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
          }
          return c.json(row);
        }
      )
      .post(
        '/newsletter/subscribers',
        routeClass('dev-only'),
        idempotencyExempt('naturally-idempotent'),
        zValidator(
          'json',
          z.object({
            count: z.number().int().min(1).max(500),
            status: NewsletterStatus.optional(),
            emailPrefix: z.string().min(1).max(64).optional(),
          }),
          rejectInvalid
        ),
        async (c) => {
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              liftDevWork(mintNewsletterSubscribers(c.var.db, c.req.valid('json')))
            )
          );
          return result.match((minted) => c.json(minted, 200), domainErrorResponder(c));
        }
      )
      // The dev mailbox: what the factory-built mock sender actually
      // delivered (per-recipient, across requests) — distinct from
      // `/dev/emails`, which previews the static templates.
      .get('/mailbox', routeClass('dev-only'), (c) => {
        const emails = listCapturedEmails().map(({ id, message }) => ({
          id,
          to: message.to,
          subject: message.subject,
        }));
        return c.json({ emails });
      })
      .get('/mailbox/:id', routeClass('dev-only'), (c) => {
        const captured = findCapturedEmail(c.req.param('id'));
        if (captured === undefined) {
          return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
        }
        return c.html(captured.message.html);
      }),
  });
}
