import { match } from 'ts-pattern';
import { ERROR_CODES, MAX_SEARCH_TOOL_CALLS, SEARCH_COST_PER_CALL } from '@hushbox/shared';
import { applyMarkup, usdToNanoUsd } from '../../billing/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type { CallShapeFamily, Pricing, Usage } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The worst-case pre-flight web-search reservation for ONE model call that
 * enabled the search tool: `MAX_SEARCH_TOOL_CALLS` invocations at the
 * conservative per-call rate, marked up once — the nano-USD bigint analogue of
 * legacy `worstCaseSearchCost()` (`applyFees(MAX_SEARCH_TOOL_CALLS ×
 * SEARCH_COST_PER_CALL)`). Search cost is a provider cost (not pass-through
 * storage), so it takes the markup like any inference charge. The run's
 * admission ceiling adds this on top of a web-search node's token ceiling so a
 * turn that cannot afford the worst-case search spend is refused up front,
 * rather than admitted and killed mid-run by the cost circuit. Settlement bills
 * the provider's actual search cost (folded into `usage.cost`), never this
 * reservation. Single-sourced from the shared search constants.
 */
export const WORST_CASE_SEARCH_RESERVATION_NANO_USD: bigint = applyMarkup(
  BigInt(MAX_SEARCH_TOOL_CALLS) * usdToNanoUsd(SEARCH_COST_PER_CALL)
);

/**
 * Estimate computation — catalog rates are its ONLY price source. Estimates
 * feed admission holds and the settlement's `isEstimated` charge; the
 * authoritative charged cost lives in billing's settlement flow and is never
 * consulted here. A rate the usage needs but the pricing lacks is a
 * validation error, never a silent zero. Markup is
 * billing's `applyMarkup`, applied exactly once per returned amount.
 */

export type CallUsage =
  | { readonly kind: 'tokens'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly kind: 'media';
      /** The pricing entry to charge against (e.g. `perImage`, `perSecond`). */
      readonly rateKey: string;
      /** Required when the rate is a per-size/per-resolution matrix. */
      readonly dimensionKey?: string;
      readonly units: number;
    };

/** The declared ceiling admission prices: max width × steps × iterations. */
export interface DeclaredCeiling {
  readonly maxFanOutWidth: number;
  readonly maxSteps: number;
  readonly maxIterations: number;
}

function countToBigInt(value: number, label: string): Result<bigint, DomainError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return err(validationError(`Estimate ${label} must be a non-negative integer`));
  }
  return ok(BigInt(value));
}

function rateFor(pricing: Pricing, rateKey: string): Result<bigint, DomainError> {
  const rate = pricing[rateKey];
  if (typeof rate !== 'bigint') {
    return err(validationError(`Model pricing has no per-token rate '${rateKey}'`));
  }
  return ok(rate);
}

function tokenBase(
  pricing: Pricing,
  usage: Extract<CallUsage, { kind: 'tokens' }>
): Result<bigint, DomainError> {
  return Result.combine([
    rateFor(pricing, 'inputPerToken'),
    rateFor(pricing, 'outputPerToken'),
    countToBigInt(usage.inputTokens, 'inputTokens'),
    countToBigInt(usage.outputTokens, 'outputTokens'),
  ]).map(([inputRate, outputRate, input, output]) => input * inputRate + output * outputRate);
}

function mediaRate(
  pricing: Pricing,
  usage: Extract<CallUsage, { kind: 'media' }>
): Result<bigint, DomainError> {
  const rate = pricing[usage.rateKey];
  if (rate === undefined) {
    return err(validationError(`Model pricing has no rate '${usage.rateKey}'`));
  }
  if (typeof rate === 'bigint') {
    if (usage.dimensionKey !== undefined) {
      return err(validationError(`Rate '${usage.rateKey}' is flat; no dimension key applies`));
    }
    return ok(rate);
  }
  if (usage.dimensionKey === undefined) {
    return err(validationError(`Rate '${usage.rateKey}' is a matrix; a dimension key is required`));
  }
  // Own-property guard: the matrix is a plain object, so a caller-supplied key
  // like '__proto__' or 'constructor' would otherwise resolve an inherited
  // member past the miss check and crash the bigint math downstream.
  const dimensionRate = Object.prototype.hasOwnProperty.call(rate, usage.dimensionKey)
    ? rate[usage.dimensionKey]
    : undefined;
  if (typeof dimensionRate !== 'bigint') {
    return err(validationError(`Rate '${usage.rateKey}' has no dimension '${usage.dimensionKey}'`));
  }
  return ok(dimensionRate);
}

function mediaBase(
  pricing: Pricing,
  usage: Extract<CallUsage, { kind: 'media' }>
): Result<bigint, DomainError> {
  if (!Number.isSafeInteger(usage.units) || usage.units < 1) {
    return err(validationError('Estimate media units must be a positive integer'));
  }
  return mediaRate(pricing, usage).map((rate) => rate * BigInt(usage.units));
}

/**
 * One call's BASE (pre-markup) cost from catalog rates — tokens or media units.
 * Settlement charges the base and applies billing's 15% markup exactly once,
 * downstream in `chargeWithinTx`; `estimateCallNanoUsd` and the run-ceiling
 * estimate wrap this with `applyMarkup` for their customer-facing amounts.
 */
export function callBaseNanoUsd(pricing: Pricing, usage: CallUsage): Result<bigint, DomainError> {
  return match(usage)
    .with({ kind: 'tokens' }, (tokens) => tokenBase(pricing, tokens))
    .with({ kind: 'media' }, (media) => mediaBase(pricing, media))
    .exhaustive();
}

/** Descriptor pricing key for image models: flat nano-USD per output image. */
const IMAGE_RATE_KEY = 'perImage';

/** Descriptor pricing key for video models: nano-USD/second matrix by resolution. */
const VIDEO_RATE_KEY = 'perSecondByResolution';

/**
 * Deterministic media pricing inputs from a call's request parameters. Image
 * and video prices are computable up front (catalog rate × requested units),
 * so the SAME derivation feeds the admission ceiling and the settlement
 * charge. Fail-closed: a missing/invalid parameter or a non-media family is a
 * validation error — an unpriceable media call must refuse before any
 * provider spend, never fail after it.
 */
export function mediaCallUsageFor(
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<CallUsage, DomainError> {
  if (family === 'image') return imageCallUsage(params);
  if (family === 'video') return videoCallUsage(params);
  return err(validationError('Deterministic media pricing applies only to image/video calls'));
}

/**
 * One generation call produces exactly one artifact (founder ruling). A
 * multi-artifact request (`n > 1`) is refused fail-closed: admission would
 * under-reserve by n× and the node accumulator persists a single artifact, so
 * pricing n would bill artifacts the run never keeps.
 */
function requireSingleArtifact(params: Record<string, unknown>): Result<void, DomainError> {
  const n = params['n'] ?? 1;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    return err(validationError("Media call parameter 'n' must be a positive integer"));
  }
  if (n > 1) {
    return err(
      validationError("Media call parameter 'n' must be 1: one generation call, one artifact")
    );
  }
  return ok();
}

function imageCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  return requireSingleArtifact(params).map(() => ({
    kind: 'media' as const,
    rateKey: IMAGE_RATE_KEY,
    units: 1,
  }));
}

function videoCallUsage(params: Record<string, unknown>): Result<CallUsage, DomainError> {
  const singleArtifact = requireSingleArtifact(params);
  if (singleArtifact.isErr()) return err(singleArtifact.error);
  const resolution = params['resolution'];
  if (typeof resolution !== 'string' || resolution.length === 0) {
    return err(
      validationError(
        "Video call requires a 'resolution' parameter to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_RESOLUTION
      )
    );
  }
  const durationSeconds = params['durationSeconds'];
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isSafeInteger(durationSeconds) ||
    durationSeconds < 1
  ) {
    return err(
      validationError(
        "Video call requires a positive integer 'durationSeconds' to price",
        undefined,
        ERROR_CODES.UNSUPPORTED_DURATION
      )
    );
  }
  return ok({
    kind: 'media',
    rateKey: VIDEO_RATE_KEY,
    dimensionKey: resolution,
    units: durationSeconds,
  });
}

/**
 * A media call's BASE (pre-markup) deterministic price from catalog rates and
 * request parameters. Exact by construction for image (charged as-is at
 * settlement); for video it is the admission ceiling, the
 * pathological-missing-cost fallback, and the inline-cost sanity bound. A
 * resolution absent from the pricing matrix fails closed inside the rate
 * lookup.
 */
export function priceMediaBaseNanoUsd(
  pricing: Pricing,
  family: CallShapeFamily | undefined,
  params: Record<string, unknown>
): Result<bigint, DomainError> {
  return mediaCallUsageFor(family, params).andThen((usage) => callBaseNanoUsd(pricing, usage));
}

/**
 * Adapts observed inference `Usage` to the token-priced `CallUsage` the base
 * pricer takes. `reasoningTokens` is a SUBSET of `outputTokens` — the provider
 * reports completion tokens (text + reasoning) as the output total and the
 * reasoning count as a breakdown of it — so pricing `outputTokens` at the
 * output rate already bills reasoning; adding it again would double-count.
 * `cachedInputTokens` is likewise a subset of `inputTokens` already counted at
 * the full input rate (the catalog has no cache rate), so it is left alone: a
 * conservative over-estimate, never an under-charge.
 */
function callUsageFromUsage(usage: Usage): CallUsage {
  return {
    kind: 'tokens',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

/**
 * One call's BASE (pre-markup) estimate from observed `Usage` — the amount a
 * model binding's `price` returns. The 15% markup lands exactly once downstream
 * in settlement's `chargeWithinTx`, never here.
 */
export function priceUsageBaseNanoUsd(pricing: Pricing, usage: Usage): Result<bigint, DomainError> {
  return callBaseNanoUsd(pricing, callUsageFromUsage(usage));
}

/**
 * One call's customer-facing estimate: catalog base cost with the markup.
 * This is the settlement-side estimate over observed usage, where a `0n`
 * result is a legal no-charge (settlement is never balance-guarded).
 * Admission callers must use `estimateRunCeilingNanoUsd`, which rejects a
 * zero ceiling — a zero admission hold is a caller bug.
 */
export function estimateCallNanoUsd(
  pricing: Pricing,
  usage: CallUsage
): Result<bigint, DomainError> {
  return callBaseNanoUsd(pricing, usage).map((base) => applyMarkup(base));
}

function ceilingMultiplier(ceiling: DeclaredCeiling): Result<bigint, DomainError> {
  const dimensions: readonly (readonly [string, number])[] = [
    ['maxFanOutWidth', ceiling.maxFanOutWidth],
    ['maxSteps', ceiling.maxSteps],
    ['maxIterations', ceiling.maxIterations],
  ];
  let multiplier = 1n;
  for (const [label, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 1) {
      return err(validationError(`Estimate ceiling ${label} must be a positive integer`));
    }
    multiplier *= BigInt(value);
  }
  return ok(multiplier);
}

/**
 * The admission estimate: the per-call ceiling cost priced across the run's
 * declared worst case, markup applied once on the multiplied base. A zero
 * ceiling is rejected — it would place a zero admission hold (free
 * admission), which is always a caller bug, never a legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: Pricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling
): Result<bigint, DomainError> {
  return Result.combine([callBaseNanoUsd(pricing, usage), ceilingMultiplier(ceiling)]).andThen(
    ([base, multiplier]) => {
      const amount = applyMarkup(base * multiplier);
      if (amount === 0n) {
        return err(validationError('Estimate run ceiling must be a positive amount'));
      }
      return ok(amount);
    }
  );
}
