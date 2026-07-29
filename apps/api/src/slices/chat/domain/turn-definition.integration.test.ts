import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  modelCatalog,
  users,
  wallets,
} from '@hushbox/db';
import { createBillingStores } from '../../billing/index.js';
import { createConversationsStores } from '../../conversations/index.js';
import { withModelCatalogLock } from '../../models/__tests__/model-catalog-lock.js';
import { resolveTurnContext } from './turn-context.js';
import { buildMultiModelTurnDefinition, buildTurnDefinition } from './turn-definition.js';
import type { ModelReasoning } from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for turn-definition integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([3, 3, 3]);
// The `chat-route` prefix survives the chat route suite's foreign-row catalog
// isolation delete, so a concurrent run never drops this suite's model.
const MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const REASONING_MODEL = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
const variantModelIds: string[] = [];
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(modelCatalog)
    .where(inArray(modelCatalog.modelId, [MODEL, REASONING_MODEL, ...variantModelIds]));
  await db.$client.end();
});

/** Billable rates 2500 / 10_000 nano-USD per token, context window 128_000. */
async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '2',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

/** Same rates/window as {@link seedModel}, plus open-effort reasoning metadata. */
async function seedReasoningModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: REASONING_MODEL,
      descriptor: {
        id: REASONING_MODEL,
        provider: 'p',
        version: '2',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
        reasoning: { supportedEfforts: null },
      },
    })
    .onConflictDoNothing();
}

/** A fresh catalog id for one variant model, tracked for cleanup. */
function openModel(): string {
  const id = `chat-route-ceiling/${crypto.randomUUID().slice(0, 8)}`;
  variantModelIds.push(id);
  return id;
}

/** Same rates/window as {@link seedModel} with the given reasoning metadata. */
async function seedVariantModel(modelId: string, reasoning?: ModelReasoning): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: 'p',
        version: '2',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2500', outputPerToken: '10000' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    })
    .onConflictDoNothing();
}

async function seedUser(balanceNanoUsd: bigint): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@turn-ceiling.test`,
      username: `tc${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  await db.insert(wallets).values({ userId: id, type: 'purchased', balanceNanoUsd });
  return id;
}

async function seedConversation(userId: string): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  return conversationId;
}

/** The chat turn path: context (payer funding) → definition → answer node. */
async function builtAnswerParams(balanceNanoUsd: bigint): Promise<Record<string, unknown>> {
  const userId = await seedUser(balanceNanoUsd);
  const conversationId = await seedConversation(userId);
  const context = await resolveTurnContext(
    { conversations: createConversationsStores, billing: createBillingStores() },
    db,
    {
      conversationId,
      sender: { kind: 'user', userId },
      now: new Date(),
      // A solo turn never reaches the group comparison, so the amount is inert
      // here; the seam takes it always so no caller can omit it where it counts.
      minTurnCost: { kind: 'priced', nanoUsd: 1n },
    }
  );
  const funding = context._unsafeUnwrap().funding;
  // Seed and build under the shared catalog lock: an unlocked insert would
  // land inside another suite's locked clear-the-catalog window (the dev-routes
  // 404 test wipes the whole table and asserts "no text model"), and that
  // suite's wipe could equally drop this model between seed and read.
  const definition = await withModelCatalogLock(redis, async () => {
    await seedModel();
    return buildTurnDefinition({ db, telemetry: silentTelemetry }, MODEL, {
      budget: { promptCharacterCount: 'hello world'.length, funding },
    });
  });
  const answer = definition._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
  if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
  return answer.params;
}

describe('the chat turn path output-token ceiling', () => {
  it('builds a low-balance payer a capped modelCall bound by what the money buys', async () => {
    // $0.10 balance: estInput = ceil(11/4) = 3; billable rates 2500/10_000;
    // fixed = 3×2500 + 11×300 = 10_800; variable = 10_000 + 600 = 10_600;
    // effective = 100_000_000 + 500_000_000 cushion →
    // maxOutputTokens = floor(599_989_200/10_600) = 56_602. The figure is unchanged
    // from the derivation that used to compute it directly: where money binds, the
    // canonical estimator's own fit lands on the same token count.
    const params = await builtAnswerParams(100_000_000n);
    expect(params).toEqual({ maxOutputTokens: 56_602 });
  });

  it('caps a rich payer at the context headroom, the tightest bound left once money is loose', async () => {
    // $10,000 balance, so `budgetBuys` is far past this model's room and the PROMPT
    // is what binds: BILLING §Model bounds' ceiling = min(providerCap,
    // contextHeadroom, budgetBuys) = 128_000 − ceil(11/4) = 127_997. The cap used to
    // be omitted here, which left admission pricing the full 128,000-token window —
    // three tokens more than the ceiling the specification names, and a wire cap with
    // no money term behind it on the trial arm of the same code path.
    const params = await builtAnswerParams(10_000_000_000_000n);
    expect(params).toEqual({ maxOutputTokens: 128_000 - Math.ceil('hello world'.length / 4) });
  });
});

describe('the reasoning turn build fail-fasts', () => {
  it('refuses a reasoning build with no payer budget (no sizing basis for the explicit cap)', async () => {
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        reasoningEffort: 'low',
      });
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('caps an unaffordable reasoning turn at B plus the minimum answer so admission refuses it', async () => {
    // A free payer whose funds cannot cover B + the 1000-token minimum answer:
    // the build keeps an EXPLICIT B + MINIMUM cap (G2) with no reconcile guess,
    // and admission's balance gate — not a silent effort downgrade — refuses.
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        budget: {
          promptCharacterCount: 5,
          funding: { kind: 'free', remainingNanoUsd: 1_000_000n },
        },
        reasoningEffort: 'low',
      });
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    expect(answer.params).toEqual({
      // low B = 4096 + the 1000-token minimum answer allocation.
      maxOutputTokens: 5096,
      reasoning: { effort: 'low' },
    });
  });
});

describe('multi-model effort resolution (union choice set, per-model downgrade)', () => {
  const RICH = {
    promptCharacterCount: 'hello world'.length,
    funding: { kind: 'purchased', remainingNanoUsd: 100_000_000_000n },
  } as const;

  /** Every sibling's wire, in selected order, for a multi-model text build. */
  async function siblingWires(
    models: readonly { readonly id: string; readonly reasoning?: ModelReasoning }[],
    reasoningEffort: 'lite' | 'low' | 'medium' | 'high' | 'max' | 'off'
  ): Promise<unknown[]> {
    const result = await withModelCatalogLock(redis, async () => {
      for (const model of models) await seedVariantModel(model.id, model.reasoning);
      return buildMultiModelTurnDefinition(
        { db, telemetry: silentTelemetry },
        models.map((model) => model.id),
        { budget: RICH, reasoningEffort }
      );
    });
    return result
      ._unsafeUnwrap()
      .definition.nodes.filter((node) => node.type === 'modelCall')
      .map((node) => node.params['reasoning']);
  }

  it('resolves a level a sibling lacks per model instead of refusing the whole turn', async () => {
    // The union offers Low (the open-ladder sibling); the High-only sibling has
    // nothing at or below it and can disable, so it runs reasoning-off — where
    // the every-model unanimity rule used to 400 the build.
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
      ],
      'low'
    );
    expect(wires).toEqual([{ effort: 'low' }, { enabled: false }]);
  });

  it('runs a mandatory sibling at its LOWEST rung when the choice sits below its ladder', async () => {
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['hi', 'lo'], mandatory: true } },
      ],
      'lite'
    );
    expect(wires).toEqual([{ effort: 'minimal' }, { effort: 'lo' }]);
  });

  it('wires the union pick verbatim on every sibling that offers it', async () => {
    const wires = await siblingWires(
      [
        { id: openModel(), reasoning: { supportedEfforts: null } },
        { id: openModel(), reasoning: { supportedEfforts: ['hi', 'lo'] } },
      ],
      'high'
    );
    expect(wires).toEqual([{ effort: 'high' }, { effort: 'hi' }]);
  });

  it('leaves a non-reasoning sibling wire-silent (no entry, no refusal)', async () => {
    const wires = await siblingWires(
      [{ id: openModel(), reasoning: { supportedEfforts: null } }, { id: openModel() }],
      'medium'
    );
    expect(wires).toEqual([{ effort: 'medium' }, undefined]);
  });

  it('refuses a choice outside the union option set with a typed validation error', async () => {
    const models = [
      { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
      { id: openModel(), reasoning: { supportedEfforts: ['high'] } },
    ];
    const result = await withModelCatalogLock(redis, async () => {
      for (const model of models) await seedVariantModel(model.id, model.reasoning);
      return buildMultiModelTurnDefinition(
        { db, telemetry: silentTelemetry },
        models.map((model) => model.id),
        { budget: RICH, reasoningEffort: 'low' }
      );
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('keeps the single-model explicit refusal: an unoffered level still 400s', async () => {
    const model = openModel();
    const result = await withModelCatalogLock(redis, async () => {
      await seedVariantModel(model, { supportedEfforts: ['high'] });
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, model, {
        budget: RICH,
        reasoningEffort: 'low',
      });
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it("picks the sole real choice for 'auto' on a Min-only model (no classifier, no reserve)", async () => {
    const model = openModel();
    const result = await withModelCatalogLock(redis, async () => {
      await seedVariantModel(model, { supportedEfforts: ['none'] });
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, model, {
        budget: RICH,
        reasoningEffort: 'auto',
      });
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    expect(answer.params['reasoning']).toEqual({ enabled: false });
  });
});

describe("the hard-off ('off') turn build", () => {
  async function noneAnswerParams(
    options: Parameters<typeof buildTurnDefinition>[2]
  ): Promise<Record<string, unknown>> {
    const result = await withModelCatalogLock(redis, async () => {
      await seedReasoningModel();
      return buildTurnDefinition({ db, telemetry: silentTelemetry }, REASONING_MODEL, {
        ...options,
        reasoningEffort: 'off',
      });
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    if (answer?.type !== 'modelCall') throw new Error('answer node missing from the definition');
    return answer.params;
  }

  it('wires { enabled: false } with exactly the reasoning-free answer cap (B=0, cap = H)', async () => {
    // Same $0.10 payer as the reasoning-free derivation test: the cap must be
    // byte-identical to a plain turn's — the off wire adds no B term.
    const params = await noneAnswerParams({
      budget: {
        promptCharacterCount: 'hello world'.length,
        funding: { kind: 'purchased', remainingNanoUsd: 100_000_000n },
      },
    });
    expect(params).toEqual({ maxOutputTokens: 56_602, reasoning: { enabled: false } });
  });

  it('builds a budget-less (trial) hard-off turn uncapped, like a plain trial turn', async () => {
    const params = await noneAnswerParams({});
    expect(params).toEqual({ reasoning: { enabled: false } });
  });
});
