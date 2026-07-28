import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PolicyHooks, jsonTag, nanoUSD, optionalTag, textTag, usdToNanoUsd } from '@hushbox/shared';
import { providerUsdToBillableNanoUsd } from '../../billing/index.js';
import { ok } from '../../../lib/result/index.js';
import { fanIn } from '../builder/fan-in.js';
import { modelCall } from '../builder/model-call.js';
import { smartModel } from '../builder/smart-model.js';
import { workflowInputs } from '../builder/workflow-inputs.js';
import { buildWorkflow } from '../builder/build-workflow.js';
import { createWorkflowExecutor } from './interpreter.js';
import { createLiveExecutionRegistry } from './live-execution-registry.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  predicateCode,
  reducerCode,
} from './workflow-capabilities.js';
import { setupIntegrationProvider } from '../../models/adapters/integration-setup.js';
import { portsAccepting } from './model-ports.js';
import { TURN_DECISION_SCHEMA_NAME } from '../nodes/turn-decision.js';
import type {
  InferenceEvent,
  ModelDescriptor,
  SettlementRequest,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ModelProvider } from '../../models/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { NodeRegistryContext } from '../compile/context.js';
import type { ModelBinding } from '../nodes/model-call-execution.js';
import type { SubWorkflowBinding } from './live-execution-registry.js';
import type { EngineAdmissionDecision } from './hooks.js';

/**
 * Smart-model turn through the ONE provider factory: the data-driven
 * three-generation smartModel definition (classifier → resolve → answer)
 * driven through the full workflow executor with the provider from
 * {@link setupIntegrationProvider} — the same harness the modality adapter
 * suites use, so the suite runs EVERYWHERE with no skip. Locally (any non-CI
 * shell) the deterministic mock answers both generations — its classifier
 * call-shape support emits the same billable finish contract (inline cost,
 * generation id, non-zero usage) as the real adapters, no key/db/cassette, and
 * structurally no service-evidence write. In CI-vitest the real provider runs
 * under `OPENROUTER_API_KEY_RESTRICTED` with record-on-miss cassettes, and the
 * factory's evidence wrapper records `openrouter` service-evidence on the
 * first live event. Two distinct ZDR candidates force the classifier to run,
 * so ONE turn crosses the wire TWICE (classifier + chosen-model answer), and
 * both generations settle with the provider's authoritative inline cost.
 *
 * Mirrors the legacy `smart-model.integration.test.ts` + `billing.integration.test.ts`
 * assertions (two billable generations; real cost through the fee helper), but
 * drives the new-tree engine seam that `engine/live-run.test.ts` exercises with
 * an injected fake provider — here with the factory-resolved one.
 */

const RUN_KEY = 'smart-model-real-run';
const HOOKS = PolicyHooks.parse({ admission: 'chat', settlement: 'chat' });
const RUN_TIMEOUT_MS = 60_000;

/**
 * Two genuinely distinct ZDR-reachable text models: candidate[0] is the
 * cheapest and doubles as the classifier, candidate[1] the alternative the
 * classifier may route to. Hardcoded (not picked from the drifting live
 * catalog) so every inference request hashes stably and its cassette replays
 * deterministically; a non-ZDR id fails loudly on the founder's out-of-band
 * record run (OpenRouter fails closed on a non-ZDR call), the right place to
 * catch it.
 */
const CLASSIFIER_MODEL_ID = 'openai/gpt-4o-mini';
const ANSWER_MODEL_ID = 'openai/gpt-4o';

/** The classifier's own output cap — one labelled line is all it may emit. */
const CLASSIFIER_TEST_OUTPUT_CAP = 32;

/**
 * The turn prompt. It doubles as the classifier's instruction here because the
 * real classifier prompt is the wiring layer's, not this seam's: what this test
 * proves is that ONE labelled line crossing the wire routes the slot to the
 * OTHER candidate, so the answer generation must be observably a different
 * model from the classifier's.
 */
const TURN_PROMPT = `Reply with exactly this line and nothing else:\nmodel: ${ANSWER_MODEL_ID}`;

function makeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  };
}

/** A minimal text→text descriptor per candidate id (ports/pricing only — the
 * real inline cost comes from the gateway, not `price`). */
function descriptorFor(id: string): ModelDescriptor {
  return {
    id,
    provider: id.split('/')[0] ?? id,
    version: '2',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function bindingFor(id: string): ModelBinding {
  return {
    descriptor: descriptorFor(id),
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(5n),
  };
}

/** Test-local compile node registry double: text→text ports for every node. */
const nodes: NodeRegistryContext = {
  hasNode: (_type, version) => version === 1,
  // Text→text for every model, except that a node declaring an input schema
  // takes that named json tag instead — the same derivation the live registry
  // applies, so the decision edge type-checks at compile exactly as it does in
  // production.
  resolveValuePorts: (node) =>
    portsAccepting(
      { in: [textTag()], out: textTag() },
      'inputSchema' in node ? node.inputSchema : undefined
    ),
};

const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
const registries = { nodes, constraints };

const compute = {
  execute: vi.fn(),
  resolvePorts: vi.fn(),
} as unknown as TransformCompute;

function grant(limit: bigint): EngineAdmissionDecision {
  return {
    admitted: true,
    holdRef: 'hold',
    circuit: {
      estimateNanoUsd: limit,
      costCircuitMultiplier: 5n,
      costCircuitLimitNanoUsd: limit,
    },
  };
}

/** No sub-workflows in the smart-model turn — every ref misses. */
const NO_SUB_WORKFLOWS: Record<string, SubWorkflowBinding | undefined> = {};

/**
 * The turn-level shape: an ORDINARY `modelCall` classifies, the registered
 * `decideTurn` reducer joins its answer to the prompt as the decision envelope,
 * and the Smart Model slot consumes that envelope and binds one candidate. The
 * slot makes no call of its own, so the two generations that cross the wire are
 * two separate NODES — which is what puts the classifier's charge under its own
 * top-level key, with no content of its own.
 */
function smartModelDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: CLASSIFIER_MODEL_ID,
    accepts: textTag(),
    produces: textTag(),
    params: { maxOutputTokens: CLASSIFIER_TEST_OUTPUT_CAP },
    in: inputs.ports.prompt,
  });
  const decide = fanIn({
    id: 'decide',
    reducer: 'decideTurn',
    accepts: [textTag(), optionalTag(textTag())],
    ins: [inputs.ports.prompt, classify.out],
    produces: jsonTag(TURN_DECISION_SCHEMA_NAME),
  });
  const smart = smartModel({
    id: 'answer',
    classifierModelId: CLASSIFIER_MODEL_ID,
    candidates: [
      { id: CLASSIFIER_MODEL_ID, description: 'A small, fast, cheap general model.' },
      { id: ANSWER_MODEL_ID, description: 'A larger, more capable general model.' },
    ],
    accepts: jsonTag(TURN_DECISION_SCHEMA_NAME),
    in: decide.out,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, decide, smart],
    registries,
  })._unsafeUnwrap().definition;
}

interface LiveRun {
  readonly outcome: { readonly outcome: string };
  readonly settlement: SettlementRequest | undefined;
  /** Every stream envelope the run emitted — the terminal finish carries the raw inline cost. */
  readonly events: readonly { readonly event: InferenceEvent }[];
}

/**
 * Asserts a single settlement charge carries the gateway's authoritative
 * inline cost (never an estimate), a real generation id, and token usage.
 */
function expectBilledTextGeneration(charge: SettlementRequest['charges'][number]): void {
  expect(charge.modality).toBe('text');
  expect(charge.billableCostNanoUsd).toBeGreaterThan(0n);
  expect(charge.isEstimated).toBe(false);
  expect(charge.generationId?.length ?? 0).toBeGreaterThan(0);
  expect(charge.tokens?.outputTokens ?? 0).toBeGreaterThan(0);
}

async function runSmartModelTurn(provider: ModelProvider): Promise<LiveRun> {
  const settlements: SettlementRequest[] = [];
  const events: { readonly event: InferenceEvent }[] = [];
  const execution = createLiveExecutionRegistry({
    provider,
    models: {
      resolve: (id) =>
        id === CLASSIFIER_MODEL_ID || id === ANSWER_MODEL_ID ? bindingFor(id) : undefined,
    },
    compute,
    subWorkflows: { resolve: (ref) => NO_SUB_WORKFLOWS[ref] },
    schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
  });
  const executor = createWorkflowExecutor({
    registries,
    execution,
    estimateRun: () => ok(nanoUSD(100n)),
    clock: { now: () => 1000 },
    rng: { random: () => 0.5 },
    telemetry: makeTelemetry(),
  });
  const handle = executor.start({
    definition: smartModelDefinition(),
    inputs: { prompt: { kind: 'text', text: TURN_PROMPT } },
    hooks: {
      admission: () => Promise.resolve(grant(1_000_000_000n)),
      settlement: (request) => {
        settlements.push(request);
        return Promise.resolve();
      },
    },
    runKey: RUN_KEY,
    emit: (envelope) => {
      events.push(envelope);
    },
  });
  const outcome = await handle.done;
  return { outcome, settlement: settlements[0], events };
}

describe('smart-model turn — factory-resolved classifier + answer', () => {
  let teardown: () => Promise<void>;
  let run: LiveRun;

  beforeAll(async () => {
    // ONE turn = TWO provider calls (classifier + answer). Both tests below
    // read the single captured settlement so the suite crosses the wire once.
    const setup = setupIntegrationProvider();
    teardown = setup.teardown;
    run = await runSmartModelTurn(setup.provider);
  }, RUN_TIMEOUT_MS);

  afterAll(async () => {
    await teardown();
  });

  it('runs the classifier and the chosen-model answer as two billed generations with content', () => {
    // (b) terminal result with content.
    expect(run.outcome).toEqual({ outcome: 'succeeded' });
    const settlement = run.settlement;
    expect(settlement).toBeDefined();
    if (settlement === undefined) return;
    const answer = settlement.outputs['answer'];
    expect(answer?.kind === 'text' ? answer.text.length : 0).toBeGreaterThan(0);

    // (a) TWO calls crossed the wire, as TWO nodes: the classifier under its own
    // TOP-LEVEL key — no suffix, and no content of its own — and the answer under
    // the slot's key. The classifier's line routed the slot to the OTHER
    // candidate, which is the decision path proven end to end.
    const charges = settlement.charges;
    expect(charges).toHaveLength(2);
    const answerCharge = charges.find((c) => c.key === 'answer');
    const classifierCharge = charges.find((c) => c.key === 'classify');
    expect(answerCharge).toBeDefined();
    expect(classifierCharge).toBeDefined();
    expect(classifierCharge?.modelId).toBe(CLASSIFIER_MODEL_ID);
    expect(answerCharge?.modelId).toBe(ANSWER_MODEL_ID);
    // The classifier's value was CONSUMED by the reducer, so it is not a sink:
    // the run's only output is the slot's answer, and the classifier's charge
    // therefore has no content of its own to anchor to.
    expect(Object.keys(settlement.outputs)).toEqual(['answer']);

    // (c) usage/cost captured for BOTH — the gateway's authoritative inline
    // cost, not an estimate, and real per-generation ids.
    if (answerCharge !== undefined) expectBilledTextGeneration(answerCharge);
    if (classifierCharge !== undefined) expectBilledTextGeneration(classifierCharge);

    // (d) OpenRouter evidence is recorded by the factory's evidence wrapper on
    // the first live event — no explicit recordServiceEvidence call here.
  });

  it('charges the answer generation exactly the port conversion of its real inline cost', () => {
    const settlement = run.settlement;
    expect(settlement).toBeDefined();
    if (settlement === undefined) return;

    // The answer generation streams through `emit`, so its terminal finish
    // event carries the raw inline provider cost the gateway reported. The
    // charge must be EXACTLY the port helper's conversion of that figure —
    // the reference is the production seam itself, never a re-typed fee
    // formula (the old basis-point reconstruction was a sync contract).
    const finish = run.events
      .map((envelope) => envelope.event)
      .findLast((event) => event.kind === 'finish');
    expect(finish?.kind).toBe('finish');
    const inlineUsd =
      (finish?.kind === 'finish' ? finish.metadata.providerCostUsd : undefined) ?? 0;
    expect(inlineUsd).toBeGreaterThan(0);

    const answerCharge = settlement.charges.find((charge) => charge.key === 'answer');
    expect(answerCharge?.billableCostNanoUsd).toBe(providerUsdToBillableNanoUsd(inlineUsd));
    // The conversion is the only fee application: billable strictly exceeds
    // the raw nano conversion of the same figure.
    expect(providerUsdToBillableNanoUsd(inlineUsd)).toBeGreaterThan(usdToNanoUsd(inlineUsd));
    const classifierCharge = settlement.charges.find((charge) => charge.key === 'classify');
    // The classifier runs emit-free (invisible to the stream), so its raw
    // inline cost is unobservable here; the port unit pins cover the
    // conversion, and the first test asserts it billed a positive inline cost.
    expect(classifierCharge?.billableCostNanoUsd ?? 0n).toBeGreaterThan(0n);
  });
});
