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
import { useSpendable } from '@/hooks/billing/use-spendable';
import { useUserTierInfo } from '@/hooks/billing/use-user-tier-info';
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
 * The funding figures for a payer with NO endpoint. `GET /billing/spendable` is
 * `enabled: isAuthenticated`, so trial and guest never receive a snapshot —
 * and §Affordability 8 fixes them at a $0.01 effective balance rather than
 * nothing. Handing the producer `0n` here reads as poverty and refuses the
 * whole unauthenticated funnel, while the server admits those turns on quota.
 * The ceiling comes from the shared tier authority so there is exactly one
 * definition of it.
 */
function noEndpointFunding(tier: UserTier): {
  spendableNanoUsd: NanoUSD;
  heldNanoUsd: NanoUSD;
} {
  return {
    spendableNanoUsd: nanoUSD(getEffectiveBalanceNano(tier, 0n, 0n)),
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
 * The payer's funding snapshot: ONE served number for every authenticated tier,
 * and the fixed client-side ceiling only where no endpoint exists (trial and
 * guest, refused by that route class by design). The served snapshot also names
 * the payer's tier, which is why an owner-funded group turn sizes as the owner's
 * would rather than the sender's.
 */
function fundingSnapshotOf(served: ServedFunding, callerTier: UserTier): FundingSnapshot {
  if (served === undefined) {
    return { ...noEndpointFunding(callerTier), tier: callerTier, payer: 'self' };
  }
  return {
    spendableNanoUsd: nanoUSD(BigInt(served.spendableNanoUsd)),
    heldNanoUsd: nanoUSD(BigInt(served.heldNanoUsd)),
    tier: served.tier,
    payer: served.payer,
  };
}

/** One served funding read, as the wire carries it. */
type ServedFunding =
  | { spendableNanoUsd: string; heldNanoUsd: string; tier: UserTier; payer: 'self' | 'owner' }
  | undefined;

export function useTurnOptions(input: UseTurnOptionsInput): UseTurnOptionsResult {
  const activeModality = useModelStore((state) => state.activeModality);
  const selected = useModelStore((state) => state.selections[state.activeModality]);
  const { active: webSearch } = useWebSearch();
  const { effective: effort } = useReasoningEffort();
  const { data: modelsData } = useModels();
  const tierInfo = useUserTierInfo(input.isAuthenticated);
  const conversationId = input.conversationId ?? null;
  // ONE read. The conversation NAMES the payer, and the server has already
  // applied §Group Funding 2 — it returns the winning wallet's figures plus
  // `payer` and `tier`. Re-resolving that client-side was a second authority
  // for a decision the wire already carries, and it disagreed with the server
  // inside the settle-then-release window.
  const { data: served, isPending: isServedPending } = useSpendable(conversationId);

  // Trial and guest are refused by the funding endpoint's route class by
  // design, so their pending state is never reached and must not gate them.
  const isFundingPending = input.isAuthenticated && isServedPending;
  const isPending = isFundingPending || modelsData === undefined;

  const catalog = modelsData?.models;
  const selectedIds = selected.map((entry) => entry.id).join(' ');

  return React.useMemo((): UseTurnOptionsResult => {
    if (isPending || catalog === undefined) return { isPending: true, options: undefined };

    const answerSources = answerSourcesOf(selected);
    if (answerSources === undefined) return { isPending: false, options: undefined };

    const funding = fundingSnapshotOf(served, tierInfo.tier);

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
      options: getTurnOptions(funding, input.basis, selection, {
        models,
        nowMs: CATALOG_INSTANT_MS,
      }),
    };
    // `selected` is a fresh array identity on every store read, so the memo
    // keys on the joined ids instead — a keystroke must not re-run the
    // producer, and an unchanged selection must not look changed.
  }, [
    isPending,
    catalog,
    selectedIds,
    served,
    tierInfo.tier,
    activeModality,
    effort,
    webSearch,
    input.basis,
  ]);
}
