import { getSpendableResponseSchema } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { readGuestFundingSnapshot, serializeFundingSnapshot } from '../../billing/index.js';
import { resolveCallerMember } from './caller.js';
import type { z } from 'zod';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RedisClient } from '../../billing/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { BudgetBilling } from './budgets.js';
import type { ConversationCaller } from './caller.js';
import type { Outcome } from './outcomes.js';

/**
 * The guest-reachable funding door (BILLING §Funding: "a link guest reads the
 * same snapshot through a different door"). `/billing/spendable` is
 * billing-token-classed and a guest holds no session, so the payer's snapshot
 * reaches it here — through the same producer, over the same rows, returning the
 * same shape. A different route is not a second source; a second derivation
 * would be, and there is none: this file resolves WHOSE facts to read and
 * computes no money.
 */
export const guestFundingViewSchema = getSpendableResponseSchema;

export type GuestFundingView = z.infer<typeof guestFundingViewSchema>;

export interface GuestFundingDeps {
  readonly stores: ConversationsStores;
  readonly billing: BudgetBilling;
  readonly db: Database;
  readonly redis: RedisClient;
}

export interface GuestFundingParams {
  readonly conversationId: string;
  readonly caller: ConversationCaller;
  readonly now: Date;
}

/**
 * The funding snapshot a link guest is served: the conversation owner's, always,
 * because a guest's payer is structural rather than funding-derived (§Group
 * Funding 1, 2). Zero spendable therefore still names the owner as payer — it
 * says the allowance is empty, not that nobody would pay.
 *
 * Authorization is the membership gate every other guest-reachable read uses:
 * the route resolves the credential and refuses a mismatched conversation, and
 * the active member row is re-checked here through the shared resolver, so a
 * departed guest holding a live link is the same indistinguishable not-found as
 * a conversation that never existed. A dead credential — revoked or expired —
 * never reaches this function at all: it resolves to no caller at the route and
 * is refused unauthenticated. A caller holding a session is refused outright —
 * they have a wallet and their own funding door, and serving both principals
 * from one handler is how a gate gets written for one of them.
 */
export function getGuestFunding(
  deps: GuestFundingDeps,
  params: GuestFundingParams
): ResultAsync<Outcome<GuestFundingView>, DomainError> {
  const { conversationId, caller, now } = params;
  if (caller.kind !== 'linkGuest') {
    return okAsync<Outcome<GuestFundingView>, DomainError>({ refusal: 'forbidden' });
  }
  return deps.stores.conversations.get(conversationId).andThen((conversation) => {
    if (conversation === null) {
      return okAsync<Outcome<GuestFundingView>, DomainError>({ refusal: 'not-found' });
    }
    return resolveCallerMember(deps.stores, conversationId, caller).andThen((member) => {
      if (member === null) {
        return okAsync<Outcome<GuestFundingView>, DomainError>({ refusal: 'not-found' });
      }
      return readGuestFundingSnapshot(
        { db: deps.db, redis: deps.redis, stores: deps.billing },
        {
          conversation: {
            conversationId,
            memberId: member.id,
            ownerUserId: conversation.ownerUserId,
            conversationBudgetNanoUsd: conversation.conversationBudgetNanoUsd,
          },
          now,
        }
      ).map((snapshot): Outcome<GuestFundingView> => serializeFundingSnapshot(snapshot));
    });
  });
}
