import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { sharedMessages, users } from '@hushbox/db';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE, ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { setVersionOverride } from '../../middleware/version-override.js';
import { createErrorResponse, notFoundError, unavailableError } from '../../lib/errors/index.js';
import { idempotencyExempt, idempotent, runMutation } from '../../lib/idempotency/index.js';
import { fromPromise } from '../../lib/result/index.js';
import { createIdentityStores } from '../../slices/identity/index.js';
import { createR2StorageFromEnv } from '../../slices/media/index.js';
import {
  DevSeedError,
  requireSeed,
  createDevConversation,
  createDevGroupChat,
  createDevMediaConversation,
  createDevMultiModelConversation,
  pickSeedTextModels,
} from './factories.js';
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
 */
export function createDevManifest() {
  return defineSliceManifest({
    basePath: '/dev',
    routes: new Hono<AppEnv>()
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
      ),
  });
}
