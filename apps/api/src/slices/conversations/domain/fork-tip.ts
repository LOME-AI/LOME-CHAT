import { conflictError, notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Fork-tip resolution and advancement, published for the chat settlement (which
 * owns no `conversation_forks` access — conversations is the single writer). A
 * fresh-send onto a fork chains its messages onto the fork's current tip and
 * then advances that tip to the new assistant reply, both INSIDE the one
 * settlement transaction: a rolled-back turn advances no tip.
 *
 * `resolveForkTipWithinTx` takes the fork row `FOR UPDATE` so the settling turn
 * serializes against a concurrent `PUT /forks/:id/tip` on the same fork; the
 * lock is held until the settlement transaction commits, so the tip read here
 * is the tip `advanceForkTipWithinTx` later CASes from. A fork absent at
 * settlement (deleted mid-run) is an expected `not_found` — the turn
 * terminal-fails and persists nothing.
 */

export interface ForkTipResolution {
  readonly tipMessageId: string | null;
}

export interface ResolveForkTipRequest {
  readonly conversationId: string;
  readonly forkId: string;
}

export function resolveForkTipWithinTx(
  stores: ConversationsStores,
  params: ResolveForkTipRequest
): ResultAsync<ForkTipResolution, DomainError> {
  return stores.forks
    .lockById(params.conversationId, params.forkId)
    .andThen((fork) =>
      fork === null
        ? errAsync<ForkTipResolution, DomainError>(
            notFoundError('chat fork tip: fork not found at settlement')
          )
        : okAsync<ForkTipResolution, DomainError>({ tipMessageId: fork.tipMessageId })
    );
}

export interface AdvanceForkTipRequest {
  readonly conversationId: string;
  readonly forkId: string;
  /** The tip the turn's messages chained onto (the CAS's expected state). */
  readonly expectedTipMessageId: string | null;
  /** The new assistant reply the tip advances to. */
  readonly newTipMessageId: string;
}

/**
 * Advance the fork's tip with the same `IS NOT DISTINCT FROM expected` CAS the
 * `PUT /tip` route uses. Under the `FOR UPDATE` lock the resolve step holds,
 * the expected state always holds, so a zero-row outcome is a genuine
 * concurrency defect (the fork moved or vanished despite the lock): re-read to
 * disambiguate gone (`not_found`) from moved (`conflict`). The success token is
 * unused downstream.
 */
export function advanceForkTipWithinTx(
  stores: ConversationsStores,
  params: AdvanceForkTipRequest
): ResultAsync<boolean, DomainError> {
  return stores.forks
    .updateTip({
      conversationId: params.conversationId,
      forkId: params.forkId,
      expectedTipMessageId: params.expectedTipMessageId,
      tipMessageId: params.newTipMessageId,
    })
    .andThen((updated) =>
      updated === null
        ? stores.forks
            .byId(params.conversationId, params.forkId)
            .andThen((fork) =>
              errAsync<boolean, DomainError>(
                fork === null
                  ? notFoundError('chat fork tip: fork vanished before advancement')
                  : conflictError('chat fork tip: tip moved before advancement')
              )
            )
        : okAsync<boolean, DomainError>(true)
    );
}
