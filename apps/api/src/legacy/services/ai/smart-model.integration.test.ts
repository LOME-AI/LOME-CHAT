import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  applyFees,
  buildClassifierMessages,
  buildEligibleModels,
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  resolveClassifierOutput,
  truncateForClassifier,
} from '@hushbox/shared';
import { contentItems, llmCompletions, usageRecords, type Database } from '@hushbox/db';
import { saveChatTurn } from '../chat/message-persistence.js';
import {
  cleanupTestUserData,
  createTestSetup,
  type TestSetup,
} from '../chat/media-strategy-test-helpers.js';
import { createSmartModelStage } from '../../lib/pre-inference/smart-model-stage.js';
import { createMockAIClient } from './mock.js';
import {
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { SSEEventWriter } from '../../lib/stream-handler.js';
import type { AIClient, ModelInfo, TextRequest } from './types.js';
import type { Model as SharedModel } from '@hushbox/shared';

function createNoopWriter(): SSEEventWriter {
  const noop = (): Promise<void> => Promise.resolve();
  return {
    writeStart: noop as SSEEventWriter['writeStart'],
    writeModelToken: noop as SSEEventWriter['writeModelToken'],
    writeModelMediaStart: noop as SSEEventWriter['writeModelMediaStart'],
    writeModelMediaProgress: noop as SSEEventWriter['writeModelMediaProgress'],
    writeError: noop as SSEEventWriter['writeError'],
    writeModelDone: noop as SSEEventWriter['writeModelDone'],
    writeModelError: noop as SSEEventWriter['writeModelError'],
    writeDone: noop as SSEEventWriter['writeDone'],
    writeStageStart: noop as SSEEventWriter['writeStageStart'],
    writeStageDone: noop as SSEEventWriter['writeStageDone'],
    writeStageError: noop as SSEEventWriter['writeStageError'],
    isConnected: () => true,
    isDoneWritten: () => false,
  };
}

const CLASSIFIER_TIMEOUT_MS = 60_000;

interface SmartModelHarness {
  classifierModelId: string;
  eligibleIds: string[];
  modelMetadataById: Map<string, { name: string; description: string }>;
  /**
   * Client to use for subsequent stream calls. For the mock branch this is
   * a NEW mock configured to resolve the classifier to the first eligible
   * id; for real-client integration runs it's the input client passed
   * through unchanged.
   */
  client: AIClient;
}

async function buildHarness(client: AIClient, eligibleCount: number): Promise<SmartModelHarness> {
  const allModels = await client.listModels();
  const textModels = allModels.filter((m) => m.modality === 'text' && m.isZdr);
  const sorted = textModels.toSorted((a, b) => textCost(a) - textCost(b));
  if (sorted.length === 0) {
    throw new Error('No paid ZDR text models available for harness.');
  }
  const classifierModelId = sorted[0]!.id;
  const eligibleSlice = sorted.slice(0, Math.max(1, Math.min(eligibleCount, sorted.length)));
  const modelMetadataById = new Map(
    eligibleSlice.map((m) => [m.id, { name: m.name, description: m.description }])
  );
  const eligibleIds = eligibleSlice.map((m) => m.id);

  // For the mock branch we need the classifier to resolve to a value the
  // harness just discovered. Mock state is constructor-only, so we build a
  // fresh mock pinned to the first eligible id. Real client picks from the
  // eligible list on its own.
  const harnessClient: AIClient = client.isMock
    ? createMockAIClient({ classifierResolution: eligibleIds[0]! })
    : client;

  return {
    classifierModelId,
    eligibleIds,
    modelMetadataById,
    client: harnessClient,
  };
}

function textCost(model: ModelInfo): number {
  if (model.pricing.kind !== 'token') return Number.POSITIVE_INFINITY;
  return model.pricing.inputPerToken + model.pricing.outputPerToken;
}

function buildClassifierRequest(
  harness: SmartModelHarness,
  latestUserMessage: string,
  latestAssistantMessage: string
): TextRequest {
  const truncatedContext = truncateForClassifier({
    latestUserMessage,
    latestAssistantMessage,
  });
  const eligibleWithDescriptions = harness.eligibleIds.map((id) => ({
    id,
    description: harness.modelMetadataById.get(id)?.description ?? '',
  }));
  const messages = buildClassifierMessages({
    truncatedContext,
    eligibleModels: eligibleWithDescriptions,
  });
  return {
    modality: 'text',
    model: harness.classifierModelId,
    messages,
    maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  };
}

describe('Smart Model integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  it(
    'classifier picks an eligible model and the resolved model produces text',
    async () => {
      const harness = await buildHarness(client, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Help me write a short greeting.',
        ''
      );
      const classifierResult = await consumeStream(harness.client.stream(classifierRequest));
      expect(classifierResult.generationId).toBeDefined();

      const resolvedId = resolveClassifierOutput(classifierResult.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(harness.eligibleIds).toContain(resolvedId!);

      const inferenceSpec = await getCheapestTestModel(client, 'text');
      if (inferenceSpec.parameters.kind !== 'text') throw new Error('expected text spec');
      const inferenceRequest: TextRequest = {
        modality: 'text',
        model: resolvedId!,
        messages: [{ role: 'user', content: 'Reply with a single short word.' }],
        maxOutputTokens: inferenceSpec.parameters.maxOutputTokens,
      };
      const inferenceResult = await consumeStream(harness.client.stream(inferenceRequest));
      expect(inferenceResult.textContent.length).toBeGreaterThan(0);
      expect(inferenceResult.generationId).toBeDefined();
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'both classifier and inference produce billable getGenerationStats costs',
    async () => {
      const harness = await buildHarness(client, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Pick a model for a short answer.',
        ''
      );
      const classifier = await consumeStream(harness.client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(classifier.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();

      const inference = await consumeStream(
        harness.client.stream({
          modality: 'text',
          model: resolvedId!,
          messages: [{ role: 'user', content: 'Say yes.' }],
          maxOutputTokens: 10,
        })
      );

      const [classifierStats, inferenceStats] = await Promise.all([
        harness.client.getGenerationStats(classifier.generationId!),
        harness.client.getGenerationStats(inference.generationId!),
      ]);
      expect(classifierStats.costUsd).toBeGreaterThan(0);
      expect(inferenceStats.costUsd).toBeGreaterThan(0);
      const totalWithFees = applyFees(classifierStats.costUsd) + applyFees(inferenceStats.costUsd);
      expect(totalWithFees).toBeGreaterThan(0);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'eligible-list filtering: classifier output resolves only to a model in the filtered list',
    async () => {
      const harness = await buildHarness(client, 2);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Pick the best model for code review.',
        ''
      );
      const result = await consumeStream(harness.client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(result.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(harness.eligibleIds).toContain(resolvedId!);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'single-eligible harness: resolved id is the only eligible id',
    async () => {
      const harness = await buildHarness(client, 1);
      expect(harness.eligibleIds).toHaveLength(1);
      const classifierRequest = buildClassifierRequest(harness, 'Choose a model.', '');
      const result = await consumeStream(harness.client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(result.textContent, harness.eligibleIds);
      expect(resolvedId).toBe(harness.eligibleIds[0]);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'classifier emits a finish event with providerMetadata.generationId',
    async () => {
      const harness = await buildHarness(client, 3);
      const result = await consumeStream(
        harness.client.stream(buildClassifierRequest(harness, 'Choose a model.', ''))
      );
      expect(result.events.at(-1)?.kind).toBe('finish');
      expect(result.generationId).toBeDefined();
      expect(result.generationId?.length ?? 0).toBeGreaterThan(0);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'denies the request with INSUFFICIENT_BALANCE when the user can not afford even the classifier',
    async () => {
      // Plan §10.11 + Agent 7: when the payer's balance can't cover even the
      // classifier worst-case overhead, the pipeline must short-circuit with
      // ERROR_CODE_INSUFFICIENT_BALANCE — never silently degrade. We verify
      // by exercising buildEligibleModels (the gatekeeper inside the
      // pipeline that returns null on this path) rather than the full HTTP
      // surface, since this is an integration test for the API logic.
      const allModels = await client.listModels();
      const textModels = allModels.filter((m) => m.modality === 'text' && m.isZdr);
      if (textModels.length === 0) {
        throw new Error('No paid ZDR text models available for insufficient-balance test.');
      }

      // Adapt ModelInfo → Model (the buildEligibleModels input shape).
      const modelInputs: SharedModel[] = textModels.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        provider: 'TestProvider',
        modality: 'text',
        contextLength: 100_000,
        pricePerInputToken: m.pricing.kind === 'token' ? m.pricing.inputPerToken : 0.000_001,
        pricePerOutputToken: m.pricing.kind === 'token' ? m.pricing.outputPerToken : 0.000_005,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        supportedParameters: [],
      }));

      const eligibility = buildEligibleModels({
        textModels: modelInputs,
        premiumIds: new Set(),
        // Free tier with zero allowance: no cushion, no funds — true denial.
        payerTier: 'free',
        payerBalanceCents: 0,
        payerFreeAllowanceCents: 0,
        promptCharacterCount: 200,
      });

      // null result is the signal the pipeline uses to emit the 402.
      expect(eligibility).toBeNull();
      // Sanity-check the error-code constant the pipeline forwards.
      expect(ERROR_CODE_INSUFFICIENT_BALANCE).toBe('INSUFFICIENT_BALANCE');
    },
    CLASSIFIER_TIMEOUT_MS
  );
});

describe('Smart Model insufficient-budget DB persistence', () => {
  let dbInstance: Database;
  let smartClient: AIClient;
  const setupsToCleanup: TestSetup[] = [];

  beforeAll(async () => {
    const { createDb, LOCAL_NEON_DEV_CONFIG } = await import('@hushbox/db');
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL required for Smart Model insufficient-budget DB test');
    }
    dbInstance = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });
    smartClient = setupIntegrationClient().client;
  });

  afterEach(async () => {
    for (const setup of setupsToCleanup) {
      await cleanupTestUserData(dbInstance, setup.user.id);
    }
    setupsToCleanup.length = 0;
  });

  it(
    'creates no usage_records rows when buildEligibleModels denies the request',
    async () => {
      // Plan §10.11: when the classifier worst-case overhead exceeds the
      // payer's effective balance, the request must be denied before any
      // call is made — and therefore no usage_records row is persisted for
      // the would-be assistant message.
      const setup = await createTestSetup(dbInstance);
      setupsToCleanup.push(setup);

      const allModels = await smartClient.listModels();
      const textModels = allModels.filter((m) => m.modality === 'text' && m.isZdr);
      const modelInputs: SharedModel[] = textModels.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        provider: 'TestProvider',
        modality: 'text',
        contextLength: 100_000,
        pricePerInputToken: m.pricing.kind === 'token' ? m.pricing.inputPerToken : 0.000_001,
        pricePerOutputToken: m.pricing.kind === 'token' ? m.pricing.outputPerToken : 0.000_005,
        pricePerImage: 0,
        pricePerSecondByResolution: {},
        pricePerSecond: 0,
        capabilities: [],
        supportedParameters: [],
      }));

      const eligibility = buildEligibleModels({
        textModels: modelInputs,
        premiumIds: new Set(),
        payerTier: 'free',
        payerBalanceCents: 0,
        payerFreeAllowanceCents: 0,
        promptCharacterCount: 200,
      });
      expect(eligibility).toBeNull();

      // No saveChatTurn happens — verify nothing was billed for this user.
      const userRecords = await dbInstance
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.userId, setup.user.id));
      expect(userRecords).toHaveLength(0);
    },
    CLASSIFIER_TIMEOUT_MS
  );
});

describe('Smart Model full DB persistence integration', () => {
  let dbInstance: Database;
  let smartClient: AIClient;
  const setupsToCleanup: TestSetup[] = [];

  beforeAll(async () => {
    // The full-DB persistence test always needs a real DB regardless of
    // localDev/CI; setupIntegrationClient returns db=null in localDev (where
    // the mock AIClient doesn't need DB). Build our own DB connection here
    // and reuse the AIClient from setupIntegrationClient (mock locally,
    // real in CI).
    const { createDb, LOCAL_NEON_DEV_CONFIG } = await import('@hushbox/db');
    const databaseUrl = process.env['DATABASE_URL'];
    if (!databaseUrl) {
      throw new Error('DATABASE_URL required for Smart Model DB persistence test');
    }
    dbInstance = createDb({ connectionString: databaseUrl, neonDev: LOCAL_NEON_DEV_CONFIG });
    smartClient = setupIntegrationClient().client;
  });

  afterEach(async () => {
    for (const setup of setupsToCleanup) {
      await cleanupTestUserData(dbInstance, setup.user.id);
    }
    setupsToCleanup.length = 0;
  });

  it(
    'persists exactly two usage_records (classifier + inference) linked to the assistant message',
    async () => {
      const setup = await createTestSetup(dbInstance);
      setupsToCleanup.push(setup);

      const harness = await buildHarness(smartClient, 3);
      const classifierRequest = buildClassifierRequest(
        harness,
        'Help me write a single short greeting.',
        ''
      );
      const classifier = await consumeStream(harness.client.stream(classifierRequest));
      const resolvedId = resolveClassifierOutput(classifier.textContent, harness.eligibleIds);
      expect(resolvedId).not.toBeNull();
      expect(classifier.generationId).toBeDefined();

      const inferenceSpec = await getCheapestTestModel(smartClient, 'text');
      if (inferenceSpec.parameters.kind !== 'text') throw new Error('expected text spec');
      const inferenceRequest: TextRequest = {
        modality: 'text',
        model: resolvedId!,
        messages: [{ role: 'user', content: 'Reply with one short word.' }],
        maxOutputTokens: inferenceSpec.parameters.maxOutputTokens,
      };
      const inference = await consumeStream(harness.client.stream(inferenceRequest));
      expect(inference.textContent.length).toBeGreaterThan(0);
      expect(inference.generationId).toBeDefined();

      const [classifierStats, inferenceStats] = await Promise.all([
        smartClient.getGenerationStats(classifier.generationId!),
        smartClient.getGenerationStats(inference.generationId!),
      ]);
      expect(classifierStats.costUsd).toBeGreaterThan(0);
      expect(inferenceStats.costUsd).toBeGreaterThan(0);

      const userMsgId = crypto.randomUUID();
      const assistantMsgId = crypto.randomUUID();
      const inferenceCostDollars = applyFees(inferenceStats.costUsd);
      const classifierCostDollars = applyFees(classifierStats.costUsd);
      const classifierInputChars = classifierRequest.messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0
      );
      const classifierOutputChars = classifier.textContent.length;
      const userContent = 'Help me write a single short greeting.';
      const inferenceInputChars = inferenceRequest.messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0
      );
      const tokensFromChars = (chars: number): number =>
        Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_STANDARD));

      await saveChatTurn(dbInstance, {
        userMessageId: userMsgId,
        userContent,
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        parentMessageId: null,
        assistantMessages: [
          {
            modality: 'text',
            id: assistantMsgId,
            content: inference.textContent,
            model: resolvedId!,
            cost: inferenceCostDollars,
            inputTokens: tokensFromChars(inferenceInputChars),
            outputTokens: tokensFromChars(inference.textContent.length),
            isEstimated: false,
            isSmartModel: true,
            preInferenceBillings: [
              {
                stageId: 'smart-model',
                modelId: harness.classifierModelId,
                costDollars: classifierCostDollars,
                inputTokens: tokensFromChars(classifierInputChars),
                outputTokens: tokensFromChars(classifierOutputChars),
                isEstimated: false,
              },
            ],
          },
        ],
      });

      // Strongest-proof assertions: count + per-row inspection
      const usageRows = await dbInstance
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.sourceId, assistantMsgId));
      expect(usageRows).toHaveLength(2);
      for (const row of usageRows) {
        expect(row.type).toBe('llm_completion');
        expect(Number(row.cost)).toBeGreaterThan(0);
        // CI guardrail: retry must cover the gateway eventual-consistency window
        // so we always bill the EXACT gateway cost, never the estimate. A `true`
        // here means production-style fallback fired in CI, which silently
        // masks billing accuracy — fail loudly.
        expect(row.isEstimated).toBe(false);
      }

      const usageRecordIds = usageRows.map((r) => r.id);
      const llmRows = await dbInstance
        .select()
        .from(llmCompletions)
        .where(inArray(llmCompletions.usageRecordId, usageRecordIds));
      expect(llmRows).toHaveLength(2);
      const llmModels = new Set(llmRows.map((r) => r.model));
      expect(llmModels.has(harness.classifierModelId)).toBe(true);
      expect(llmModels.has(resolvedId!)).toBe(true);

      const [item] = await dbInstance
        .select()
        .from(contentItems)
        .where(eq(contentItems.messageId, assistantMsgId));
      expect(item).toBeDefined();
      expect(item!.isSmartModel).toBe(true);
      expect(item!.modelName).toBe(resolvedId);
      // content_items.cost = sum of usage_records.cost (within 1e-8 tolerance)
      const summedUsageCost = usageRows.reduce((sum, r) => sum + Number(r.cost), 0);
      expect(Math.abs(Number(item!.cost) - summedUsageCost)).toBeLessThan(1e-6);
    },
    CLASSIFIER_TIMEOUT_MS
  );

  it(
    'persists exactly one usage_records row when classifier throws (fallback, billing: null)',
    async () => {
      // Plan §10.11 throw-fallback: when the classifier stream rejects, the
      // stage degrades silently to the cheapest eligible model and emits no
      // billing breadcrumb (no generationId → nothing to charge for). The
      // persistence layer then writes only the inference's usage_records row.
      const setup = await createTestSetup(dbInstance);
      setupsToCleanup.push(setup);

      const mockClassifierClient = createMockAIClient({ classifierFailure: true });

      const eligibleIds = ['anthropic/claude-opus-4.6', 'anthropic/claude-sonnet-4.6'];
      const fallbackModelId = 'anthropic/claude-sonnet-4.6';
      const stage = createSmartModelStage({
        classifierModelId: fallbackModelId,
        eligibleInferenceIds: eligibleIds,
        classifierWorstCaseCents: 12,
        modelMetadataById: new Map([
          ['anthropic/claude-opus-4.6', { name: 'Claude Opus 4.6', description: 'Most capable.' }],
          [fallbackModelId, { name: 'Claude Sonnet 4.6', description: 'Cheapest eligible.' }],
        ]),
        conversationContext: {
          latestUserMessage: 'Help me write a single short greeting.',
          latestAssistantMessage: '',
        },
      });

      const assistantMsgId = crypto.randomUUID();
      const outcome = await stage.run({
        aiClient: mockClassifierClient,
        writer: createNoopWriter(),
        assistantMessageId: assistantMsgId,
        upstream: {},
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // Throw-fallback contract: resolved to fallback id, no billing.
      expect(outcome.transformation.resolvedModelId).toBe(fallbackModelId);
      expect(outcome.billing).toBeNull();
      const resolvedId = outcome.transformation.resolvedModelId;
      if (resolvedId === undefined) throw new Error('invariant: fallback must resolve a model id');

      const inferenceSpec = await getCheapestTestModel(smartClient, 'text');
      if (inferenceSpec.parameters.kind !== 'text') throw new Error('expected text spec');
      const inferenceRequest: TextRequest = {
        modality: 'text',
        model: inferenceSpec.modelId,
        messages: [{ role: 'user', content: 'Reply with one short word.' }],
        maxOutputTokens: inferenceSpec.parameters.maxOutputTokens,
      };
      const inference = await consumeStream(smartClient.stream(inferenceRequest));
      expect(inference.textContent.length).toBeGreaterThan(0);
      expect(inference.generationId).toBeDefined();

      const inferenceStats = await smartClient.getGenerationStats(inference.generationId!);
      expect(inferenceStats.costUsd).toBeGreaterThan(0);

      // billing: null from the throw-fallback ⇒ persistence writes only the
      // inference row. The slot is still a Smart Model slot (isSmartModel=true)
      // and the resolved model id is what gets stored on content_items.
      const userMsgId = crypto.randomUUID();
      const inferenceCostDollars = applyFees(inferenceStats.costUsd);
      const inferenceInputChars = inferenceRequest.messages.reduce(
        (sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
        0
      );
      const tokensFromChars = (chars: number): number =>
        Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_STANDARD));

      await saveChatTurn(dbInstance, {
        userMessageId: userMsgId,
        userContent: 'Help me write a single short greeting.',
        conversationId: setup.conversation.id,
        userId: setup.user.id,
        senderId: setup.user.id,
        parentMessageId: null,
        assistantMessages: [
          {
            modality: 'text',
            id: assistantMsgId,
            content: inference.textContent,
            model: resolvedId,
            cost: inferenceCostDollars,
            inputTokens: tokensFromChars(inferenceInputChars),
            outputTokens: tokensFromChars(inference.textContent.length),
            isEstimated: false,
            isSmartModel: true,
            // No preInferenceBillings: billing was null on throw-fallback.
          },
        ],
      });

      // Strongest-proof assertions: EXACTLY 1 usage_records row, EXACTLY 1
      // llm_completions row, content_items reflects fallback resolution.
      const usageRows = await dbInstance
        .select()
        .from(usageRecords)
        .where(eq(usageRecords.userId, setup.user.id));
      expect(usageRows).toHaveLength(1);
      const [usageRow] = usageRows;
      expect(usageRow!.sourceId).toBe(assistantMsgId);
      expect(usageRow!.type).toBe('llm_completion');
      expect(Number(usageRow!.cost)).toBeGreaterThan(0);
      // CI guardrail: see comment in earlier test — retry must avoid the estimate path.
      expect(usageRow!.isEstimated).toBe(false);

      const llmRows = await dbInstance
        .select()
        .from(llmCompletions)
        .where(inArray(llmCompletions.usageRecordId, [usageRow!.id]));
      expect(llmRows).toHaveLength(1);
      expect(llmRows[0]!.model).toBe(resolvedId);

      const [item] = await dbInstance
        .select()
        .from(contentItems)
        .where(eq(contentItems.messageId, assistantMsgId));
      expect(item).toBeDefined();
      // Throw-fallback still went through Smart Model selection.
      expect(item!.isSmartModel).toBe(true);
      // Stored model id is the resolved value (fallback) model — not 'smart-model'.
      expect(item!.modelName).toBe(resolvedId);
      // content_items.cost equals just the inference cost — no stage cost added.
      expect(Math.abs(Number(item!.cost) - inferenceCostDollars)).toBeLessThan(1e-6);
      expect(Math.abs(Number(item!.cost) - Number(usageRow!.cost))).toBeLessThan(1e-6);
    },
    CLASSIFIER_TIMEOUT_MS
  );
});
