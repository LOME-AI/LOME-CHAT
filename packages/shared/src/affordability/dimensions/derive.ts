/**
 * Everything a dimension author does NOT declare (`docs/BILLING.md` §Derived,
 * never declared). One implementation per derivation, driven off the
 * declaration: the reserve contribution, the prompt section, the answer parser,
 * the failure fallback, per-model resolution, the delivered ceiling, and whether
 * a classifier call is bought.
 *
 * Every function takes the PRESENTED support rather than reading it itself, so
 * the producer can hand these the affordability-filtered set and the classifier
 * is prompted with exactly what it may choose. Nothing here reads a clock, a
 * database or a random source, and nothing here accepts a prompt, a message or
 * a history array.
 */

import { resolveClassifierOutput } from '../smart-model/resolve.js';
import type { DimensionSpec, DimensionSupport, OptionId, ReserveContribution } from './types.js';
import type { PriceableModel } from '../priceable-model.js';

/**
 * The dimension's fixed literal option domain, or `undefined` when the domain is
 * the catalog itself (the model dimension). Where a domain exists it is also the
 * dimension's order — declaration order, ascending — which is what makes an
 * `ordered` dimension's feasible set a downward-closed prefix.
 */
export function optionDomain(spec: DimensionSpec): readonly OptionId[] | undefined {
  const { values } = spec.param;
  if (values === undefined) return undefined;
  return values.map(String);
}

/**
 * What a model offers, plus the guard that keeps the declared domain honest: a
 * `support` implementation cannot invent an option the domain does not contain,
 * because an option outside the domain has no order, no label rule and no
 * `ParamSpec` entry to validate a request against.
 */
export function dimensionSupportFor(spec: DimensionSpec, model: PriceableModel): DimensionSupport {
  const support = spec.support(model);
  const domain = optionDomain(spec);
  if (domain !== undefined) {
    for (const option of support.options) {
      if (!domain.includes(option.optionId)) {
        throw new RangeError(
          `dimension '${spec.id}': model '${model.modelId}' offers '${option.optionId}', which is outside the declared option domain`
        );
      }
    }
  }
  return support;
}

function requireNonEmpty(spec: DimensionSpec, support: DimensionSupport): void {
  if (support.options.length === 0) {
    throw new RangeError(`dimension '${spec.id}' presents no option`);
  }
}

/** Both nano-USD resources: an amount (`money`) and a rate (`moneyPerToken`). */
function isNanoUsdResource(spec: DimensionSpec): boolean {
  return spec.resource === 'money' || spec.resource === 'moneyPerToken';
}

function requirementAsBigint(spec: DimensionSpec, value: bigint | number): bigint {
  if (typeof value !== 'bigint') {
    throw new TypeError(
      `dimension '${spec.id}': a nano-USD requirement must be a bigint, never a number`
    );
  }
  return value;
}

function requirementAsNumber(spec: DimensionSpec, value: bigint | number): number {
  if (typeof value !== 'number') {
    throw new TypeError(`dimension '${spec.id}': a non-money requirement must be a number`);
  }
  return value;
}

function worstMoney(spec: DimensionSpec, model: PriceableModel, support: DimensionSupport): bigint {
  let worst = 0n;
  for (const option of support.options) {
    const amount = requirementAsBigint(spec, spec.requirement(model, option.optionId));
    if (amount > worst) worst = amount;
  }
  return worst;
}

function worstNumber(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport
): number {
  return Math.max(
    0,
    ...support.options.map((option) =>
      requirementAsNumber(spec, spec.requirement(model, option.optionId))
    )
  );
}

/**
 * What an OPEN dimension's worst option costs the hold — derived from `resource`
 * and `costClass` alone, never declared:
 *
 * - `free` / `resource: 'none'` — nothing; the dimension skips affordability.
 * - `partition` — nothing. It redistributes an already-priced pool, so its
 *   marginal money cost is zero. This is the arithmetic side of the re-partition
 *   invariant: were a partition dimension to contribute, the ceiling would move
 *   with the chosen option and the hold would stop covering the worst one.
 * - `additive` — the worst presented option's requirement, in its own resource.
 * - `multiplicative` — the worst presented option's factor, applied by the
 *   producer to the bound it scales.
 *
 * The worst option (not the chosen one) is correct because the hold precedes an
 * open dimension's resolution.
 *
 * A `moneyPerToken` dimension yields a RATE, kinded apart from `money` because
 * it is not an amount and must not reach a hold as one: the amount depends on a
 * ceiling the registry does not have, so the consumer prices `cost(m, tokens)`
 * itself and takes the `MAX` across candidates.
 */
export function reserveContribution(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport
): ReserveContribution {
  if (support.options.length === 0) return { kind: 'none' };
  if (spec.costClass === 'free' || spec.resource === 'none') return { kind: 'none' };
  if (spec.costClass === 'partition') return { kind: 'none' };
  if (spec.costClass === 'multiplicative') {
    return { kind: 'ceilingMultiplier', factor: worstNumber(spec, model, support) };
  }
  if (spec.resource === 'moneyPerToken') {
    return { kind: 'moneyPerToken', nanoUsdPerToken: worstMoney(spec, model, support) };
  }
  if (spec.resource === 'money') {
    return { kind: 'money', nanoUsd: worstMoney(spec, model, support) };
  }
  return { kind: 'completionTokens', tokens: worstNumber(spec, model, support) };
}

/**
 * The completion-token ceiling a run actually delivers, given the ceiling the
 * hold paid for. A dimension that declares `deliversAtHoldCeiling: false` has
 * been priced at its WORST option, so the deliverable ceiling is the held one
 * divided by that worst factor — the same answer whichever option is chosen,
 * which is precisely the consequence the declaration exists to make visible.
 */
export function deliveredCeilingTokens(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport,
  heldCeilingTokens: number
): number {
  if (spec.deliversAtHoldCeiling) return heldCeilingTokens;
  if (support.options.length === 0) return heldCeilingTokens;
  const worst = worstNumber(spec, model, support);
  if (worst <= 1) return heldCeilingTokens;
  return Math.floor(heldCeilingTokens / worst);
}

/**
 * The pool a `partition` dimension redistributes, sized from the worst
 * requirement the MODEL offers — `maxB(m)` for effort. Deliberately read off the
 * model's own support rather than the presented subset: affordability narrows
 * what is presented, and if narrowing moved the pool the ceiling would depend on
 * a runtime choice the hold was placed before.
 */
export function partitionPoolTokens(spec: DimensionSpec, model: PriceableModel): number {
  return worstNumber(spec, model, spec.support(model));
}

/**
 * One partition dimension's split of an already-priced ceiling. `ceilingTokens`
 * is an INPUT returned unchanged — that is the re-partition invariant in code: a
 * partition dimension moves the boundary between reservation and answer and can
 * never enlarge the pool. The chosen option decides only the boundary.
 */
export interface PartitionSplit {
  /** B — what the chosen option reserves out of the ceiling. */
  readonly reservedTokens: number;
  /** H — what is left for the answer. */
  readonly answerTokens: number;
  /** The priced ceiling, unchanged: identical for every presented option. */
  readonly ceilingTokens: number;
}

export function partitionCeiling(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport,
  input: { readonly ceilingTokens: number; readonly chosen: OptionId }
): PartitionSplit {
  requireNonEmpty(spec, support);
  const { ceilingTokens, chosen } = input;
  const reservedTokens = Math.min(
    requirementAsNumber(spec, spec.requirement(model, chosen)),
    ceilingTokens
  );
  return {
    reservedTokens,
    answerTokens: ceilingTokens - reservedTokens,
    ceilingTokens,
  };
}

/**
 * The classifier prompt's section for one dimension: the declared sentence, the
 * presented options by LABEL (never by id — ids appear on the wire and in
 * storage only), and one labelled answer line keyed by the dimension id. The
 * label is what makes the parser dimension-agnostic: adding a dimension adds a
 * line, and cannot break the parsing of the lines already there.
 */
export function renderDimensionSection(spec: DimensionSpec, support: DimensionSupport): string {
  requireNonEmpty(spec, support);
  const labels = support.options.map((option) => option.label).join(' | ');
  return [
    spec.promptDescription,
    `Choose exactly one of: ${labels}`,
    `Answer on its own line as \`${spec.id}: <choice>\``,
  ].join('\n');
}

/**
 * The dimension's own labelled line out of the classifier's answer, or the whole
 * answer when the call classified a single dimension and no label was emitted.
 */
function answerTextFor(spec: DimensionSpec, rawAnswer: string): string {
  for (const line of rawAnswer.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== spec.id) continue;
    return line.slice(separator + 1).trim();
  }
  return rawAnswer.trim();
}

/**
 * Resolve a classifier answer to a PRESENTED option, matching on labels through
 * the same closed-set matcher the model dimension has always used. `undefined`
 * when nothing matches confidently — the caller applies the declared fallback,
 * so an answer naming something outside the presented set can never bind.
 */
export function parseDimensionAnswer(
  spec: DimensionSpec,
  support: DimensionSupport,
  rawAnswer: string
): OptionId | undefined {
  const text = answerTextFor(spec, rawAnswer);
  const matched = resolveClassifierOutput(
    text,
    support.options.map((option) => option.label)
  );
  if (matched === null) return undefined;
  return support.options.find((option) => option.label === matched)?.optionId;
}

/**
 * The declared failure fallback: the cheapest presented option, by requirement
 * with an identifier tiebreak. The tiebreak matters — a plateau collapses
 * several labels onto one requirement, and the pick must not depend on
 * enumeration accident.
 */
export function cheapestPresentedOption(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport
): OptionId {
  const ranked = support.options.map((option) => ({
    optionId: option.optionId,
    // Compared as bigint whatever the resource: a nano-USD requirement is
    // already one, and widening a token count avoids a second comparison path.
    requirement: isNanoUsdResource(spec)
      ? requirementAsBigint(spec, spec.requirement(model, option.optionId))
      : BigInt(requirementAsNumber(spec, spec.requirement(model, option.optionId))),
  }));
  let best = ranked[0];
  if (best === undefined) {
    throw new RangeError(`dimension '${spec.id}' presents no option`);
  }
  for (const candidate of ranked.slice(1)) {
    const cheaper = candidate.requirement < best.requirement;
    const tiedAndEarlier =
      candidate.requirement === best.requirement && candidate.optionId < best.optionId;
    if (cheaper || tiedAndEarlier) best = candidate;
  }
  return best.optionId;
}

/** The classifier's answer resolved against the presented set, or the fallback. */
export function chooseDimensionOption(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport,
  rawAnswer: string
): OptionId {
  return (
    parseDimensionAnswer(spec, support, rawAnswer) ?? cheapestPresentedOption(spec, model, support)
  );
}

/**
 * Whether a classifier call is bought for this dimension: iff the presented set
 * has ≥ 2 DISTINCT RESOLVED requirements. Distinctness is measured on the
 * requirement, not the label, so two labels that clamp to the same budget are
 * one option and buy nothing.
 */
export function classifierIsBought(
  spec: DimensionSpec,
  model: PriceableModel,
  support: DimensionSupport
): boolean {
  const distinct = new Set(
    support.options.map((option) => String(spec.requirement(model, option.optionId)))
  );
  return distinct.size >= 2;
}

/**
 * Per-model resolution of the turn's chosen option, by the DECLARED rule.
 * `undefined` means the model cannot run this dimension at all — the caller
 * sends no fragment for it (and, for an explicit user pick, refuses rather than
 * substituting).
 *
 * Resolution is downward-only. The single upward move is the
 * `lowestOfferedWhenMandatory` carve-out, and only for a model that mandates the
 * dimension: downward is impossible for it, so its lowest offered option is the
 * only reachable answer.
 *
 * It takes no model: every model-dependent fact resolution needs is already in
 * the support (the offered options and `mandatory`), so passing one would invite
 * a second, disagreeing source for the same facts.
 */
export function resolveOption(
  spec: DimensionSpec,
  support: DimensionSupport,
  requested: OptionId
): OptionId | undefined {
  const offered = support.options.map((option) => option.optionId);
  if (offered.includes(requested)) return requested;
  const domain = optionDomain(spec);
  // Ordering comes from the DOMAIN, not from the support's enumeration order:
  // relying on the latter would make resolution depend on how a `support`
  // implementation happens to list its options.
  if (domain === undefined) return undefined;
  const requestedPosition = domain.indexOf(requested);
  const positions = offered
    .map((option) => domain.indexOf(option))
    .filter((position) => position !== -1);
  if (requestedPosition !== -1) {
    const below = positions.filter((position) => position < requestedPosition);
    if (below.length > 0) return domain[Math.max(...below)];
  }
  if (
    spec.resolution === 'lowestOfferedWhenMandatory' &&
    support.mandatory &&
    positions.length > 0
  ) {
    return domain[Math.min(...positions)];
  }
  return undefined;
}
