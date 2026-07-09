import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  computeClassifierPromptOverhead,
} from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { callBaseNanoUsd, estimateRunCeilingNanoUsd } from './estimate.js';
import { isTextModel } from './trial-eligibility.js';
import type { ModelDescriptor } from '@hushbox/shared';

/**
 * The Smart Model candidate list for one paid send: every exposed text model
 * the payer can afford, sorted ascending by combined per-token base price,
 * with the cheapest doubling as the classifier model (and the runtime
 * fallback). Pure over an exposed-catalog snapshot — the route reads the
 * catalog and the wallet balance, this decides.
 *
 * Affordability basis, documented precisely:
 * - `balanceNanoUsd` is the PAYING (purchased) wallet's ledger balance — the
 *   same wallet admission's snapshot gates on.
 * - A candidate is kept iff
 *     balance ≥ classifier worst-case + the candidate's turn ceiling,
 *   where the classifier worst-case is the REAL call's upper bound (the full
 *   truncated-context budget plus the prompt overhead as input at a
 *   conservative 2 chars/token, `CLASSIFIER_OUTPUT_TOKEN_CAP` output, at the
 *   classifier's rates), and the turn ceiling is the estimator's ceiling
 *   class — full context on BOTH legs via `estimateRunCeilingNanoUsd`
 *   (markup applied once per amount, matching what admission compares the
 *   balance against). The classifier reserve is always subtracted, even when
 *   filtering leaves a single candidate (whose run then skips the classifier
 *   and never spends the reserve).
 * - Admission remains the ONLY enforcement gate; this read merely shapes the
 *   list. Admission prices the classifier at its own full-context ceiling
 *   (deliberately coarser), so a balance between the two bases yields a
 *   typed admission refusal rather than a mis-billed run.
 *
 * An unpriceable model (missing per-token rates or context length) is
 * excluded here, so the estimator's fail-closed arm never sees one.
 */

/** Conservative chars-per-token for the classifier-input reserve (overestimate). */
export const CLASSIFIER_CHARS_PER_TOKEN = 2;

export interface SmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The paying (purchased) wallet's balance in nano-USD. */
  readonly balanceNanoUsd: bigint;
}

export interface SmartModelCandidateEntry {
  readonly id: string;
  readonly description?: string;
}

export interface SmartModelCandidates {
  /** The cheapest text candidate — the classifier model and runtime fallback. */
  readonly classifierModelId: string;
  /** Affordable candidates, ascending by combined base price. */
  readonly candidates: readonly SmartModelCandidateEntry[];
  /** The classifier reserve every candidate's affordability was checked against. */
  readonly classifierWorstCaseNanoUsd: bigint;
}

/**
 * A candidate must be a model the engine can RUN as a text turn: text-only
 * output (the trial predicate) AND a single text input — TypeTag v1 derives one
 * port per side, so a multimodal-input model (text+image) fails port
 * derivation and would 400 the whole turn at compile if admitted here.
 * Shared with the trial candidate derivation (same engine, same constraint).
 */
export function isEngineTextModel(descriptor: ModelDescriptor): boolean {
  return (
    isTextModel(descriptor) && descriptor.inputs.length === 1 && descriptor.inputs[0] === 'text'
  );
}

/** input + output per-token base rates — the price candidates sort on. */
function combinedBasePrice(descriptor: ModelDescriptor): bigint {
  const input = descriptor.pricing['inputPerToken'];
  const output = descriptor.pricing['outputPerToken'];
  return (typeof input === 'bigint' ? input : 0n) + (typeof output === 'bigint' ? output : 0n);
}

/** Full-context-both-legs ceiling — the estimator's ceiling class, marked up once. */
function turnCeilingNanoUsd(descriptor: ModelDescriptor): bigint | undefined {
  const contextLength = descriptor.limits['contextLength'];
  if (contextLength === undefined) return undefined;
  const ceiling = estimateRunCeilingNanoUsd(
    descriptor.pricing,
    { kind: 'tokens', inputTokens: contextLength, outputTokens: contextLength },
    { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
  );
  return ceiling.isOk() ? ceiling.value : undefined;
}

/**
 * The classifier call's worst-case BASE (pre-markup) cost: the full
 * truncated-context budget plus the exact prompt overhead (rendered against
 * the FULL text candidate list — an upper bound on what the classifier
 * actually sees once affordability shrinks the list) as input, the output
 * token cap as output, at the classifier's rates. Shared with the trial
 * derivation, whose 1¢ cap compares base cost; the paid filter marks it up
 * below because it gates a customer-facing wallet balance.
 */
export function classifierWorstCaseBaseNanoUsd(
  classifier: ModelDescriptor,
  textCatalog: readonly ModelDescriptor[]
): bigint | undefined {
  const overheadChars = computeClassifierPromptOverhead(
    textCatalog.map((descriptor) => ({
      id: descriptor.id,
      description: descriptor.description ?? '',
    }))
  );
  const inputTokens = Math.ceil(
    (MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars) / CLASSIFIER_CHARS_PER_TOKEN
  );
  const base = callBaseNanoUsd(classifier.pricing, {
    kind: 'tokens',
    inputTokens,
    outputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP,
  });
  return base.isOk() ? base.value : undefined;
}

/** The paid filter's classifier reserve: the worst case, customer-priced. */
function classifierWorstCaseNanoUsd(
  classifier: ModelDescriptor,
  textCatalog: readonly ModelDescriptor[]
): bigint | undefined {
  const base = classifierWorstCaseBaseNanoUsd(classifier, textCatalog);
  return base === undefined ? undefined : applyMarkup(base);
}

export function ascendingByPrice(a: ModelDescriptor, b: ModelDescriptor): number {
  const left = combinedBasePrice(a);
  const right = combinedBasePrice(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function candidateEntry(descriptor: ModelDescriptor): SmartModelCandidateEntry {
  return {
    id: descriptor.id,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  };
}

export function buildSmartModelCandidates(
  input: SmartModelCandidatesInput
): SmartModelCandidates | null {
  const sortedText = input.descriptors
    .filter((descriptor) => isEngineTextModel(descriptor))
    .toSorted(ascendingByPrice);
  const classifier = sortedText[0];
  if (classifier === undefined) return null;

  const reserve = classifierWorstCaseNanoUsd(classifier, sortedText);
  if (reserve === undefined) return null;

  const affordable = sortedText.filter((descriptor) => {
    const ceiling = turnCeilingNanoUsd(descriptor);
    if (ceiling === undefined) return false;
    return input.balanceNanoUsd >= reserve + ceiling;
  });
  if (affordable.length === 0) return null;

  return {
    classifierModelId: classifier.id,
    candidates: affordable.map((descriptor) => candidateEntry(descriptor)),
    classifierWorstCaseNanoUsd: reserve,
  };
}
