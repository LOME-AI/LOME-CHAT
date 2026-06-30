import { describe, it, expect, vi } from 'vitest';
import {
  applyFees,
  estimateMessageCostDevelopment,
  estimateTokenCount,
  STORAGE_COST_PER_CHARACTER,
  type PreInferenceBilling,
} from '@hushbox/shared';

const recordEvidenceMock = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve());
vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return {
    ...actual,
    recordServiceEvidence: recordEvidenceMock,
  };
});

const {
  calculateMessageCost,
  calculateMessageCostWithStages,
  recordBillingMismatchIfExceeded,
  BILLING_MISMATCH_THRESHOLD_RATIO,
} = await import('./cost-calculator.js');
const { SERVICE_NAMES } = await import('@hushbox/db');
import type { AIClient, ModelInfo, ModelPricing } from '../ai/types.js';

const TOKEN_PRICING_INPUT = 0.000_000_2;
const TOKEN_PRICING_OUTPUT = 0.000_000_6;
const TOKEN_PRICING: ModelPricing = {
  kind: 'token',
  inputPerToken: TOKEN_PRICING_INPUT,
  outputPerToken: TOKEN_PRICING_OUTPUT,
};

function makeMockModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'test/model',
    name: 'Test Model',
    provider: 'test',
    modality: 'text',
    description: '',
    pricing: TOKEN_PRICING,
    capabilities: [],
    isZdr: true,
    ...overrides,
  };
}

function makeMockAIClient(costUsd: number, modelOverrides: Partial<ModelInfo> = {}): AIClient {
  return {
    isMock: true,
    listModels: vi.fn(),
    getModel: vi.fn().mockResolvedValue(makeMockModel(modelOverrides)),
    stream: vi.fn(),
    getGenerationStats: vi.fn().mockResolvedValue({ costUsd }),
  } as unknown as AIClient;
}

function makeFailingMockAIClient(err: Error, modelOverrides: Partial<ModelInfo> = {}): AIClient {
  return {
    isMock: true,
    listModels: vi.fn(),
    getModel: vi.fn().mockResolvedValue(makeMockModel(modelOverrides)),
    stream: vi.fn(),
    getGenerationStats: vi.fn().mockRejectedValue(err),
  } as unknown as AIClient;
}

function storageFee(inputContent: string, outputContent: string): number {
  return (inputContent.length + outputContent.length) * STORAGE_COST_PER_CHARACTER;
}

function expectedEstimateTotal(inputContent: string, outputContent: string): number {
  return estimateMessageCostDevelopment({
    inputTokens: estimateTokenCount(inputContent),
    outputTokens: estimateTokenCount(outputContent),
    inputCharacters: inputContent.length,
    outputCharacters: outputContent.length,
    pricePerInputToken: TOKEN_PRICING_INPUT,
    pricePerOutputToken: TOKEN_PRICING_OUTPUT,
  });
}

describe('calculateMessageCost', () => {
  it('fetches cost from aiClient.getGenerationStats and returns gateway cost + storage fee', async () => {
    const aiClient = makeMockAIClient(0.0025);

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-123',
      modelId: 'test/model',
      inputContent: 'Hello world',
      outputContent: 'Hello! How can I help you today?',
    });

    // Cost = applyFees(0.0025) + storage fee from chars > 0
    expect(result.totalDollars).toBeGreaterThan(0.0025);
    expect(result.wasEstimated).toBe(false);
    expect(aiClient.getGenerationStats).toHaveBeenCalledWith('gen-123');
  });

  it('does not call getModel on the success path (no estimate needed)', async () => {
    const aiClient = makeMockAIClient(0.001);
    await calculateMessageCost({
      aiClient,
      generationId: 'gen-1',
      modelId: 'test/model',
      inputContent: 'hi',
      outputContent: 'world',
    });
    expect(aiClient.getModel).not.toHaveBeenCalled();
  });

  it('includes storage fee on top of gateway cost', async () => {
    const aiClient = makeMockAIClient(0.001);

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-1',
      modelId: 'test/model',
      inputContent: 'Short input',
      outputContent: 'Short output',
    });

    // Total = applyFees(0.001) + storage > 0.001
    expect(result.totalDollars).toBeGreaterThan(0.001);
  });

  it('passes the provided generationId to the AIClient', async () => {
    const aiClient = makeMockAIClient(0.001);

    await calculateMessageCost({
      aiClient,
      generationId: 'gen-abc-xyz',
      modelId: 'test/model',
      inputContent: 'a',
      outputContent: 'b',
    });

    expect(aiClient.getGenerationStats).toHaveBeenCalledWith('gen-abc-xyz');
  });

  it('does not double-count web search cost — gateway totalCost already includes search', async () => {
    // Gateway returns 0.10 (which already bundles any search calls). The
    // calculator must not add another search reservation on top — it should
    // be exactly applyFees(0.10) plus the storage fee for the message bytes.
    const gatewayCost = 0.1;
    const aiClient = makeMockAIClient(gatewayCost);
    const inputContent = 'hi';
    const outputContent = 'world';

    const result = await calculateMessageCost({
      aiClient,
      generationId: 'gen-search-1',
      modelId: 'test/model',
      inputContent,
      outputContent,
    });

    const expected = applyFees(gatewayCost) + storageFee(inputContent, outputContent);
    expect(result.totalDollars).toBeCloseTo(expected, 10);
    expect(result.wasEstimated).toBe(false);
  });

  describe('estimation fallback when getGenerationStats throws', () => {
    it('falls back to a token-based estimate for text models and marks wasEstimated=true', async () => {
      const aiClient = makeFailingMockAIClient(new Error('Generation not found'));
      const inputContent = 'Hello';
      const outputContent = 'World';

      const result = await calculateMessageCost({
        aiClient,
        generationId: 'gen-missing',
        modelId: 'test/model',
        inputContent,
        outputContent,
      });

      // The estimator already includes storage; total dollars equals the estimate.
      expect(result.totalDollars).toBeCloseTo(
        expectedEstimateTotal(inputContent, outputContent),
        10
      );
      expect(result.wasEstimated).toBe(true);
      expect(aiClient.getModel).toHaveBeenCalledWith('test/model');
    });

    it('storage component of the estimate equals the success-path storage fee for the same content', async () => {
      const inputContent = 'a'.repeat(500);
      const outputContent = 'b'.repeat(500);

      const success = await calculateMessageCost({
        aiClient: makeMockAIClient(0),
        generationId: 'gen-ok',
        modelId: 'test/model',
        inputContent,
        outputContent,
      });
      const fallback = await calculateMessageCost({
        aiClient: makeFailingMockAIClient(new Error('404')),
        generationId: 'gen-fail',
        modelId: 'test/model',
        inputContent,
        outputContent,
      });

      // Subtract the model-cost component from each to isolate storage.
      // Success: applyFees(0) + storage = storage
      // Fallback: tokenCost (fee-inclusive prices, no extra wrap) + storage
      // For the success case the model cost is exactly 0, so totalDollars IS storage.
      expect(success.totalDollars).toBeCloseTo(storageFee(inputContent, outputContent), 10);
      // Fallback total = estimate (tokens at fee-inclusive prices + storage). Subtract token piece to get storage.
      // TOKEN_PRICING_* are fee-inclusive per the `ModelInfo.pricing` contract,
      // so no extra applyFees wrap is needed here.
      const tokensCost =
        estimateTokenCount(inputContent) * TOKEN_PRICING_INPUT +
        estimateTokenCount(outputContent) * TOKEN_PRICING_OUTPUT;
      const fallbackStorage = fallback.totalDollars - tokensCost;
      expect(fallbackStorage).toBeCloseTo(storageFee(inputContent, outputContent), 10);
    });

    it('returns 0 for empty content on both success and fallback paths', async () => {
      const successResult = await calculateMessageCost({
        aiClient: makeMockAIClient(0),
        generationId: 'gen-empty-ok',
        modelId: 'test/model',
        inputContent: '',
        outputContent: '',
      });
      const fallbackResult = await calculateMessageCost({
        aiClient: makeFailingMockAIClient(new Error('404')),
        generationId: 'gen-empty-fail',
        modelId: 'test/model',
        inputContent: '',
        outputContent: '',
      });
      expect(successResult.totalDollars).toBe(0);
      expect(fallbackResult.totalDollars).toBe(0);
      expect(fallbackResult.wasEstimated).toBe(true);
    });

    it.each<ModelPricing>([
      { kind: 'image', perImage: 0.04 },
      { kind: 'audio', perSecond: 0.001 },
      { kind: 'video', perSecondByResolution: { '720p': 0.05 } },
    ])(
      're-throws the original gateway error when pricing.kind is $kind (not estimable)',
      async (pricing) => {
        const originalErr = new Error('gateway-down');
        const aiClient = makeFailingMockAIClient(originalErr, { pricing });

        await expect(
          calculateMessageCost({
            aiClient,
            generationId: 'gen-x',
            modelId: 'test/model',
            inputContent: 'i',
            outputContent: 'o',
          })
        ).rejects.toBe(originalErr);
      }
    );

    it('propagates the getModel error when the fallback model lookup itself fails', async () => {
      const lookupErr = new Error('model catalog unreachable');
      const aiClient = {
        isMock: true,
        listModels: vi.fn(),
        getModel: vi.fn().mockRejectedValue(lookupErr),
        stream: vi.fn(),
        getGenerationStats: vi.fn().mockRejectedValue(new Error('404')),
      } as unknown as AIClient;

      await expect(
        calculateMessageCost({
          aiClient,
          generationId: 'gen-x',
          modelId: 'test/model',
          inputContent: 'i',
          outputContent: 'o',
        })
      ).rejects.toBe(lookupErr);
    });

    it('logs an error on fallback for production observability', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const aiClient = makeFailingMockAIClient(new Error('404'));

      await calculateMessageCost({
        aiClient,
        generationId: 'gen-fallback-log',
        modelId: 'test/model',
        inputContent: 'i',
        outputContent: 'o',
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const firstCall = errorSpy.mock.calls[0] ?? [];
      expect(String(firstCall[0])).toContain('billing');
      errorSpy.mockRestore();
    });
  });
});

describe('calculateMessageCostWithStages', () => {
  function makeMockClientByGenerationId(costsByGen: Record<string, number>): AIClient {
    return {
      isMock: true,
      listModels: vi.fn(),
      getModel: vi.fn().mockResolvedValue(makeMockModel()),
      stream: vi.fn(),
      getGenerationStats: vi.fn().mockImplementation((generationId: string) => {
        const costUsd = costsByGen[generationId];
        if (costUsd === undefined) {
          return Promise.reject(new Error(`No cost mock for ${generationId}`));
        }
        return Promise.resolve({ costUsd });
      }),
    } as unknown as AIClient;
  }

  function makeStageBilling(
    generationId: string,
    overrides: Partial<PreInferenceBilling> = {}
  ): PreInferenceBilling {
    return {
      stageId: 'smart-model',
      modelId: 'cheap/c',
      generationId,
      inputContent: 'classifier prompt',
      outputContent: 'cheap/c',
      ...overrides,
    };
  }

  it('returns totalDollars equal to main + stage attributions when there are no stages', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0.001 });
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      mainModelId: 'main/model',
      stageBillings: [],
      inputContent: 'in',
      outputContent: 'out',
    });
    expect(result.stageBreakdown).toEqual([]);
    expect(result.mainCostDollars).toBeCloseTo(result.totalDollars, 10);
    expect(result.totalDollars).toBeGreaterThan(0.001);
    expect(result.mainWasEstimated).toBe(false);
  });

  it('sums main + stage gateway costs into a single total with fees and storage', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0.005, classifier: 0.0001 });
    const stageBillings = [makeStageBilling('classifier')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      mainModelId: 'main/model',
      stageBillings,
      inputContent: 'in',
      outputContent: 'out',
    });
    const expectedStageCents = applyFees(0.0001);
    expect(result.stageBreakdown).toHaveLength(1);
    expect(result.stageBreakdown[0]?.gatewayCostUsd).toBeCloseTo(0.0001, 10);
    expect(result.stageBreakdown[0]?.costDollars).toBeCloseTo(expectedStageCents, 10);
    expect(result.stageBreakdown[0]?.wasEstimated).toBe(false);
    expect(result.mainWasEstimated).toBe(false);
    expect(result.mainCostDollars + result.stageBreakdown[0]!.costDollars).toBeCloseTo(
      result.totalDollars,
      10
    );
  });

  it('attributes storage entirely to the main cost, not to stages', async () => {
    const aiClient = makeMockClientByGenerationId({ main: 0, classifier: 0 });
    const stageBillings = [makeStageBilling('classifier')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      mainModelId: 'main/model',
      stageBillings,
      inputContent: 'a'.repeat(1000),
      outputContent: 'b'.repeat(1000),
    });
    // Stage cost = applyFees(0) = 0; main cost is entirely storage
    expect(result.stageBreakdown[0]?.costDollars).toBe(0);
    expect(result.mainCostDollars).toBeGreaterThan(0);
    expect(result.totalDollars).toBeCloseTo(result.mainCostDollars, 10);
  });

  it('handles multiple stages additively', async () => {
    const aiClient = makeMockClientByGenerationId({
      main: 0.01,
      stage1: 0.001,
      stage2: 0.002,
    });
    const stageBillings = [makeStageBilling('stage1'), makeStageBilling('stage2')];
    const result = await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      mainModelId: 'main/model',
      stageBillings,
      inputContent: 'i',
      outputContent: 'o',
    });
    expect(result.stageBreakdown).toHaveLength(2);
    const sum =
      result.mainCostDollars + result.stageBreakdown.reduce((s, b) => s + b.costDollars, 0);
    expect(sum).toBeCloseTo(result.totalDollars, 10);
  });

  it('fetches all generation stats in parallel', async () => {
    const aiClient = makeMockClientByGenerationId({
      main: 0.01,
      stage1: 0.001,
      stage2: 0.002,
    });
    const callOrder: string[] = [];
    const COST_BY_ID: Record<string, number> = { main: 0.01, stage1: 0.001, stage2: 0.002 };
    type StatsImpl = (id: string) => Promise<{ costUsd: number }>;
    const mockedStats = aiClient.getGenerationStats as ReturnType<typeof vi.fn> & {
      mockImplementation(implementation: StatsImpl): unknown;
    };
    mockedStats.mockImplementation((id: string) => {
      callOrder.push(`start:${id}`);
      // simulate different latencies
      const delay = id === 'main' ? 5 : 1;
      const cost = COST_BY_ID[id] ?? 0;
      return new Promise<{ costUsd: number }>((resolve) => {
        const finish = (): void => {
          callOrder.push(`end:${id}`);
          resolve({ costUsd: cost });
        };
        setTimeout(finish, delay);
      });
    });
    await calculateMessageCostWithStages({
      aiClient,
      mainGenerationId: 'main',
      mainModelId: 'main/model',
      stageBillings: [makeStageBilling('stage1'), makeStageBilling('stage2')],
      inputContent: 'i',
      outputContent: 'o',
    });
    // Parallel: all starts come before any ends — even though main is slowest.
    expect(callOrder.slice(0, 3).every((s) => s.startsWith('start:'))).toBe(true);
  });

  describe('per-row estimation fallback', () => {
    function makeMixedClient(
      costsByGen: Record<string, number>,
      modelByGen: Record<string, Partial<ModelInfo>> = {}
    ): AIClient {
      return {
        isMock: true,
        listModels: vi.fn(),
        getModel: vi.fn().mockImplementation((modelId: string) => {
          const overrides = modelByGen[modelId] ?? {};
          return Promise.resolve(makeMockModel(overrides));
        }),
        stream: vi.fn(),
        getGenerationStats: vi.fn().mockImplementation((generationId: string) => {
          const costUsd = costsByGen[generationId];
          if (costUsd === undefined) {
            return Promise.reject(new Error(`No cost mock for ${generationId}`));
          }
          return Promise.resolve({ costUsd });
        }),
      } as unknown as AIClient;
    }

    it('main fails → mainWasEstimated true, stages stay exact', async () => {
      const aiClient = makeMixedClient({ stage1: 0.001 }); // 'main' absent → reject
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [makeStageBilling('stage1')],
        inputContent: 'i',
        outputContent: 'o',
      });
      expect(result.mainWasEstimated).toBe(true);
      expect(result.stageBreakdown[0]?.wasEstimated).toBe(false);
    });

    it('main succeeds, one stage fails → only that stage falls back', async () => {
      const aiClient = makeMixedClient({ main: 0.005, stage2: 0.0001 }); // stage1 absent
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [makeStageBilling('stage1'), makeStageBilling('stage2')],
        inputContent: 'i',
        outputContent: 'o',
      });
      expect(result.mainWasEstimated).toBe(false);
      expect(result.stageBreakdown[0]?.wasEstimated).toBe(true);
      expect(result.stageBreakdown[1]?.wasEstimated).toBe(false);
    });

    it('all stages fail → every stage falls back, order preserved', async () => {
      const aiClient = makeMixedClient({ main: 0.005 });
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [
          makeStageBilling('s1', { stageId: 'A' as never }),
          makeStageBilling('s2', { stageId: 'B' as never }),
          makeStageBilling('s3', { stageId: 'C' as never }),
        ],
        inputContent: 'i',
        outputContent: 'o',
      });
      expect(result.stageBreakdown.map((b) => b.wasEstimated)).toEqual([true, true, true]);
      expect(result.stageBreakdown.map((b) => b.billing.stageId)).toEqual(['A', 'B', 'C']);
    });

    it('all calls fail → main + every stage fall back', async () => {
      const aiClient = makeMixedClient({}); // no successes
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [makeStageBilling('s1'), makeStageBilling('s2')],
        inputContent: 'i',
        outputContent: 'o',
      });
      expect(result.mainWasEstimated).toBe(true);
      expect(result.stageBreakdown.every((b) => b.wasEstimated)).toBe(true);
    });

    it('sum invariant holds when main and some stages are estimated', async () => {
      const aiClient = makeMixedClient({ stage2: 0.001 }); // main + stage1 fail
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [makeStageBilling('stage1'), makeStageBilling('stage2')],
        inputContent: 'in',
        outputContent: 'out',
      });
      const stageSum = result.stageBreakdown.reduce((s, b) => s + b.costDollars, 0);
      expect(result.mainCostDollars + stageSum).toBeCloseTo(result.totalDollars, 10);
    });

    it('per-stage model id is used for the estimate lookup (not main model id)', async () => {
      const aiClient = makeMixedClient({}, {});
      const getModelSpy = aiClient.getModel as ReturnType<typeof vi.fn>;
      await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [makeStageBilling('s1', { modelId: 'stage/model-A' })],
        inputContent: 'i',
        outputContent: 'o',
      });
      expect(getModelSpy).toHaveBeenCalledWith('main/model');
      expect(getModelSpy).toHaveBeenCalledWith('stage/model-A');
    });

    it('stage fallback excludes storage cost — storage stays attributed to main', async () => {
      // Regression guard: an earlier version included storage in the stage's
      // costDollars when the stage estimated, double-counting storage for the
      // classifier's input/output characters. Stages must NEVER carry storage
      // (per the docstring on calculateMessageCostWithStages).
      const aiClient = makeMixedClient({ main: 0.005 }); // stage rejects → fallback
      const stageBilling = makeStageBilling('s1', {
        inputContent: 'a'.repeat(2000), // would add ~$0.0006 of storage if leaked
        outputContent: 'b'.repeat(2000),
      });
      const result = await calculateMessageCostWithStages({
        aiClient,
        mainGenerationId: 'main',
        mainModelId: 'main/model',
        stageBillings: [stageBilling],
        inputContent: 'short',
        outputContent: 'short',
      });

      const stage = result.stageBreakdown[0]!;
      expect(stage.wasEstimated).toBe(true);

      // Stage cost = estimateTokenCost (already fee-inclusive because
      // ModelInfo.pricing.* prices are fee-inclusive). No storage on stages.
      const estimatedTokenCost =
        estimateTokenCount(stageBilling.inputContent) * TOKEN_PRICING_INPUT +
        estimateTokenCount(stageBilling.outputContent) * TOKEN_PRICING_OUTPUT;
      expect(stage.costDollars).toBeCloseTo(estimatedTokenCost, 12);

      // Stage costDollars must be strictly less than what an estimate-with-storage
      // would have produced; this is the regression check.
      const stageStorage = storageFee(stageBilling.inputContent, stageBilling.outputContent);
      expect(stage.costDollars).toBeLessThan(estimatedTokenCost + stageStorage * 0.99);
    });

    it('re-throws when any failing call has non-token pricing (still hard-fail in that case)', async () => {
      const originalErr = new Error('gateway-down');
      const aiClient = {
        isMock: true,
        listModels: vi.fn(),
        getModel: vi
          .fn()
          .mockResolvedValueOnce(makeMockModel({ pricing: { kind: 'image', perImage: 0.04 } })),
        stream: vi.fn(),
        getGenerationStats: vi.fn().mockRejectedValue(originalErr),
      } as unknown as AIClient;

      await expect(
        calculateMessageCostWithStages({
          aiClient,
          mainGenerationId: 'main',
          mainModelId: 'main/model',
          stageBillings: [],
          inputContent: 'i',
          outputContent: 'o',
        })
      ).rejects.toBe(originalErr);
    });
  });
});

describe('recordBillingMismatchIfExceeded', () => {
  const fakeDb = { __fake: 'db' } as unknown as import('@hushbox/db').Database;

  it('exposes a sensible default threshold', () => {
    // Threshold is a fractional ratio (e.g. 0.5 == 50% deviation tolerated).
    expect(BILLING_MISMATCH_THRESHOLD_RATIO).toBeGreaterThan(0);
    expect(BILLING_MISMATCH_THRESHOLD_RATIO).toBeLessThan(1);
  });

  it('records evidence when actual exceeds estimate by more than the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.01,
      actualUsd: 0.02, // +100% deviation
      evidence: { db: fakeDb, isCI: true },
    });

    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
    expect(recordEvidenceMock).toHaveBeenCalledWith(
      fakeDb,
      true,
      SERVICE_NAMES.BILLING_MISMATCH,
      expect.objectContaining({
        estimateUsd: 0.01,
        actualUsd: 0.02,
      })
    );
  });

  it('records evidence when actual undershoots estimate by more than the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.1,
      actualUsd: 0.01, // 90% under
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('does not record evidence when within the threshold', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.1,
      actualUsd: 0.11, // +10% deviation
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });

  it('does not record evidence when no evidence config is supplied', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0.01,
      actualUsd: 1,
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });

  it('records when actual is non-zero against a zero estimate', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0,
      actualUsd: 0.5,
      evidence: { db: fakeDb, isCI: true },
    });
    // A non-zero actual against a zero estimate is, by any sane definition,
    // an unbounded deviation — record it.
    expect(recordEvidenceMock).toHaveBeenCalledTimes(1);
  });

  it('does not record when both estimate and actual are zero', async () => {
    recordEvidenceMock.mockClear();
    await recordBillingMismatchIfExceeded({
      estimateUsd: 0,
      actualUsd: 0,
      evidence: { db: fakeDb, isCI: true },
    });
    expect(recordEvidenceMock).not.toHaveBeenCalled();
  });
});
