/**
 * The turn-level classifier seam: what the classifier is SHOWN, what its answer
 * BECOMES, and the fragment a choice turns into on the wire
 * (`docs/BILLING.md` §The public surface).
 *
 * All three read the produced {@link OptionSet} and nothing else, which is the
 * property they exist for: the classifier cannot be shown an option the producer
 * did not present, and cannot return one it was not shown (§Reasoning Effort 6,
 * 8). The per-dimension machinery underneath — the section renderer, the answer
 * matcher, each dimension's declared `wire` — stays in the dimension registry;
 * these compose it at turn granularity, so a dimension added to the registry
 * appears in the prompt, in the parse and on the wire with no edit here.
 *
 * Two orderings are load-bearing, and both are pinned by this directory's tests
 * rather than asserted here: candidate rows arrive in the producer's total order
 * on turn cost (§Smart Model 1), and an ordered dimension's options arrive
 * ascending by requirement (§Ordering) — so in both cases the FIRST presented
 * entry is the cheapest presented one, which is the declared fallback.
 */

import { dimensionOptionNamedBy, renderDimensionSection } from './dimensions/derive.js';
import { MODEL_DIMENSION } from './dimensions/model.js';
import { dimensionFor } from './dimensions/registry.js';
import type { DimensionId, DimensionOption, OptionId, ProviderParams } from './dimensions/index.js';
import type { ModelId } from './model-id.js';
import type { PriceableModel } from './priceable-model.js';
import type { CandidateModelEntry, DimensionAvailability, OptionSet } from './turn-types.js';

/**
 * One resolved classifier answer.
 *
 * `modelId` is absent exactly when the set presented no runnable candidate row —
 * there was nothing to resolve against. It is NOT a statement that the turn opened
 * the model axis: `OptionSet` carries candidate rows for the picker as well as for
 * a smart slot and does not distinguish the two populations, so whether a model
 * axis was classified at all is the executor's fact, not this value's. A consumer
 * that pinned its model ignores this field.
 *
 * The model axis lives in this field alone and never also in `dimensions`, so one
 * choice has one home.
 */
export interface ChosenOptions {
  readonly modelId: ModelId | undefined;
  readonly dimensions: Readonly<Partial<Record<DimensionId, OptionId>>>;
}

/** The candidate rows the classifier was shown: present, and available. */
function presentedCandidates(options: OptionSet): readonly CandidateModelEntry[] {
  return options.all.filter(
    (entry): entry is CandidateModelEntry =>
      entry.kind === 'candidate' && entry.availability.available
  );
}

/** The options of one axis that were shown: present, and available. */
function presentedOptions(availability: DimensionAvailability): readonly DimensionOption[] {
  return availability.options
    .filter((option) => option.availability.available)
    .map(({ optionId, label }) => ({ optionId, label }));
}

/**
 * Resolve a classifier answer against the set it was shown. TOTAL: every answer,
 * including an empty or unparseable one, yields a choice the set contains,
 * because the declared fallback is the cheapest presented option and options with
 * no feasible configuration were excluded before presentation (§Reasoning Effort
 * 8). There is therefore no repair search, and no failure arm for a caller to get
 * wrong.
 */
export function chooseFrom(options: OptionSet, rawAnswer: string): ChosenOptions {
  const dimensions: Partial<Record<DimensionId, OptionId>> = {};
  // `turnDimensions` carries the axes that present RUNGS; the model axis is
  // carried by the candidate rows, and is resolved into `modelId` below against
  // the ceilings those rows carry. So one choice never has two representations
  // here to disagree with each other.
  for (const availability of options.turnDimensions) {
    const presented = presentedOptions(availability);
    const cheapest = presented[0];
    if (cheapest === undefined) continue;
    const spec = dimensionFor(availability.dimensionId);
    dimensions[availability.dimensionId] =
      dimensionOptionNamedBy(spec, presented, rawAnswer) ?? cheapest.optionId;
  }
  return { modelId: chosenModel(presentedCandidates(options), rawAnswer), dimensions };
}

/**
 * The model axis, read exactly like every other dimension: by its own labelled
 * line, against the ids that were presented, through the registry's declared
 * matching rule for a catalog domain.
 */
function chosenModel(
  candidates: readonly CandidateModelEntry[],
  rawAnswer: string
): ModelId | undefined {
  const cheapest = candidates[0];
  if (cheapest === undefined) return undefined;
  const presented = candidates.map((candidate) => ({
    optionId: candidate.modelId,
    label: candidate.modelId,
  }));
  const named = dimensionOptionNamedBy(MODEL_DIMENSION, presented, rawAnswer);
  return candidates.find((candidate) => candidate.modelId === named)?.modelId ?? cheapest.modelId;
}

/**
 * The classifier prompt's option section, rendered from the produced set — so
 * what is presented and what is prompted cannot diverge (§Reasoning Effort 6).
 *
 * Identifiers and labels only: no catalog free text crosses into this layer. Each
 * candidate carries its own ceiling rather than the cross-product of candidates
 * and options, which §Story 2 shows would hide most of what the payer can afford.
 */
export function renderOptions(options: OptionSet): string {
  const sections = options.turnDimensions
    .map((availability) => ({ availability, presented: presentedOptions(availability) }))
    .filter(({ presented }) => presented.length > 0)
    .map(({ availability, presented }) =>
      renderDimensionSection(dimensionFor(availability.dimensionId), presented)
    );
  const candidates = presentedCandidates(options);
  if (candidates.length === 0) return sections.join('\n\n');
  return [
    ...sections,
    `Available models:\n${candidates.map((candidate) => candidateLine(candidate)).join('\n')}`,
  ].join('\n\n');
}

/**
 * One candidate, annotated with the highest option it may run — a lossless
 * representation for an ordered dimension, because the feasible set is a
 * downward-closed prefix (§Ordering).
 */
function candidateLine(candidate: CandidateModelEntry): string {
  const ceilings = candidate.dimensions
    .map((availability) => presentedOptions(availability).at(-1)?.label)
    .filter((label): label is string => label !== undefined);
  return ceilings.length === 0
    ? `- ${candidate.modelId}`
    : `- ${candidate.modelId} — up to ${ceilings.join(', ')}`;
}

/**
 * The provider parameters a resolved choice becomes — the only constructor of
 * them. Each dimension's own declared `wire` produces its fragment, so a
 * parameter name appears once in the system: in the registry entry that owns it.
 *
 * A model that does not offer a chosen option contributes no fragment for that
 * axis: `wire` is asked only about an option the model actually offers, so an
 * unoffered choice cannot reach the provider as an invented parameter. The model
 * fragment appears only when the choice names the model being wired, which is
 * what keeps a sibling from being sent another sibling's identifier.
 */
export function wireFor(chosen: ChosenOptions, model: PriceableModel): ProviderParams {
  let params: ProviderParams =
    chosen.modelId === model.modelId ? MODEL_DIMENSION.wire(model, model.modelId) : {};
  for (const [dimensionId, option] of Object.entries(chosen.dimensions)) {
    const spec = dimensionFor(dimensionId as DimensionId);
    if (!spec.support(model).options.some((offered) => offered.optionId === option)) continue;
    params = { ...params, ...spec.wire(model, option) };
  }
  return params;
}
