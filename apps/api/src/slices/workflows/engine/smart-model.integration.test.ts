import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PolicyHooks, TOTAL_FEE_RATE, nanoUSD, textTag } from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { ok } from '../../../lib/result/index.js';
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
import type { ModelDescriptor, SettlementRequest, WorkflowDefinition } from '@hushbox/shared';
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
  resolveValuePorts: () => ({ in: [textTag()], out: textTag() }),
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

/** One smartModel node: cheapest candidate classifies, routes among two. */
function smartModelDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const smart = smartModel({
    id: 'answer',
    classifierModelId: CLASSIFIER_MODEL_ID,
    candidates: [
      { id: CLASSIFIER_MODEL_ID, description: 'A small, fast, cheap general model.' },
      { id: ANSWER_MODEL_ID, description: 'A larger, more capable general model.' },
    ],
    in: inputs.ports.prompt,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [smart],
    registries,
  })._unsafeUnwrap().definition;
}

interface LiveRun {
  readonly outcome: { readonly outcome: string };
  readonly settlement: SettlementRequest | undefined;
}

/**
 * Asserts a single settlement charge carries the gateway's authoritative
 * inline cost (never an estimate), a real generation id, and token usage.
 */
function expectBilledTextGeneration(charge: SettlementRequest['charges'][number]): void {
  expect(charge.modality).toBe('text');
  expect(charge.baseCostNanoUsd).toBeGreaterThan(0n);
  expect(charge.isEstimated).toBe(false);
  expect(charge.generationId?.length ?? 0).toBeGreaterThan(0);
  expect(charge.tokens?.outputTokens ?? 0).toBeGreaterThan(0);
}

async function runSmartModelTurn(provider: ModelProvider): Promise<LiveRun> {
  const settlements: SettlementRequest[] = [];
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
    inputs: { prompt: { kind: 'text', text: 'Reply with a single short word.' } },
    hooks: {
      admission: () => Promise.resolve(grant(1_000_000_000n)),
      settlement: (request) => {
        settlements.push(request);
        return Promise.resolve();
      },
    },
    runKey: RUN_KEY,
    emit: () => {},
  });
  const outcome = await handle.done;
  return { outcome, settlement: settlements[0] };
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

    // (a) TWO calls crossed the wire — the answer charge plus the classifier's
    // `<node>#classifier` auxiliary charge. Two candidates force the classifier
    // to run; its charge stands whether or not its routing output resolved.
    const charges = settlement.charges;
    expect(charges).toHaveLength(2);
    const answerCharge = charges.find((c) => c.key === 'answer');
    const classifierCharge = charges.find((c) => c.key === 'answer#classifier');
    expect(answerCharge).toBeDefined();
    expect(classifierCharge).toBeDefined();
    expect(classifierCharge?.modelId).toBe(CLASSIFIER_MODEL_ID);

    // (c) usage/cost captured for BOTH — the gateway's authoritative inline
    // cost, not an estimate, and real per-generation ids.
    if (answerCharge !== undefined) expectBilledTextGeneration(answerCharge);
    if (classifierCharge !== undefined) expectBilledTextGeneration(classifierCharge);

    // (d) OpenRouter evidence is recorded by the factory's evidence wrapper on
    // the first live event — no explicit recordServiceEvidence call here.
  });

  it("applies the markup fee to each generation's real inline cost (cost × (1 + fee rate))", () => {
    const settlement = run.settlement;
    expect(settlement).toBeDefined();
    if (settlement === undefined) return;

    for (const charge of settlement.charges) {
      const base = charge.baseCostNanoUsd;
      const marked = applyMarkup(base);
      // Message cost is strictly greater than the base provider cost (> 0).
      expect(marked).toBeGreaterThan(base);
      expect(marked).toBeGreaterThan(0n);
      // applyMarkup == cost × (1 + TOTAL_FEE_RATE), within half-even rounding
      // (≤ 0.5 nano absolute). Mirror the markup rule in bigint nano-USD — the
      // fee rate expressed in basis points exactly as money.ts derives
      // MARKUP_BASIS_POINTS from the shared TOTAL_FEE_RATE — and divide truncating.
      // Truncation differs from applyMarkup's half-even rounding by at most 1 nano,
      // so an absolute ≤ 1-nano bound holds at every cost magnitude while still
      // catching any real divergence in the markup rule (float relative error,
      // which the removed check used, exceeded 1e-6 for realistic small costs).
      const basis = 10_000n;
      const markupBasisPoints = BigInt(Math.round(TOTAL_FEE_RATE * 10_000));
      const reference = (base * (basis + markupBasisPoints)) / basis;
      const delta = marked > reference ? marked - reference : reference - marked;
      expect(delta).toBeLessThanOrEqual(1n);
    }
  });
});
