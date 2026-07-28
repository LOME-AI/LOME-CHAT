/**
 * The multi-model `auto` turn's classifier: the graph it compiles to, the
 * amounts admission holds for it, and the prompt it is actually sent.
 *
 * Every assertion here is about the definition a REQUEST compiles — the
 * production `compileMultiModelTurn` — rather than about a reassembled twin, so
 * a sizing or shape change cannot pass here and fail in a run.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ERROR_CODES,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  REASONING_EFFORT_LABELS,
  TURN_DECISION_REDUCER,
  isTurnClassifierNode,
  nanoUSD,
  textTag,
} from '@hushbox/shared';
import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/classifier-line-item';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  reducerCode,
} from '../../workflows/index.js';
import { createModelCallExecution } from '../../workflows/nodes/model-call-execution.js';
import { createValueStore } from '../../workflows/engine/value-store.js';
import { ok } from '../../../lib/result/index.js';
import { CHAT_CLASSIFIER_INPUT, CHAT_TURN_INPUT } from './index.js';
import { compileMultiModelTurn, turnInputs } from './turn-definition.js';
import type { TurnBudget } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type {
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  ModelReasoning,
  Node,
} from '@hushbox/shared';

const TURN_PROMPT = 'what is the airspeed velocity of an unladen swallow?';

function descriptorOf(id: string, reasoning?: ModelReasoning, rate = 2000n): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 128_000, maxOutputTokens: 16_000 },
    pricing: { inputPerToken: nanoUSD(rate), outputPerToken: nanoUSD(rate * 4n) },
    ...(reasoning === undefined ? {} : { reasoning }),
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

/** A model with no reasoning metadata at all — it offers no effort choice. */
const UNSET_REASONING: ModelReasoning | undefined = undefined;

/** An open-ladder reasoner: offers the full canonical ladder plus Min. */
const LADDER: ModelReasoning = { supportedEfforts: null };

/** The cheapest model in the catalog — by construction, the classifier engine. */
const ENGINE = descriptorOf('cheap/engine', UNSET_REASONING, 100n);
const REASONER = descriptorOf('a/reasoner', LADDER);
const OTHER = descriptorOf('b/reasoner', LADDER, 3000n);

const CATALOG: readonly ModelDescriptor[] = [ENGINE, REASONER, OTHER];
const resolve: ModelPricingResolver = (id) => CATALOG.find((model) => model.id === id);

const BUDGET: TurnBudget = {
  promptCharacterCount: 400,
  funding: { kind: 'purchased', remainingNanoUsd: 5_000_000_000n },
};

function compileAuto(models: readonly string[] = [REASONER.id, OTHER.id]): {
  readonly nodes: readonly Node[];
  readonly classifierPrompt: string | undefined;
} {
  const build = compileMultiModelTurn(resolve, models, {
    budget: BUDGET,
    reasoningEffort: 'auto',
    catalog: CATALOG,
  })._unsafeUnwrap();
  return { nodes: build.definition.nodes, classifierPrompt: build.classifierPrompt };
}

function classifierNode(nodes: readonly Node[]): Extract<Node, { type: 'modelCall' }> {
  const found = nodes.find((node): node is Extract<Node, { type: 'modelCall' }> =>
    isTurnClassifierNode(node, nodes)
  );
  if (found === undefined) throw new Error('the compiled turn has no classifier node');
  return found;
}

describe('the multi-model auto turn compiles a classifier', () => {
  it('derives exactly one classifier from the decision reducer', () => {
    const { nodes } = compileAuto();
    expect(nodes.filter((node) => isTurnClassifierNode(node, nodes))).toHaveLength(1);
  });

  it('runs the classifier on the cheapest priceable engine, not on a selected model', () => {
    expect(classifierNode(compileAuto().nodes).model).toBe(ENGINE.id);
  });

  it('caps the classifier call at the output cap its reserve is priced against', () => {
    // The constant had no production consumer: the reserve priced a cap the
    // request did not enforce.
    expect(classifierNode(compileAuto().nodes).params['maxOutputTokens']).toBe(
      CLASSIFIER_OUTPUT_TOKEN_CAP
    );
  });

  it('lets a classifier failure skip rather than fail the turn', () => {
    const node = classifierNode(compileAuto().nodes);
    expect({ optional: node.optional, onError: node.onError }).toEqual({
      optional: true,
      onError: 'skip',
    });
  });

  it('feeds every sibling the decision rather than the raw prompt', () => {
    const { nodes } = compileAuto();
    const siblings = nodes.filter(
      (node) => node.type === 'modelCall' && !isTurnClassifierNode(node, nodes)
    );
    const decide = nodes.find((node) => node.type === 'fanIn');
    expect(siblings).toHaveLength(2);
    expect(decide?.type === 'fanIn' && decide.reducer).toBe(TURN_DECISION_REDUCER);
    for (const sibling of siblings) {
      expect(sibling.type === 'modelCall' && sibling.in.node).toBe(decide?.id);
    }
  });

  it('leaves a pinned-effort turn exactly as it was — no classifier, no second input', () => {
    const build = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'high',
      catalog: CATALOG,
    })._unsafeUnwrap();
    expect(build.classifierPrompt).toBeUndefined();
    expect(build.definition.nodes.filter((node) => node.type === 'fanIn')).toHaveLength(0);
  });

  it('buys no classifier when the turn has fewer than two real choices', () => {
    // Two non-reasoning models offer no effort choice at all, so the answer is
    // settled and no call is bought.
    const plain = descriptorOf('c/plain');
    const catalog = [ENGINE, plain];
    const build = compileMultiModelTurn((id) => catalog.find((m) => m.id === id), [plain.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog,
    })._unsafeUnwrap();
    expect(build.classifierPrompt).toBeUndefined();
  });
});

describe('an absent catalog is an empty one, not an opt-out', () => {
  it('refuses a classifiable auto turn rather than silently leaving it unclassified', () => {
    // Omission must not be a quiet way to disable classification: a caller that
    // forgot the snapshot would otherwise ship unclassified `auto` turns, which
    // is the regression this path exists to remove and is invisible.
    const refused = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
    });
    expect(refused._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('leaves a pinned-effort turn alone, because it never asks for an engine', () => {
    const built = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'high',
    });
    expect(built.isOk()).toBe(true);
    expect(built._unsafeUnwrap().classifierPrompt).toBeUndefined();
  });
});

describe('the classifier is presented the options the turn presents', () => {
  it('omits a declared rung the turn does not present', () => {
    // `lite` is in the effort dimension's declared domain; a positional ladder
    // of three rungs presents Low/Mid/High, so Lite is not the turn's to offer.
    const threeRung: ModelReasoning = { supportedEfforts: ['low', 'medium', 'high'] };
    const narrow = descriptorOf('d/three', threeRung);
    const catalog = [ENGINE, narrow];
    const build = compileMultiModelTurn((id) => catalog.find((m) => m.id === id), [narrow.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog,
    })._unsafeUnwrap();

    const prompt = build.classifierPrompt ?? '';
    expect(prompt).toContain(REASONING_EFFORT_LABELS.high);
    expect(prompt).not.toContain(REASONING_EFFORT_LABELS.lite);
  });

  it('presents every rung a wider turn does offer', () => {
    const prompt = compileAuto().classifierPrompt ?? '';
    for (const label of [
      REASONING_EFFORT_LABELS.lite,
      REASONING_EFFORT_LABELS.medium,
      REASONING_EFFORT_LABELS.max,
    ]) {
      expect(prompt).toContain(label);
    }
  });
});

describe('the assembled classifier call fits the amount reserved for it', () => {
  /** A conversation far past the truncation budget on both sides. */
  const LONG_USER = 'u'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS * 3);
  const LONG_ASSISTANT = 'a'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS * 3);

  /**
   * Exactly what the run receives — read out of the PRODUCTION assembler rather
   * than rebuilt here. A reassembled twin would keep passing while `turnInputs`
   * changed what it actually sends, which is the failure mode this whole
   * describe exists to catch.
   */
  function assembledInput(): string {
    const build = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog: CATALOG,
    })._unsafeUnwrap();
    const inputs = turnInputs(build, LONG_USER, [{ role: 'assistant', content: LONG_ASSISTANT }]);
    const classifierInput = inputs[CHAT_CLASSIFIER_INPUT];
    if (classifierInput?.kind !== 'text') {
      throw new Error('the classifying turn declared no classifier input');
    }
    return classifierInput.text;
  }

  it('sends no more input than the classifier reserve priced', () => {
    // `reserve ⊇ bill` on the real assembled request. The reserve prices the
    // truncation budget plus the rendered template; the request must not exceed
    // it — and with the base system preamble suppressed for a routing call,
    // nothing else is added downstream.
    expect(assembledInput().length).toBeLessThanOrEqual(classifierReserveChars([]));
  });

  it('still spends most of the budget on conversation rather than template', () => {
    // A bound that holds only because the excerpt is empty would be worthless.
    expect(assembledInput().length).toBeGreaterThan(MAX_CLASSIFIER_CONTEXT_CHARS);
  });
});

describe('the decision reaches the siblings', () => {
  /** The REGISTERED reducer, resolved the way the interpreter resolves it. */
  const decide = reducerCode(DEFAULT_WORKFLOW_CAPABILITIES).get(TURN_DECISION_REDUCER);
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);

  /** Captures the InferenceRequest a sibling's execution actually sends. */
  async function runSibling(input: unknown): Promise<InferenceRequest> {
    const { nodes } = compileAuto();
    const sibling = nodes.find(
      (node): node is Extract<Node, { type: 'modelCall' }> =>
        node.type === 'modelCall' && !isTurnClassifierNode(node, nodes)
    );
    if (sibling === undefined) throw new Error('no sibling in the compiled turn');
    const requests: InferenceRequest[] = [];
    const execution = createModelCallExecution({
      provider: {
        infer: (request) => {
          requests.push(request);
          return (async function* stream(): AsyncGenerator<InferenceEvent> {
            await Promise.resolve();
            yield {
              kind: 'finish',
              metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
            };
          })();
        },
      },
      binding: {
        descriptor: REASONER,
        ports: { in: [textTag()], out: textTag() },
        price: () => ok(0n),
      },
      usdToBillableNanoUsd: () => 0n,
      schemas: {
        resolveSchema: (name) => constraints.resolve('schema', name)?.schema,
      },
    });
    await execution.run(sibling, [input], {
      values: createValueStore(1_000_000),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      signal: new AbortController().signal,
    });
    const sent = requests[0];
    if (sent === undefined) throw new Error('the sibling sent no request');
    return sent;
  }

  it('applies the level the classifier actually chose, not the fallback', async () => {
    const chosen = decide?.([TURN_PROMPT, `effort: ${REASONING_EFFORT_LABELS.low}`]);
    const fallback = decide?.([TURN_PROMPT, undefined]);
    // The pin discriminates only if the two differ: a classifier whose choice
    // equalled the fallback would prove nothing about the answer being read.
    expect((chosen as { effort: string }).effort).not.toBe((fallback as { effort: string }).effort);

    const [chosenRequest, fallbackRequest] = [await runSibling(chosen), await runSibling(fallback)];
    expect(chosenRequest.parameters['reasoning']).toEqual({ effort: 'low' });
    expect(fallbackRequest.parameters['reasoning']).not.toEqual(
      chosenRequest.parameters['reasoning']
    );
  });

  it('falls back rather than failing when the classifier produced no answer', async () => {
    const request = await runSibling(decide?.([TURN_PROMPT, undefined]));
    expect(request.parameters['reasoning']).toBeDefined();
    expect(request.inputs[0]).toEqual({ modality: 'text', text: TURN_PROMPT });
  });

  it('sends the turn prompt, never the envelope, to the provider', async () => {
    const request = await runSibling(
      decide?.([TURN_PROMPT, `effort: ${REASONING_EFFORT_LABELS.max}`])
    );
    expect(request.inputs).toEqual([{ modality: 'text', text: TURN_PROMPT }]);
  });
});

describe('the turn refuses rather than picking an effort itself', () => {
  it('fails with the typed classifier code when no engine can price the call', () => {
    // §Reasoning Effort 5(d): no priceable classifier engine is a typed refusal,
    // never a silent static level — explicit levels stay usable.
    const rateless = {
      ...REASONER,
      id: 'e/rateless',
      pricing: {},
    } as unknown as ModelDescriptor;
    const catalog = [rateless];
    const failed = compileMultiModelTurn((id) => catalog.find((m) => m.id === id), [rateless.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog,
    });
    expect(failed._unsafeUnwrapErr().wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });
});

describe('the run inputs carry the classifier prompt only when the turn classifies', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'earlier question' },
    { role: 'assistant' as const, content: 'earlier answer' },
  ];

  it('sends one input for a pinned-effort turn', () => {
    const build = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'high',
      catalog: CATALOG,
    })._unsafeUnwrap();
    expect(Object.keys(turnInputs(build, TURN_PROMPT, HISTORY))).toEqual([CHAT_TURN_INPUT]);
  });

  it('sends the rendered prompt and the excerpt for an auto turn', () => {
    const build = compileMultiModelTurn(resolve, [REASONER.id, OTHER.id], {
      budget: BUDGET,
      reasoningEffort: 'auto',
      catalog: CATALOG,
    })._unsafeUnwrap();
    const inputs = turnInputs(build, TURN_PROMPT, HISTORY);
    const classifierInput = inputs[CHAT_CLASSIFIER_INPUT];
    expect(new Set(Object.keys(inputs))).toEqual(new Set([CHAT_CLASSIFIER_INPUT, CHAT_TURN_INPUT]));
    // The excerpt reaches the classifier: both sides of the latest exchange.
    expect(classifierInput?.kind === 'text' && classifierInput.text).toContain('earlier answer');
    expect(classifierInput?.kind === 'text' && classifierInput.text).toContain(TURN_PROMPT);
  });
});
