/**
 * The shapes the one producer consumes and returns (`docs/BILLING.md` §Data
 * Structures). They are chosen so that illegal states cannot be represented;
 * where a type cannot carry a property, a named executable pin carries it
 * instead.
 *
 * Everything here is counts, rates and identifiers. No shape carries a prompt,
 * a message or a history array, which is what keeps content out of the money
 * layer by type rather than by discipline.
 */

import type { DimensionId, OptionId, OptionLabel } from './dimensions/index.js';
import type { ModelId } from './model-id.js';
import type { PriceableModel } from './priceable-model.js';
import type { Modality } from './modality.js';
import type { NanoUSD } from './nano-usd.js';
import type { UserTier } from './tiers.js';

/**
 * A list that cannot be empty. Used where emptiness would be a representable
 * lie — `runnable` on a sendable option set, the option list of a presented
 * dimension.
 */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * Money only: one value per payer, cacheable, invalidated by run frames and
 * window focus. Both funding numbers the producer needs are derivable from it —
 * `spendable` is served directly and `effectiveBalance = spendable + held` — so
 * no second request and no additional served field exist for this (§Funding).
 */
export interface FundingSnapshot {
  readonly spendableNanoUsd: NanoUSD;
  readonly heldNanoUsd: NanoUSD;
  /**
   * The PAYER's tier, never the sender's. The name carries the distinction
   * because a link guest's two tiers differ — `guest` answers who is sending,
   * this answers what funds the turn — and a composer holding both under one
   * name will eventually cross them (§User Tiers).
   */
  readonly payerTier: UserTier;
  /**
   * Structural, not funding-derived: a link guest's payer is the conversation's
   * owner whether or not the owner's funds cover. Zero spendable is not a third
   * kind of payer, which is why this union stays closed at two.
   */
  readonly payer: 'self' | 'owner';
}

/**
 * Counts only. This type is why no content can cross into the money layer:
 * components, never a total plus its parts, so a history count larger than the
 * whole prompt is unrepresentable — `promptChars` is derived by
 * {@link promptCharsOf}.
 */
export interface PromptBasis {
  readonly systemChars: number;
  readonly instructionChars: number;
  readonly historyChars: number;
  readonly inputChars: number;
  readonly attachmentBytes: number;
}

/**
 * `promptChars` = system + instructions + history + new input. Attachment bytes
 * are deliberately excluded: they are bytes of media, not characters of prompt,
 * and they price through the media storage rate rather than the character rate.
 */
export function promptCharsOf(basis: PromptBasis): number {
  return basis.systemChars + basis.instructionChars + basis.historyChars + basis.inputChars;
}

/**
 * The zero-length prompt basis the `affordable` set is evaluated against. The
 * producer substitutes it itself, so no caller can obtain a prompt-dependent
 * floor (§Affordability §Scope, §Affordability 2).
 */
export const EMPTY_PROMPT_BASIS: PromptBasis = {
  systemChars: 0,
  instructionChars: 0,
  historyChars: 0,
  inputChars: 0,
  attachmentBytes: 0,
};

/**
 * The priceable catalog pool as of an instant.
 *
 * The instant rides WITH the pool rather than as its own argument because both of
 * premium classification's legs are properties of this pair — the price percentile
 * is taken over the pool, the recency window is measured from the instant — and
 * because the money layer holds no clock of its own (§Model Classification,
 * §Affordability: "nothing in it reads a clock, a database, or a random source").
 *
 * `nowMs` is validated where the snapshot enters the module rather than trusted:
 * a clock a caller got wrong changes premium classification, which is a money
 * verdict, so an unusable instant is refused at the boundary the same way an empty
 * identifier is.
 */
export interface CatalogSnapshot {
  readonly models: readonly PriceableModel[];
  readonly nowMs: number;
}

/**
 * Where the turn's answers come from. At least one answer source is required,
 * so an empty turn is unrepresentable: either the pinned model list is
 * non-empty, or the smart slot is on.
 */
export type AnswerSources =
  | { readonly models: NonEmpty<ModelId>; readonly smartSlot: boolean }
  | { readonly models: readonly ModelId[]; readonly smartSlot: true };

/**
 * What the user has fixed. `pinned` names one option per registered dimension;
 * a dimension absent from it is open (the classifier chooses).
 *
 * `webSearch` is a turn-level additive toggle rather than a `pinned` entry
 * because web search is not yet a registered dimension — §The Dimension
 * Framework lists it as one, and when it becomes one this field collapses into
 * `pinned`. It is stated as its own field rather than hidden in a context
 * argument because it is something the USER fixed, and this is the type that
 * carries those.
 */
export interface Selection {
  readonly answerSources: AnswerSources;
  readonly modality: Modality;
  readonly pinned: Readonly<Partial<Record<DimensionId, OptionId>>>;
  readonly webSearch: boolean;
}

/**
 * Every reason a model, an option or a whole turn can be unavailable. Typed,
 * because copy is derived from the reason in one place: a condition cannot
 * acquire a second phrasing by being explained on a second surface (§Notices &
 * Refusals 1).
 *
 * Ordered by the precedence §Notices & Refusals 4 fixes: more than one term of
 * `min(providerCap, contextHeadroom, budgetBuys)` routinely binds at once, and
 * the rule is money first, then length. {@link refusalPrecedence} reads this
 * order, so the order here is behaviour, not documentation.
 *
 * Two axes live here. The FEASIBILITY axis — the four codes from
 * `insufficient_funds` down — is decided by the turn arithmetic and produced by
 * it. The TIER axis (the three codes above it) is decided by facts the
 * arithmetic cannot see: premium classification needs a pool percentile and a
 * release clock, and neither reaches a `PriceableModel`. They are declared here
 * so that a premium or trial-capped row is MARKED with a typed reason rather
 * than removed, and so that one condition still has exactly one wording — the
 * copy layer reads this enum, not a parallel string set.
 */
export const REFUSAL_CODES = [
  /**
   * The model is premium and the payer has no account to hold premium access.
   * Ahead of the money and length reasons because it is unconditional: no
   * balance and no shorter prompt unlocks the model at this tier, so a money
   * notice would name an action that cannot help (§Notices & Refusals 3).
   */
  'premium_requires_account',
  /** The model is premium and the signed-in payer's tier has no premium access. */
  'premium_requires_credit',
  /** A trial turn on this model would exceed the trial per-message cost cap. */
  'trial_message_cap_exceeded',
  /** The funding cannot cover a minimum answer at all. */
  'insufficient_funds',
  /** The funding could, but the prompt leaves no room for a minimum answer. */
  'prompt_too_long',
  /** The model physically cannot emit a minimum answer at its cheapest configuration. */
  'model_output_cap_too_low',
  /** The model does not offer the pinned option, and nothing below it either. */
  'option_not_offered',
  /** No priceable model backs the selection. */
  'model_not_priceable',
  /** The modality is priced per unit, which the token ceiling cannot express. */
  'modality_not_priceable',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * The order a turn-level refusal is resolved in when several model-level
 * reasons are present: the first code of {@link REFUSAL_CODES} that appears
 * wins, so one condition yields one notice, always the same one. Total — an
 * empty reason list means nothing priceable backed the selection.
 */
export function refusalPrecedence(reasons: readonly RefusalCode[]): RefusalCode {
  return REFUSAL_CODES.find((code) => reasons.includes(code)) ?? 'model_not_priceable';
}

/** Availability always carries its reason, so a surface cannot grey silently. */
export type Availability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: RefusalCode };

/** One option of one dimension, marked rather than filtered. */
export interface OptionAvailability {
  readonly optionId: OptionId;
  readonly label: OptionLabel;
  readonly availability: Availability;
}

/**
 * One dimension's option list. Never filtered: an unavailable option is present
 * and marked, so hiding an affordable option requires deleting a field rather
 * than forgetting a branch.
 */
export interface DimensionAvailability {
  readonly dimensionId: DimensionId;
  readonly options: NonEmpty<OptionAvailability>;
}

/** What both kinds of row carry: which model, its verdict, and its ceiling. */
interface ModelEntryBase {
  readonly modelId: ModelId;
  readonly availability: Availability;
  /** `ceiling(m)` — `min(providerCap, contextHeadroom, budgetBuys)`, in tokens. */
  readonly ceilingTokens: number;
}

/**
 * A row for a model the {@link Selection} named in `answerSources.models` — a
 * sibling that is already chosen, including one the catalog cannot price.
 *
 * It carries **no per-dimension option list**, and that absence is the rule
 * rather than an omission. A pinned sibling's own-fit verdict per option is
 * deliberately FINER than the turn's: it can hold an option that
 * `turnDimensions` on the {@link OptionSet} greys, because a *different* sibling
 * cannot honour it. Nothing may decide from that — an effort control reads
 * `turnDimensions`, which ANDs over the pinned siblings inside an OR over the
 * arrangements the turn could become — so the shape does not publish it, and
 * consuming it is a compile error rather than a documented mistake.
 *
 * What the row owes instead is the diagnosis §Story 1.3 asks for: `availability`
 * names which sibling is the problem, and carries the reason it is.
 */
export interface PinnedModelEntry extends ModelEntryBase {
  readonly kind: 'pinned';
}

/**
 * A row for a catalog model the selection did not pin — what may fill a smart
 * slot, and what a model picker greys from. This is the decision-bearing kind.
 *
 * It is graded against the whole arrangement it would create, the pinned siblings
 * plus itself, so its {@link dimensions} are already capped by the tightest
 * pinned sibling — the per-candidate effort ceiling of §Story 2.2, which is what a
 * classifier answer clamps onto.
 */
export interface CandidateModelEntry extends ModelEntryBase {
  readonly kind: 'candidate';
  /**
   * Per-dimension options for THIS model, each carrying its own verdict. No claim
   * is made about combinations across dimensions: an option is presented iff the
   * arrangement this row describes can honour it.
   */
  readonly dimensions: readonly DimensionAvailability[];
}

/**
 * One rendered row. The two kinds answer different questions and only one is
 * decision-bearing, so they are separate shapes rather than one shape plus a rule
 * about when to read which field.
 */
export type ModelEntry = PinnedModelEntry | CandidateModelEntry;

/**
 * A discriminated union on whether the turn can start. `runnable` is exclusive
 * to the sendable arm and is a `NonEmpty` there, so "sendable with nothing
 * runnable" is unrepresentable.
 *
 * `all` and `turnDimensions` are on BOTH arms, because a refused turn is exactly
 * the turn whose greying needs explaining: a zero-balance payer's picker must
 * render one row per model with a reason on each (notion 1 exists to grey them,
 * and the product rule is grey, never hide). An unsendable set carrying no
 * entries would leave that surface with nothing to draw.
 */
export type OptionSet =
  | {
      readonly sendable: false;
      readonly refusal: RefusalCode;
      readonly all: readonly ModelEntry[];
      readonly turnDimensions: readonly DimensionAvailability[];
    }
  | {
      readonly sendable: true;
      readonly runnable: NonEmpty<ModelEntry>;
      readonly all: readonly ModelEntry[];
      readonly turnDimensions: readonly DimensionAvailability[];
    };

/**
 * The pair every surface reads, produced together so they cannot disagree.
 *
 * `holdNanoUsd` lives here rather than on an {@link OptionSet} because a hold is
 * only ever taken against `spendable`: an affordable-side hold is a value with
 * no meaning, and this placement makes it unrepresentable rather than merely
 * discouraged.
 */
export interface TurnOptions {
  /** From (effectiveBalance, empty basis). Drives ALL greying. Hold-blind, keystroke-stable. */
  readonly affordable: OptionSet;
  /** From (spendable, the composed basis). Drives the send gate and the classifier's options. */
  readonly admissible: OptionSet;
  /** The hold this turn would place. Present only when `admissible.sendable`. */
  readonly holdNanoUsd: NanoUSD | undefined;
}
