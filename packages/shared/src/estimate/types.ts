/**
 * The canonical estimator's shared vocabulary: nano-USD line items, the cost
 * manifest, the input-driven request, and the fail-closed result channel.
 *
 * The manifest is the extension point. A new cost source (media, web search, a
 * Smart-Model classifier stage) is ADDED as one or more {@link NanoLineItem}s —
 * the reducers ({@link Manifest} → ceiling / affordability) never change shape.
 * That is why costs are modelled as line items rather than named fields.
 */

import type { Modality } from '../modality.js';

/**
 * One nano-USD cost component, PRE-markup. A line item is either fixed (known
 * before generation) or scales with the output-token count, or both; each is
 * summed into its respective subtotal by the reducers. `marksUp` selects the
 * subtotal the 15% customer markup applies to — provider/model cost and web
 * search mark up; pass-through storage does not.
 */
export interface NanoLineItem {
  /** Human-readable category, for debugging and breakdown display. */
  readonly label: string;
  /** Cost incurred regardless of output length, in nano-USD. */
  readonly fixedNano?: bigint;
  /** Cost per output token, in nano-USD. */
  readonly variableOutputRateNano?: bigint;
  /** Whether the customer markup applies to this item (true = provider cost). */
  readonly marksUp: boolean;
}

/** A request's full cost structure as pre-markup nano-USD line items. */
export interface Manifest {
  readonly items: readonly NanoLineItem[];
}

/**
 * Per-model nano-USD rates the core prices against. Optional because a given
 * modality only populates the rates it uses; a rate the request needs but the
 * model lacks is a fail-closed error, never a silent zero. The media rate keys
 * are declared here so T3 can price image/video without reshaping the request.
 */
export interface ModelRatesNano {
  readonly inputPerToken?: bigint;
  readonly outputPerToken?: bigint;
  readonly perImage?: bigint;
  /** Flat nano-USD/second — the audio (and legacy flat-video) worst-case rate. */
  readonly perSecond?: bigint;
  readonly perSecondByResolution?: Readonly<Record<string, bigint>>;
}

/**
 * Which media rate a call charges against. Flat keys (`perImage`, `perSecond`)
 * resolve a bare `bigint`; `perSecondByResolution` resolves a matrix entry keyed
 * by {@link MediaBillable.dimensionKey}. These mirror the reserved
 * {@link ModelRatesNano} media fields.
 */
export type MediaRateKey = 'perImage' | 'perSecond' | 'perSecondByResolution';

/**
 * A media generation's input-driven pricing descriptor: the catalog rate to
 * charge, the requested units (1 image, or a duration in seconds), and the
 * estimated encrypted output size the caller resolves from the modality byte
 * estimate. `storageBytes` is a caller input — the core never guesses it.
 */
export interface MediaBillable {
  readonly rateKey: MediaRateKey;
  /** Required for `perSecondByResolution` (the resolution); rejected for flat keys. */
  readonly dimensionKey?: string;
  /** Units to charge: 1 image, or the video/audio duration in seconds. */
  readonly units: number;
  /** Estimated encrypted output bytes, for the (never-marked-up) storage item. */
  readonly storageBytes: number;
}

/**
 * The Smart-Model classifier pre-reserve. Input-driven like the rest of the
 * core: the caller stamps the truncated-context token count and char count
 * (via `classifierReserveChars` + the tier token pre-adapter); the output leg is
 * the fixed `CLASSIFIER_OUTPUT_TOKEN_CAP` the core applies.
 */
export interface ClassifierStage {
  readonly pricing: ModelRatesNano;
  readonly inputTokens: bigint;
  readonly inputChars: number;
}

/**
 * The input-driven request the core prices. It carries TOKEN COUNTS, never
 * characters-to-tokens heuristics or tiers — the caller (a client pre-adapter
 * or a server stamp) resolves those first. `inputChars` feeds the input-storage
 * line item; `outputCharsPerToken` (tier-inverted, supplied by the caller)
 * sizes the output-storage rate the core simply multiplies.
 */
export interface BillableRequest {
  /** The selected models (≥1). Input/output rates are summed across them. */
  readonly models: readonly { readonly pricing: ModelRatesNano }[];
  /** Estimated or stamped input tokens. */
  readonly inputTokens: bigint;
  /** Prompt character count, for the input-storage line item. */
  readonly inputChars: number;
  /** Output storage chars-per-token (tier-inverted; from `outputCharsPerTokenForTier`). */
  readonly outputCharsPerToken: number;
  /**
   * The modality to price. Absent ⇒ `text` (the token path). `image`/`video`/
   * `audio` route to the media path; `embedding` is not priceable here and fails
   * closed. Reuses the shared closed modality set — never a second enum.
   */
  readonly modality?: Modality;
  /** Required when `modality` is `image`/`video`/`audio`; the media descriptor. */
  readonly media?: MediaBillable;
  /** Adds the fixed worst-case web-search reservation line item, per model. */
  readonly webSearch?: boolean;
  /** Adds the Smart-Model classifier pre-reserve line items. */
  readonly classifierStage?: ClassifierStage;
}

export type EstimateErrorCode = 'model-pricing-incomplete' | 'invalid-request';

/** A fail-closed pricing failure: a data/input condition, not a thrown defect. */
export interface EstimateError {
  readonly code: EstimateErrorCode;
  readonly detail: string;
}

/**
 * The estimator's typed error channel. Shared has no neverthrow dependency, so
 * pricing returns this discriminated union (the seam the plan writes as
 * `Result<Manifest, DomainError>`); the server maps it to its own `Result` at
 * the boundary.
 */
export type EstimateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EstimateError };

export function estimateOk<T>(value: T): EstimateResult<T> {
  return { ok: true, value };
}

export function estimateErr<T>(code: EstimateErrorCode, detail: string): EstimateResult<T> {
  return { ok: false, error: { code, detail } };
}
