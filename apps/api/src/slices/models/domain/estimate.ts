import { match } from 'ts-pattern';
import { applyMarkup } from '../../billing/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { Result, err, ok } from '../../../lib/result/index.js';
import type { Pricing } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

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
  const dimensionRate = rate[usage.dimensionKey];
  if (dimensionRate === undefined) {
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

function callBase(pricing: Pricing, usage: CallUsage): Result<bigint, DomainError> {
  return match(usage)
    .with({ kind: 'tokens' }, (tokens) => tokenBase(pricing, tokens))
    .with({ kind: 'media' }, (media) => mediaBase(pricing, media))
    .exhaustive();
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
  return callBase(pricing, usage).map((base) => applyMarkup(base));
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
  return Result.combine([callBase(pricing, usage), ceilingMultiplier(ceiling)]).andThen(
    ([base, multiplier]) => {
      const amount = applyMarkup(base * multiplier);
      if (amount === 0n) {
        return err(validationError('Estimate run ceiling must be a positive amount'));
      }
      return ok(amount);
    }
  );
}
