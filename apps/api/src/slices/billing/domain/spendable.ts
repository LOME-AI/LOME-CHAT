import { notFoundError, unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { HOLDS_READ_SCRIPT } from './admission-scripts.js';
import { resolveEffectiveSpendable } from './admission.js';
import { conversationBudgetScopeId, memberBudgetScopeId } from './budget-resolution.js';
import { BILLING_KEYS } from './keys.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { AdmissionDeps } from './admission.js';
import type { RedisClient } from './keys.js';

/** One hold hash's active readout: the held sum. */
export interface ActiveHoldsReadout {
  readonly heldNanoUsd: bigint;
}

/**
 * Active holds over N hold hashes (wallet or budget scope) in one round trip,
 * via the read script that embeds the shared `activeHolds` Lua fragment — the
 * hold value format is parsed only inside Lua, and expired entries prune
 * lazily exactly like admission. Redis down fails closed (typed
 * `unavailable`), matching admission.
 */
export function readActiveHolds(
  redis: RedisClient,
  keys: readonly string[],
  now: Date
): ResultAsync<readonly ActiveHoldsReadout[], DomainError> {
  if (keys.length === 0) {
    return okAsync([]);
  }
  return fromPromise(
    redis.createScript(HOLDS_READ_SCRIPT).exec([...keys], [String(now.getTime())]) as Promise<
      readonly (string | number)[]
    >,
    (cause) => unavailableError('holds read refused: Redis unavailable (fail-closed)', cause)
  ).map((flat) =>
    keys.map(
      (_, index): ActiveHoldsReadout => ({
        // The script formats each sum as a %.0f string (full 2^53 precision);
        // BigInt keeps money integer from there.
        heldNanoUsd: BigInt(String(flat[index])),
      })
    )
  );
}

/**
 * A group budget scope named by its domain identity. Callers (the budgets
 * display) never build scope-id strings — the id derivation is shared with
 * `resolveBudgetScopes`, so display and admission address the same hash.
 */
export type BudgetScopeHoldRef =
  | { readonly scope: 'member'; readonly memberId: string }
  | { readonly scope: 'conversation'; readonly conversationId: string };

function scopeHoldKey(ref: BudgetScopeHoldRef): string {
  return BILLING_KEYS.scopeHolds.buildKey(
    ref.scope === 'member'
      ? memberBudgetScopeId(ref.memberId)
      : conversationBudgetScopeId(ref.conversationId)
  );
}

/**
 * Active holds over budget scope hashes — the display-side counterpart of the
 * admission script's per-scope check. One script exec covers every ref (one
 * Redis read per request, not per scope); readouts pair with `refs`
 * positionally, one per ref by construction. Redis down fails closed.
 */
export function readBudgetScopeHolds(
  redis: RedisClient,
  scopes: readonly BudgetScopeHoldRef[],
  now: Date
): ResultAsync<readonly ActiveHoldsReadout[], DomainError> {
  return readActiveHolds(
    redis,
    scopes.map((scope) => scopeHoldKey(scope)),
    now
  );
}

/**
 * Positional pairing accessor for {@link readBudgetScopeHolds} readouts: one
 * readout exists per requested ref by construction, so a hole is a defect
 * (thrown), never a legal state to default around.
 */
export function holdReadoutAt(
  readouts: readonly ActiveHoldsReadout[],
  index: number
): ActiveHoldsReadout {
  const readout = readouts[index];
  if (readout === undefined) {
    throw new Error('holds readout missing for a requested scope');
  }
  return readout;
}

/**
 * Totals readouts (one per key in, one out by construction) — a fold instead
 * of `readouts[0]`, so no optional-index branch exists to defend.
 */
function totalHolds(readouts: readonly ActiveHoldsReadout[]): ActiveHoldsReadout {
  let heldNanoUsd = 0n;
  for (const readout of readouts) {
    heldNanoUsd += readout.heldNanoUsd;
  }
  return { heldNanoUsd };
}

export interface ReadSpendableArgs {
  readonly userId: string;
  readonly now: Date;
}

/** The served affordability numbers behind `GET /billing/spendable`. */
export interface SpendableView {
  /** Cushion- and hold-aware: exactly what admission's balance gate compares. */
  readonly spendableNanoUsd: bigint;
  readonly heldNanoUsd: bigint;
}

/**
 * The served-affordability read (BILLING §Affordability 1): the caller's
 * PURCHASED wallet resolved through the same snapshot + spendable rule
 * admission gates with, minus the wallet's active holds. The free-tier daily
 * allowance is a budget scope, not a balance — it rides the budgets endpoint,
 * never this number. Served spendable may be negative (overdrawn wallet);
 * clamping would hide the deficit the composer must show.
 */
export function readSpendable(
  deps: AdmissionDeps,
  args: ReadSpendableArgs
): ResultAsync<SpendableView, DomainError> {
  return deps.stores.readWallets(deps.db, args.userId).andThen((walletRows) => {
    const purchased = walletRows.find((wallet) => wallet.type === 'purchased');
    if (purchased === undefined) {
      return errAsync<SpendableView, DomainError>(
        notFoundError('spendable: caller has no purchased wallet')
      );
    }
    return resolveEffectiveSpendable(deps, purchased.id).andThen((spendable) =>
      readActiveHolds(deps.redis, [BILLING_KEYS.walletHolds.buildKey(purchased.id)], args.now).map(
        (readouts): SpendableView => {
          const holds = totalHolds(readouts);
          return {
            spendableNanoUsd: spendable.effectiveSpendableNanoUsd - holds.heldNanoUsd,
            heldNanoUsd: holds.heldNanoUsd,
          };
        }
      )
    );
  });
}
