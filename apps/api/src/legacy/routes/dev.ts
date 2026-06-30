import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { getIronSession } from 'iron-session';
import { users, sharedMessages, llmCompletions, messages, usageRecords } from '@hushbox/db';
import { ERROR_CODE_NOT_FOUND, ERROR_CODE_SERVER_MISCONFIGURED } from '@hushbox/shared';
import { pickValueTextModel, pickValueTextModels } from '@hushbox/shared/models';
import {
  listDevPersonas,
  cleanupTestData,
  resetTrialUsage,
  resetAuthRateLimits,
  resetUsageRateLimits,
  createDevConversation,
  createDevMultiModelConversation,
  createDevMediaConversation,
  createDevGroupChat,
  setWalletBalance,
  clearTotpReplay,
} from '../services/dev/index.js';
import {
  verificationEmail,
  passwordChangedEmail,
  twoFactorEnabledEmail,
  twoFactorDisabledEmail,
  accountLockedEmail,
  welcomeEmail,
} from '../services/email/templates/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { setVersionOverride } from '../lib/version-override.js';
import { getSessionOptions, type SessionData } from '../lib/session.js';
import { mediaStorageMiddleware } from '../middleware/index.js';
import type { AppEnv } from '../types.js';

const EMAIL_TEMPLATES = [
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
];

export const devRoute = new Hono<AppEnv>()
  .get(
    '/personas',
    zValidator('query', z.object({ type: z.enum(['test', 'dev']).optional() })),
    async (c) => {
      const db = c.get('db');
      const { type } = c.req.valid('query');
      const resolvedType = type ?? 'dev';
      const personas = await listDevPersonas(db, resolvedType);
      return c.json({ personas });
    }
  )
  .delete('/test-data', async (c) => {
    const db = c.get('db');
    const deleted = await cleanupTestData(db);
    return c.json({ success: true, deleted });
  })
  .get('/verify-token/:email', zValidator('param', z.object({ email: z.email() })), async (c) => {
    const db = c.get('db');
    const { email } = c.req.valid('param');

    const [user] = await db
      .select({ emailVerifyToken: users.emailVerifyToken })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!user?.emailVerifyToken) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json({ token: user.emailVerifyToken });
  })
  .delete('/trial-usage', async (c) => {
    const redis = c.get('redis');
    const result = await resetTrialUsage(redis);
    return c.json({ success: true, deleted: result.deleted });
  })
  .delete('/auth-rate-limits', async (c) => {
    const redis = c.get('redis');
    const result = await resetAuthRateLimits(redis);
    return c.json({ success: true, deleted: result.deleted });
  })
  .delete('/usage-rate-limits', async (c) => {
    const redis = c.get('redis');
    const result = await resetUsageRateLimits(redis);
    return c.json({ success: true, deleted: result.deleted });
  })
  .delete('/totp-replay', zValidator('json', z.object({ email: z.email() })), async (c) => {
    const db = c.get('db');
    const redis = c.get('redis');
    const { email } = c.req.valid('json');
    try {
      const result = await clearTotpReplay(db, redis, email);
      return c.json({ success: true, deleted: result.deleted });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('not found')) {
        return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
      }
      throw error;
    }
  })
  .post(
    '/conversation',
    zValidator(
      'json',
      z.object({
        ownerEmail: z.email(),
        messages: z
          .array(
            z.object({
              content: z.string(),
              senderType: z.enum(['user', 'ai']),
            })
          )
          .optional(),
        // Multi-model fan-out seed: one user prompt and `responseCount` sibling
        // AI tiles. The route resolves the models server-side so the fixture
        // never hardcodes ids. Mutually exclusive with `messages` in practice;
        // when present it takes the multi-model path.
        aiTurn: z
          .object({
            userContent: z.string(),
            responseCount: z.number().int().min(1),
          })
          .optional(),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const aiClient = c.get('aiClient');
      const { aiTurn, ...body } = c.req.valid('json');
      // Derive seed models from the live catalog so seeds never reference a
      // retired gateway model. See `pickValueTextModel(s)` for the criteria.
      const rawModels = await aiClient.listRawModels();

      if (aiTurn) {
        const models = pickValueTextModels(rawModels, aiTurn.responseCount);
        const aiResponses = models.map((modelName, index) => ({
          content: `Echo: ${aiTurn.userContent}`,
          modelName,
          // Distinct, positive seed costs (e.g. 0.002, 0.003, …) so each tile
          // renders a cost badge; values stay within the cost-display tolerance.
          cost: ((2 + index) / 1000).toFixed(8),
        }));
        const result = await createDevMultiModelConversation(db, {
          ownerEmail: body.ownerEmail,
          userContent: aiTurn.userContent,
          aiResponses,
        });
        return c.json(result, 201);
      }

      const seedAiModel = pickValueTextModel(rawModels);
      const result = await createDevConversation(db, { ...body, seedAiModel });
      return c.json(result, 201);
    }
  )
  .post(
    '/media-conversation',
    // Route-scoped: only media seeding needs R2/MinIO.
    mediaStorageMiddleware(),
    zValidator(
      'json',
      z.object({
        ownerEmail: z.email(),
        userContent: z.string(),
        mediaType: z.enum(['image', 'video']),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const mediaStorage = c.get('mediaStorage');
      const aiClient = c.get('aiClient');
      const { ownerEmail, userContent, mediaType } = c.req.valid('json');
      // No media-model picker exists; the nametag isn't asserted, so reuse the
      // text picker for a live-catalog id rather than a hardcodable one.
      const seedModel = pickValueTextModel(await aiClient.listRawModels());
      const result = await createDevMediaConversation(db, mediaStorage, {
        ownerEmail,
        userContent,
        mediaType,
        modelName: seedModel,
        // Fixed positive cost so the rendered content item carries a cost badge.
        cost: '0.01000000',
      });
      return c.json(result, 201);
    }
  )
  .post(
    '/group-chat',
    zValidator(
      'json',
      z.object({
        ownerEmail: z.email(),
        memberEmails: z.array(z.email()).min(1),
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
      })
    ),
    async (c) => {
      const db = c.get('db');
      const aiClient = c.get('aiClient');
      const { messages: rawMessages, pendingMemberEmails, ...rest } = c.req.valid('json');
      const seedAiModel = pickValueTextModel(await aiClient.listRawModels());
      const result = await createDevGroupChat(db, {
        ...rest,
        seedAiModel,
        ...(pendingMemberEmails !== undefined && { pendingMemberEmails }),
        ...(rawMessages !== undefined && {
          messages: rawMessages.map(({ senderEmail, ...msgRest }) => ({
            ...msgRest,
            ...(senderEmail !== undefined && { senderEmail }),
          })),
        }),
      });
      return c.json(result, 201);
    }
  )
  .post(
    '/wallet-balance',
    zValidator(
      'json',
      z.object({
        email: z.email(),
        walletType: z.enum(['purchased', 'free_tier']),
        balance: z.string(),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const params = c.req.valid('json');
      try {
        const result = await setWalletBalance(db, params);
        return c.json({ success: true, newBalance: result.newBalance });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('not found')) {
          return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
        }
        throw error;
      }
    }
  )
  .get('/emails', (c) => {
    const templates = EMAIL_TEMPLATES.map(({ name, label, render }) => ({
      name,
      label,
      html: render(),
    }));
    return c.json({ templates });
  })
  .post('/set-version', zValidator('json', z.object({ version: z.string().min(1) })), (c) => {
    const { version } = c.req.valid('json');
    setVersionOverride(version);
    return c.json({ success: true, version }, 200);
  })
  .post('/expire-session', async (c) => {
    const sessionSecret = c.env.IRON_SESSION_SECRET;
    if (!sessionSecret) {
      return c.json(createErrorResponse(ERROR_CODE_SERVER_MISCONFIGURED), 500);
    }

    const { isProduction } = c.get('envUtils');
    const session = await getIronSession<SessionData>(
      c.req.raw,
      c.res,
      getSessionOptions(sessionSecret, isProduction)
    );
    session.destroy();

    return c.json({ success: true });
  })
  // Counts llm_completions rows for a given conversation. Used by smart-model
  // E2E tests to assert that BOTH classifier + inference completions persisted
  // (= 2 rows for a single Smart Model send).
  .get(
    '/llm-completions-count/:conversationId',
    zValidator('param', z.object({ conversationId: z.string().min(1) })),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(llmCompletions)
        .innerJoin(usageRecords, eq(usageRecords.id, llmCompletions.usageRecordId))
        .innerJoin(messages, eq(messages.id, usageRecords.sourceId))
        .where(eq(messages.conversationId, conversationId));
      return c.json({ count: row?.count ?? 0 });
    }
  )
  // Lists AI messages with their resolved payer (from `usage_records.user_id`).
  // `messages.payer_id` was dropped in the wrap-once refactor — payment lives in
  // `usage_records`. Group-billing E2E tests use this to verify the
  // owner-funded vs personal-fallthrough decision (`payerId` differs from
  // sender id in the personal-fallthrough case).
  .get(
    '/message-payers/:conversationId',
    zValidator('param', z.object({ conversationId: z.string().min(1) })),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const rows = await db
        .select({
          messageId: messages.id,
          payerId: usageRecords.userId,
          sequenceNumber: messages.sequenceNumber,
        })
        .from(messages)
        .leftJoin(
          usageRecords,
          and(eq(usageRecords.sourceId, messages.id), eq(usageRecords.sourceType, 'message'))
        )
        .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'ai')))
        .orderBy(messages.sequenceNumber);
      return c.json({
        payers: rows.map((r) => ({ messageId: r.messageId, payerId: r.payerId })),
      });
    }
  )
  // Sums the actual cost charged (from `usage_records`, written in the same
  // transaction as the wallet debit) for a conversation's surviving AI messages.
  // The INNER JOIN to `messages` scopes the total to one conversation and drops
  // deleted/regenerated tiles, so the figure isn't polluted by other tests
  // charging the same shared user in parallel. Cost-reconciliation E2E tests
  // compare it against the displayed per-message cost badges. `conversation_spending`
  // can't be used here: it stays at 0 for solo (non-group) conversations.
  .get(
    '/conversation-cost/:conversationId',
    zValidator('param', z.object({ conversationId: z.string().min(1) })),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const [row] = await db
        .select({ cost: sql<string>`coalesce(sum(${usageRecords.cost}::numeric), 0)::text` })
        .from(usageRecords)
        .innerJoin(
          messages,
          and(eq(messages.id, usageRecords.sourceId), eq(usageRecords.sourceType, 'message'))
        )
        .where(eq(messages.conversationId, conversationId));
      return c.json({ cost: row?.cost ?? '0' });
    }
  )
  // Revokes a single message share by deleting the row from `shared_messages`.
  // Used by E2E to assert that subsequent /api/shares/:id calls return 404.
  .post(
    '/revoke-message-share',
    zValidator('json', z.object({ shareId: z.string().min(1) })),
    async (c) => {
      const db = c.get('db');
      const { shareId } = c.req.valid('json');
      const result = await db.delete(sharedMessages).where(eq(sharedMessages.id, shareId));
      return c.json({ success: true, rowsAffected: result.rowCount ?? 0 });
    }
  );
