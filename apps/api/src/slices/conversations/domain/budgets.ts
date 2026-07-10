import { z } from 'zod';
import {
  MEMBER_PRIVILEGES,
  NanoUSD,
  getPrivilegeLevel,
  nanoUSD,
  serializeNanoUSD,
} from '@hushbox/shared';
import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { groupEffectiveRemainingNanoUsd } from '../../billing/index.js';
import { refusalSchema } from './outcomes.js';
import type { MemberPrivilege } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { Outcome } from './outcomes.js';

/**
 * The group-budget management surface, ported to the legacy privilege ladder:
 * setting a per-member cap needs admin+, setting the per-conversation cap needs
 * owner, and the display is readable by any active member (a non-owner sees only
 * their own figures; the owner sees every member's). The per-member cap lives on
 * billing's `member_budgets` (billing is its single writer, composed here through
 * the barrel), the per-conversation cap on `conversations.conversationBudgetNanoUsd`
 * (this slice's own table). Money is nano-USD `bigint`, serialized as canonical
 * `NanoUSD` strings at the JSON boundary — never `Number()`-coerced.
 */

/** The billing reads/writes the budget surface composes (a subset of the port). */
export type BudgetBilling = Pick<
  BillingStores,
  'setMemberBudgetCapWithinTx' | 'readMemberBudget' | 'readConversationSpent' | 'readWallets'
>;

/** A budget cap: a non-negative nano-USD amount. Negative caps are rejected here. */
const budgetCapSchema = NanoUSD.refine((value) => value >= 0n, 'cap must be non-negative');

export const setMemberBudgetBodySchema = z.object({ capNanoUsd: budgetCapSchema });
export const setConversationBudgetBodySchema = z.object({ capNanoUsd: budgetCapSchema });

export const setBudgetOutcomeSchema = z.union([
  z.object({ updated: z.literal(true) }),
  refusalSchema,
]);
export type SetBudgetOutcome = z.infer<typeof setBudgetOutcomeSchema>;

export const memberBudgetViewSchema = z.object({
  memberId: z.string(),
  userId: z.string().nullable(),
  username: z.string().nullable(),
  privilege: z.enum(MEMBER_PRIVILEGES),
  capNanoUsd: z.string(),
  spentNanoUsd: z.string(),
  /** min(member cap remaining, conversation cap remaining, owner balance). */
  effectiveRemainingNanoUsd: z.string(),
});

export const conversationBudgetsViewSchema = z.object({
  conversationCapNanoUsd: z.string(),
  conversationSpentNanoUsd: z.string(),
  // The owner's raw purchased-wallet balance, shown to EVERY active viewer —
  // including a non-owner member. This is deliberate legacy parity: the legacy
  // GET /budgets handler built its response with no owner-only branch and
  // returned `ownerBalanceDollars` (the owner's balance) to any `read` member,
  // so a non-owner seeing it is preserved behavior, not an over-exposure bug.
  ownerBalanceNanoUsd: z.string(),
  members: z.array(memberBudgetViewSchema),
});

export type ConversationBudgetsView = z.infer<typeof conversationBudgetsViewSchema>;

function serialize(value: bigint): string {
  return serializeNanoUSD(nanoUSD(value));
}

export interface SetMemberBudgetParams {
  readonly conversationId: string;
  readonly memberId: string;
  readonly callerUserId: string;
  readonly capNanoUsd: bigint;
}

/**
 * Admin+ per-member cap set (the legacy `requirePrivilege('admin')` ladder). The
 * conversation is read first so a missing one answers not-found (404) rather than
 * forbidden; the caller must be an active admin+ member (a stranger or a
 * read/write member is forbidden, 403); and the target must be an active member
 * of THIS conversation. The cap upsert preserves cumulative spend (billing's
 * helper). `writeCap` is bound by the route to
 * `billing.setMemberBudgetCapWithinTx(tx, …)` so the write runs inside the
 * caller's `byKey` transaction.
 */
export function setMemberBudget(
  stores: ConversationsStores,
  writeCap: (memberId: string, capNanoUsd: bigint) => ResultAsync<void, DomainError>,
  params: SetMemberBudgetParams
): ResultAsync<SetBudgetOutcome, DomainError> {
  return stores.conversations.get(params.conversationId).andThen((conversation) => {
    if (conversation === null)
      return okAsync<SetBudgetOutcome, DomainError>({ refusal: 'not-found' });
    return stores.members
      .activeByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        if (caller === null || getPrivilegeLevel(caller.privilege) < getPrivilegeLevel('admin')) {
          return okAsync<SetBudgetOutcome, DomainError>({ refusal: 'forbidden' });
        }
        return writeActiveMemberCap(stores, writeCap, params);
      });
  });
}

/** The gated write tail: the target must be an active member; the cap upsert preserves spend. */
function writeActiveMemberCap(
  stores: ConversationsStores,
  writeCap: (memberId: string, capNanoUsd: bigint) => ResultAsync<void, DomainError>,
  params: SetMemberBudgetParams
): ResultAsync<SetBudgetOutcome, DomainError> {
  return stores.members.activeById(params.conversationId, params.memberId).andThen((member) => {
    if (member === null) return okAsync<SetBudgetOutcome, DomainError>({ refusal: 'not-found' });
    return writeCap(params.memberId, params.capNanoUsd).map(
      (): SetBudgetOutcome => ({ updated: true })
    );
  });
}

export interface SetConversationBudgetParams {
  readonly conversationId: string;
  readonly callerUserId: string;
  readonly capNanoUsd: bigint;
}

/**
 * Owner-only per-conversation cap set. The conditional UPDATE on
 * (id, ownerUserId) is the only owner check — never check-then-act — and a
 * 0-row outcome is disambiguated exactly like `updateConversationTitle`: gone is
 * not-found, present but not owned is forbidden.
 */
export function setConversationBudget(
  stores: ConversationsStores,
  params: SetConversationBudgetParams
): ResultAsync<SetBudgetOutcome, DomainError> {
  return stores.conversations
    .updateBudget({
      conversationId: params.conversationId,
      ownerUserId: params.callerUserId,
      budgetNanoUsd: params.capNanoUsd,
    })
    .andThen((updated) => {
      if (updated !== null) return okAsync<SetBudgetOutcome, DomainError>({ updated: true });
      return stores.conversations
        .get(params.conversationId)
        .map(
          (record): SetBudgetOutcome =>
            record === null ? { refusal: 'not-found' } : { refusal: 'forbidden' }
        );
    });
}

interface MemberView {
  readonly id: string;
  readonly userId: string | null;
  readonly username: string | null;
  readonly privilege: MemberPrivilege;
}

interface MemberBudgetRow {
  readonly member: MemberView;
  readonly budget: { readonly budgetNanoUsd: bigint; readonly spentNanoUsd: bigint } | null;
}

/** Reads each member's durable cap + cumulative spend (null when unconfigured). */
function readMemberBudgetRows(
  billing: BudgetBilling,
  db: Database,
  members: readonly MemberView[]
): ResultAsync<readonly MemberBudgetRow[], DomainError> {
  return ResultAsync.combine(
    members.map((member) =>
      billing.readMemberBudget(db, member.id).map((budget): MemberBudgetRow => ({ member, budget }))
    )
  );
}

/** Assembles the display view once every read has resolved (a pure builder). */
function buildBudgetsView(
  conversationCap: bigint,
  conversationSpent: bigint,
  ownerBalance: bigint,
  memberRows: readonly MemberBudgetRow[]
): ConversationBudgetsView {
  return {
    conversationCapNanoUsd: serialize(conversationCap),
    conversationSpentNanoUsd: serialize(conversationSpent),
    ownerBalanceNanoUsd: serialize(ownerBalance),
    members: memberRows.map((row) => {
      const memberCap = row.budget?.budgetNanoUsd ?? 0n;
      const memberSpent = row.budget?.spentNanoUsd ?? 0n;
      return {
        memberId: row.member.id,
        userId: row.member.userId,
        username: row.member.username,
        privilege: row.member.privilege,
        capNanoUsd: serialize(memberCap),
        spentNanoUsd: serialize(memberSpent),
        // The SAME helper admission uses, so the shown remaining equals the gate.
        effectiveRemainingNanoUsd: serialize(
          groupEffectiveRemainingNanoUsd(
            memberCap - memberSpent,
            conversationCap - conversationSpent,
            ownerBalance
          )
        ),
      };
    }),
  };
}

/**
 * The composed reads for the display: the visible member rows, conversation
 * spend, and owner balance. `visibleMemberId` is null for an owner (every
 * non-owner member is returned) or a single member id for a non-owner viewer
 * (only their own row is returned — a non-owner never sees a peer's figures).
 * The conversation-level figures (cap, spend, owner balance) are returned in
 * both cases; they interpret the effective remaining.
 */
interface BudgetsViewRequest {
  readonly conversation: {
    readonly id: string;
    readonly ownerUserId: string;
    readonly conversationBudgetNanoUsd: bigint;
  };
  /** null for the owner (all non-owner members); a member id for a non-owner viewer. */
  readonly visibleMemberId: string | null;
}

function loadBudgetsView(
  stores: ConversationsStores,
  billing: BudgetBilling,
  db: Database,
  request: BudgetsViewRequest
): ResultAsync<Outcome<ConversationBudgetsView>, DomainError> {
  const { conversation, visibleMemberId } = request;
  return stores.members.listActive(conversation.id).andThen((members) => {
    // The owner funds turns and is never member-capped, so it is excluded; a
    // non-owner viewer is further narrowed to their own membership row. This
    // is a deliberate, founder-approved privacy narrowing OVER legacy: the
    // legacy GET /budgets returned every non-owner member's cap + spend to any
    // reader, exposing peers' figures; here a non-owner sees only their own row
    // (the owner still sees every member's).
    const nonOwner = members.filter((member) => member.privilege !== 'owner');
    const visible =
      visibleMemberId === null
        ? nonOwner
        : nonOwner.filter((member) => member.id === visibleMemberId);
    return ResultAsync.combine([
      billing.readConversationSpent(db, conversation.id),
      billing.readWallets(db, conversation.ownerUserId),
      readMemberBudgetRows(billing, db, visible),
    ]).map(([conversationSpent, wallets, memberRows]): Outcome<ConversationBudgetsView> => {
      const ownerBalance =
        wallets.find((wallet) => wallet.type === 'purchased')?.balanceNanoUsd ?? 0n;
      return buildBudgetsView(
        conversation.conversationBudgetNanoUsd,
        conversationSpent,
        ownerBalance,
        memberRows
      );
    });
  });
}

/**
 * Budget display for any active member (the legacy `requirePrivilege('read')`
 * ladder). Composes billing's per-member caps + cumulative spend, the
 * conversation's cumulative spend, and the owner's purchased-wallet balance, and
 * derives each member's effective remaining via the same helper admission uses.
 * A stranger (non-member of an existing conversation) is forbidden (403); a
 * missing conversation is not-found (404). The owner sees every non-owner
 * member; a non-owner member sees only their own row.
 */
export function getConversationBudgets(
  stores: ConversationsStores,
  billing: BudgetBilling,
  db: Database,
  params: { readonly conversationId: string; readonly callerUserId: string }
): ResultAsync<Outcome<ConversationBudgetsView>, DomainError> {
  return stores.conversations.get(params.conversationId).andThen((conversation) => {
    if (conversation === null) {
      return okAsync<Outcome<ConversationBudgetsView>, DomainError>({ refusal: 'not-found' });
    }
    return stores.members
      .activeByUser(params.conversationId, params.callerUserId)
      .andThen((caller) => {
        if (caller === null) {
          return okAsync<Outcome<ConversationBudgetsView>, DomainError>({ refusal: 'forbidden' });
        }
        const ownerViewer = conversation.ownerUserId === params.callerUserId;
        return loadBudgetsView(stores, billing, db, {
          conversation,
          visibleMemberId: ownerViewer ? null : caller.id,
        });
      });
  });
}
