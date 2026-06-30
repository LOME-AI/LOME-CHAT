import { describe, expect, it } from 'vitest';
import { executePreInferenceChain } from './executor.js';
import type {
  InferenceTransformation,
  PreInferenceBilling,
  PreInferenceOutcome,
} from '@hushbox/shared';

import type { AIClient } from '../../services/ai/index.js';
import type { SSEEventWriter } from '../stream-handler.js';

import type { PreInferenceRunArgs, PreInferenceStage } from './types.js';

function noopAIClient(): AIClient {
  return {
    isMock: false,
    listModels: () => Promise.resolve([]),
    listRawModels: () => Promise.resolve([]),
    listModelsForModality: () => Promise.resolve([]),
    getModel: () => Promise.reject(new Error('not used')),
    stream: () => ({
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: () =>
            Promise.resolve<IteratorResult<never>>({ value: undefined as never, done: true }),
        };
      },
    }),
    getGenerationStats: () => Promise.resolve({ costUsd: 0 }),
  };
}

function noopWriter(): SSEEventWriter {
  const noop = (): Promise<void> => Promise.resolve();
  return {
    writeStart: noop,
    writeModelToken: noop,
    writeModelMediaStart: noop,
    writeModelMediaProgress: noop,
    writeError: noop,
    writeModelDone: noop,
    writeModelError: noop,
    writeDone: noop,
    writeStageStart: noop,
    writeStageDone: noop,
    writeStageError: noop,
    isConnected: () => true,
    isDoneWritten: () => false,
  };
}

function makeStage(
  id: 'smart-model',
  outcome: PreInferenceOutcome,
  reservedCents = 0,
  observe?: (args: PreInferenceRunArgs) => void
): PreInferenceStage {
  return {
    id,
    reserveCents: () => reservedCents,
    run: (args) => {
      observe?.(args);
      return Promise.resolve(outcome);
    },
  };
}

const successOutcome = (
  transformation: InferenceTransformation,
  billing: PreInferenceBilling | null = null
): PreInferenceOutcome => ({ ok: true, transformation, billing });

describe('executePreInferenceChain', () => {
  it('returns an empty transformation and no billings for an empty chain', async () => {
    const result = await executePreInferenceChain({
      stages: [],
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-1',
    });
    expect(result).toEqual({ ok: true, transformation: {}, billings: [], stagesRun: [] });
  });

  it('runs each stage and merges transformations in order', async () => {
    const stages = [
      makeStage('smart-model', successOutcome({ resolvedModelId: 'm/a' })),
      makeStage('smart-model', successOutcome({ resolvedPrompt: 'enhanced' })),
    ];

    const result = await executePreInferenceChain({
      stages,
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transformation).toEqual({
      resolvedModelId: 'm/a',
      resolvedPrompt: 'enhanced',
    });
  });

  it('passes the cumulative upstream transformation to subsequent stages', async () => {
    const observed: InferenceTransformation[] = [];
    const stages = [
      makeStage('smart-model', successOutcome({ resolvedModelId: 'm/a' }), 0, (args) => {
        observed.push(args.upstream);
      }),
      makeStage('smart-model', successOutcome({ resolvedPrompt: 'enhanced' }), 0, (args) => {
        observed.push(args.upstream);
      }),
    ];

    await executePreInferenceChain({
      stages,
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-1',
    });

    expect(observed[0]).toEqual({});
    expect(observed[1]).toEqual({ resolvedModelId: 'm/a' });
  });

  it('collects billing breadcrumbs from stages that emit them', async () => {
    const billing: PreInferenceBilling = {
      stageId: 'smart-model',
      modelId: 'cheap/c',
      generationId: 'gen-1',
      inputContent: 'in',
      outputContent: 'out',
    };
    const stages = [
      makeStage('smart-model', successOutcome({ resolvedModelId: 'm/a' }, billing)),
      makeStage('smart-model', successOutcome({})), // no billing
    ];

    const result = await executePreInferenceChain({
      stages,
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.billings).toHaveLength(1);
    expect(result.billings[0]).toBe(billing);
  });

  it('stops at the first failure and returns the error code', async () => {
    let secondRan = false;
    const stages = [
      makeStage('smart-model', { ok: false, errorCode: 'CLASSIFIER_FAILED' }),
      makeStage('smart-model', successOutcome({ resolvedPrompt: 'enhanced' }), 0, () => {
        secondRan = true;
      }),
    ];

    const result = await executePreInferenceChain({
      stages,
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('CLASSIFIER_FAILED');
    expect(secondRan).toBe(false);
  });

  it('forwards the assistantMessageId unchanged to every stage', async () => {
    const seenIds: string[] = [];
    const stages = [
      makeStage('smart-model', successOutcome({}), 0, (args) =>
        seenIds.push(args.assistantMessageId)
      ),
      makeStage('smart-model', successOutcome({}), 0, (args) =>
        seenIds.push(args.assistantMessageId)
      ),
    ];

    await executePreInferenceChain({
      stages,
      aiClient: noopAIClient(),
      writer: noopWriter(),
      assistantMessageId: 'asst-fixed',
    });

    expect(seenIds).toEqual(['asst-fixed', 'asst-fixed']);
  });
});
