import * as React from 'react';
import {
  SMART_MODEL_ID,
  getEffectiveBalanceNano,
  getTurnOptions,
  modelId,
  nanoUSD,
  type FundingSnapshot,
  type NanoUSD,
  type Model,
  type ModelId,
  type PriceableModel,
  type PromptBasis,
  type Selection,
  type TurnOptions,
  type UserTier,
} from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { useModels } from '@/hooks/models/models';
import { hasServedFunding, useSpendable } from '@/hooks/billing/use-spendable';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';

/**
 * THE adapter hook — the only place under `apps/web` that calls the money
 * layer's producer (`docs/BILLING.md` §What is enforced: "No code under
 * `apps/web` outside one named adapter hook imports a pricing or affordability
 * symbol"). Every surface reads the value this returns; none computes a verdict,
 * so none can disagree with another.
 *
 * The rule is written against CODE, not components, because a second verdict
 * engine is as easily a hook as a component — which is exactly what this hook
 * replaced.
 */

/**
 * The instant the catalog snapshot is taken at, captured ONCE per page load.
 *
 * Premium classification's recency leg is measured from this instant, and
 * `affordable` is documented keystroke-stable — so a per-render `Date.now()`
 * would churn the memo key of a set whose whole contract is that it does not
 * move while the user types. It is exported so a test can assert stability
 * rather than trusting the absence of a call.
 *
 * The client's instant is advisory in the only way that matters: the server
 * re-runs the producer against its own clock at admission, so a wrong client
 * clock mis-DISPLAYS availability and cannot move money.
 */
export const CATALOG_INSTANT_MS: number = Date.now();

/**
 * The narrow projection the money layer consumes, built from a wire catalog
 * row. Fails closed exactly as the server-side projection does: a row with no
 * per-token rates, no context length or no release date is not priceable and is
 * left out of the pool rather than defaulted, because a zero rate prices a turn
 * as free and a missing release date would silently make every recency test
 * false.
 *
 * The synthetic Smart Model row is never a pool member — it is the smart SLOT,
 * carried on `Selection.answerSources.smartSlot`, and its headline pricing
 * describes a range rather than a model.
 */
function priceableFromWire(model: Model): PriceableModel | undefined {
  if (model.isSmartModel === true) return undefined;
  const { inputPerToken, outputPerToken } = model.pricing;
  if (inputPerToken === undefined || outputPerToken === undefined) return undefined;
  if (model.contextLength <= 0) return undefined;
  if (model.created === undefined) return undefined;
  return {
    modelId: modelId(model.id),
    inputRateNanoUsd: nanoUSD(BigInt(inputPerToken)),
    outputRateNanoUsd: nanoUSD(BigInt(outputPerToken)),
    contextLength: model.contextLength,
    providerCap: model.maxOutputTokens,
    reasoning: model.reasoning,
    // The catalog dates a model in seconds; the money layer compares in
    // milliseconds. This is the one place the two units meet on the client.
    releasedAtMs: model.created * 1000,
  };
}

/**
 * The funding figures for the one payer with NO funding door: the trial.
 * §Affordability 8 fixes it at a $0.01 effective balance rather than nothing —
 * handing the producer `0n` here reads as poverty and refuses the whole
 * unauthenticated funnel, while the server admits those turns on quota. The
 * ceiling comes from the shared tier authority so there is exactly one
 * definition of it.
 *
 * A link guest is NOT here: it has a door of its own and is owner-funded, so it
 * reads the payer's served figures like anyone else (BILLING §Funding).
 */
function trialFunding(): {
  spendableNanoUsd: NanoUSD;
  heldNanoUsd: NanoUSD;
} {
  return {
    spendableNanoUsd: nanoUSD(getEffectiveBalanceNano('trial', 0n, 0n)),
    heldNanoUsd: nanoUSD(0n),
  };
}

export interface UseTurnOptionsInput {
  /** Counts only — the money layer never receives content. */
  readonly basis: PromptBasis;
  readonly isAuthenticated: boolean;
  /**
   * The conversation being composed in, which is what names the PAYER: an
   * owner-funded group turn is priced from the owner's funds at the owner's
   * tier. Omit for a solo composer or a picker opened outside a conversation.
   */
  readonly conversationId?: string | null;
}

export interface UseTurnOptionsResult {
  /**
   * True while a funding or catalog input is still in flight. A surface must
   * render its neutral state while this holds — NOT a refusal. Treating an
   * absent funding read as `0n` is what greyed every affordable row for a
   * render, so this hook withholds the verdict entirely instead of producing a
   * poor one, and `options` is `undefined` for exactly as long.
   */
  readonly isPending: boolean;
  /** The produced pair, or `undefined` while `isPending`. */
  readonly options: TurnOptions | undefined;
  /**
   * What active holds took off the payer's spendable, from the same snapshot
   * that produced `options`. It is the ONLY evidence a hold exists: the two
   * option sets differ in funding AND basis, so their difference cannot
   * distinguish a hold from a long prompt.
   */
  readonly heldNanoUsd: bigint;
  /**
   * The payer's hold-aware spendable, from the same snapshot that produced
   * `options`. It rides beside the pair because a surface wording a money
   * refusal needs to know whether the payer has nothing or merely not enough —
   * two conditions the option sets alone cannot tell apart.
   */
  readonly payerSpendableNanoUsd: bigint;
  /**
   * WHO the served figures describe, straight from the wire. The server applied
   * §Group Funding 2 and named the payer; this is that answer, carried through
   * unchanged so a surface can say which wallet pays without deciding it.
   */
  readonly payer: 'self' | 'owner';
}

/** Which models the turn draws on, with the sentinel resolved to the smart slot. */
function answerSourcesOf(
  selected: readonly { id: string }[]
): Selection['answerSources'] | undefined {
  const smartSlot = selected.some((entry) => entry.id === SMART_MODEL_ID);
  const pinned = selected
    .filter((entry) => entry.id !== SMART_MODEL_ID)
    .map((entry): ModelId => modelId(entry.id));
  const [first, ...rest] = pinned;
  if (first !== undefined) return { models: [first, ...rest], smartSlot };
  // At least one answer source is required by the type, so a selection that is
  // neither a pinned model nor the smart slot has no turn to price.
  return smartSlot ? { models: [], smartSlot: true } : undefined;
}

/**
 * The payer's funding snapshot: ONE served number for every caller with a
 * funding door, and the fixed client-side ceiling only for the trial, which has
 * none. The served snapshot also names the PAYER's tier, which is why an
 * owner-funded turn — a group member's or a link guest's alike — sizes as the
 * owner's would rather than the sender's.
 *
 * The fallback belongs to the trial alone. A caller that HAS a door is gated
 * until its snapshot is in hand — still loading and failed alike — so the trial
 * ceiling never stands in for another payer's figure.
 */
function fundingSnapshotOf(served: ServedFunding): FundingSnapshot {
  if (served === undefined) {
    return { ...trialFunding(), payerTier: 'trial', payer: 'self' };
  }
  return {
    spendableNanoUsd: nanoUSD(BigInt(served.spendableNanoUsd)),
    heldNanoUsd: nanoUSD(BigInt(served.heldNanoUsd)),
    payerTier: served.payerTier,
    payer: served.payer,
  };
}

/** One served funding read, as the wire carries it. */
type ServedFunding =
  | { spendableNanoUsd: string; heldNanoUsd: string; payerTier: UserTier; payer: 'self' | 'owner' }
  | undefined;

export function useTurnOptions(input: UseTurnOptionsInput): UseTurnOptionsResult {
  const activeModality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const { active: webSearch } = useWebSearch();
  const { effective: effort } = useReasoningEffort();
  const { data: modelsData } = useModels();
  const conversationId = input.conversationId ?? null;
  // ONE read. The conversation NAMES the payer, and the server has already
  // applied §Group Funding 2 — it returns the winning wallet's figures plus
  // `payer` and `payerTier`. Re-resolving that client-side was a second authority
  // for a decision the wire already carries, and it disagreed with the server
  // inside the settle-then-release window.
  const { data: served } = useSpendable(conversationId);

  // A caller with no funding door (the trial) never resolves this query, so its
  // permanent absence must not gate it. A caller that HAS a door is gated until
  // the snapshot is in hand — on the ABSENCE of the snapshot, not on the query
  // being pending, because a FAILED read settles with no data and a
  // pending-only gate would let it fall through to the trial ceiling. That
  // fallback is the tier conflation the guest's own door exists to remove.
  const isFundingPending =
    hasServedFunding(input.isAuthenticated, conversationId) && served === undefined;
  const isPending = isFundingPending || modelsData === undefined;

  const catalog = modelsData?.models;
  const selectedIds = selected.map((entry) => entry.id).join('\u0000');

  return React.useMemo((): UseTurnOptionsResult => {
    if (isPending || catalog === undefined)
      return {
        isPending: true,
        options: undefined,
        heldNanoUsd: 0n,
        payerSpendableNanoUsd: 0n,
        payer: 'self',
      };

    const answerSources = answerSourcesOf(selected);
    if (answerSources === undefined)
      return {
        isPending: false,
        options: undefined,
        heldNanoUsd: 0n,
        payerSpendableNanoUsd: 0n,
        payer: 'self',
      };

    const funding = fundingSnapshotOf(served);

    const selection: Selection = {
      answerSources,
      modality: activeModality,
      pinned: effort === undefined || effort === 'auto' ? {} : { effort },
      webSearch,
    };

    const models = catalog.flatMap((model) => {
      const priceable = priceableFromWire(model);
      return priceable === undefined ? [] : [priceable];
    });

    return {
      isPending: false,
      heldNanoUsd: BigInt(funding.heldNanoUsd),
      payerSpendableNanoUsd: BigInt(funding.spendableNanoUsd),
      payer: funding.payer,
      options: getTurnOptions(funding, input.basis, selection, {
        models,
        nowMs: CATALOG_INSTANT_MS,
      }),
    };
    // `selected` is a fresh array identity on every store read, so the memo
    // keys on the joined ids instead — a keystroke must not re-run the
    // producer, and an unchanged selection must not look changed.
  }, [isPending, catalog, selectedIds, served, activeModality, effort, webSearch, input.basis]);
}
