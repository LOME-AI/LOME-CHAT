import { nanoUsdToCents } from '@hushbox/shared';
import { requireEnv } from './env.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/** Nano-USD in one integer cent (1e-2 USD). */
const NANO_USD_PER_CENT = 10_000_000n;

/**
 * Full-precision decimal USD string from a canonical NanoUSD wire string, using
 * integer bigint math (no float, no `Number()` on the full nano amount). Shared
 * only exports a 2-decimal, cent-truncated `nanoUsdToDollarString`, which is
 * unusable here: specs assert `toBeGreaterThan(0)` on sub-cent spend, so any
 * sub-cent value must survive. Mirrors the dev endpoint's own
 * `nanoUsdToDecimalString` shape (nine fraction digits).
 */
function nanoUsdWireToDollars(wire: string): string {
  const value = BigInt(wire);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 1_000_000_000n;
  const fraction = (magnitude % 1_000_000_000n).toString().padStart(9, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** A dollar amount (integer cents) rendered as a canonical NanoUSD wire string. */
function centsToNanoUsdWire(cents: number): string {
  return (BigInt(Math.round(cents)) * NANO_USD_PER_CENT).toString();
}

interface MemberBudget {
  memberId: string;
  userId: string | null;
  username: string | null;
  privilege: string;
  /** Per-member cap, in dollars. Was `budget` (cents/dollars) in the legacy shape. */
  budget: string;
  /** Cumulative member spend, in dollars. */
  spent: string;
}

interface BudgetData {
  /** Per-conversation cap, in dollars. Legacy `conversationBudget`. */
  conversationBudget: string;
  /** Cumulative conversation spend, in dollars. Legacy `totalSpent`. */
  totalSpent: string;
  memberBudgets: MemberBudget[];
  /** Owner purchased-wallet balance, in dollars. Legacy `ownerBalanceDollars`. */
  ownerBalanceDollars: number;
}

interface BalanceData {
  /** Purchased-wallet balance, in dollars. Legacy `balance`. */
  balance: string;
  /** Remaining daily free allowance, in whole cents. Legacy `freeAllowanceCents`. */
  freeAllowanceCents: number;
}

/** The new `GET /billing/balance` wire shape (money as NanoUSD strings). */
interface BalanceResponse {
  purchased: { balanceNanoUsd: string };
  free: { balanceNanoUsd: string };
  allowance: {
    day: string;
    limitNanoUsd: string;
    spentNanoUsd: string;
    remainingNanoUsd: string;
  };
}

/** A member row from the new `GET /conversations/:id/budgets` wire shape. */
interface MemberBudgetView {
  memberId: string;
  userId: string | null;
  username: string | null;
  privilege: string;
  capNanoUsd: string;
  spentNanoUsd: string;
  effectiveRemainingNanoUsd: string;
}

/** The new `GET /conversations/:id/budgets` wire shape (money as NanoUSD strings). */
interface BudgetsResponse {
  conversationCapNanoUsd: string;
  conversationSpentNanoUsd: string;
  ownerBalanceNanoUsd: string;
  members: MemberBudgetView[];
}

/**
 * Helper class wrapping budget and balance API calls for E2E test setup.
 * Accepts any APIRequestContext — instantiate with the right auth context
 * depending on which user needs to perform the operation.
 */
export class BudgetHelper {
  private readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    // Wrap the injected context so budget calls retry a saturation sever even
    // when the caller passes a raw `page.request` (e.g. the multi-model tests).
    this.request = withRequestRetry(request);
  }

  async getBudgets(conversationId: string): Promise<BudgetData> {
    const response = await this.request.get(`${API_BASE}/conversations/${conversationId}/budgets`);
    if (!response.ok()) {
      throw new Error(`getBudgets failed: ${String(response.status())} ${await response.text()}`);
    }
    const data = (await response.json()) as BudgetsResponse;
    return {
      conversationBudget: nanoUsdWireToDollars(data.conversationCapNanoUsd),
      totalSpent: nanoUsdWireToDollars(data.conversationSpentNanoUsd),
      ownerBalanceDollars: Number.parseFloat(nanoUsdWireToDollars(data.ownerBalanceNanoUsd)),
      memberBudgets: data.members.map((member) => ({
        memberId: member.memberId,
        userId: member.userId,
        username: member.username,
        privilege: member.privilege,
        budget: nanoUsdWireToDollars(member.capNanoUsd),
        spent: nanoUsdWireToDollars(member.spentNanoUsd),
      })),
    };
  }

  /**
   * Total spend recorded against a conversation, in dollars. Reads the same
   * `totalSpent` the budgets endpoint reports; poll it to wait for a turn's
   * post-flight billing to settle (the spend persists alongside the wallet
   * debit, just before the speculative reservation is released).
   */
  async getTotalSpent(conversationId: string): Promise<number> {
    const budgets = await this.getBudgets(conversationId);
    return Number.parseFloat(budgets.totalSpent);
  }

  async setConversationBudget(conversationId: string, budgetCents: number): Promise<void> {
    const response = await this.request.put(`${API_BASE}/conversations/${conversationId}/budget`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { capNanoUsd: centsToNanoUsdWire(budgetCents) },
    });
    if (!response.ok()) {
      throw new Error(
        `setConversationBudget failed: ${String(response.status())} ${await response.text()}`
      );
    }
  }

  async setMemberBudget(
    conversationId: string,
    memberId: string,
    budgetCents: number
  ): Promise<void> {
    const response = await this.request.put(
      `${API_BASE}/conversations/${conversationId}/member/${memberId}/budget`,
      {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        data: { capNanoUsd: centsToNanoUsdWire(budgetCents) },
      }
    );
    if (!response.ok()) {
      throw new Error(
        `setMemberBudget failed: ${String(response.status())} ${await response.text()}`
      );
    }
  }

  async getBalance(): Promise<BalanceData> {
    const response = await this.request.get(`${API_BASE}/billing/balance`);
    if (!response.ok()) {
      throw new Error(`getBalance failed: ${String(response.status())} ${await response.text()}`);
    }
    const data = (await response.json()) as BalanceResponse;
    return {
      balance: nanoUsdWireToDollars(data.purchased.balanceNanoUsd),
      // The daily free allowance remaining (legacy `freeAllowanceCents`) — the
      // free WALLET balance (`data.free`) is a distinct concept and not this.
      freeAllowanceCents: nanoUsdToCents(data.allowance.remainingNanoUsd),
    };
  }

  /**
   * Actual cost charged for a conversation's surviving AI messages, in micros
   * (millionths of a dollar). Sums `usage_records.cost` — written in the same
   * transaction as the wallet debit, so it equals the real wallet charge — but
   * scoped to one conversation. Unlike the global `getBalance()` delta, this is
   * immune to other tests charging the same shared per-project user in parallel,
   * which is the source of cost-reconciliation flake.
   */
  async getConversationChargedMicros(conversationId: string): Promise<number> {
    const response = await this.request.get(`${API_BASE}/dev/conversation-cost/${conversationId}`);
    if (!response.ok()) {
      throw new Error(
        `getConversationChargedMicros failed: ${String(response.status())} ${await response.text()}`
      );
    }
    const data = (await response.json()) as { cost: string };
    return Math.round(Number(data.cost) * 1_000_000);
  }

  /**
   * Find a member's conversation-member ID by their user ID.
   * Note: the budgets endpoint filters out the owner, so this only finds non-owner members.
   */
  async findMemberId(conversationId: string, userId: string): Promise<string> {
    const budgets = await this.getBudgets(conversationId);
    const member = budgets.memberBudgets.find((mb) => mb.userId === userId);
    if (!member) {
      throw new Error(
        `Member with userId ${userId} not found in conversation ${conversationId}. ` +
          `Available members: ${budgets.memberBudgets.map((mb) => mb.userId).join(', ')}`
      );
    }
    return member.memberId;
  }
}

/**
 * Set a user's wallet balance via the dev endpoint.
 * Used in E2E tests to manipulate wallet state for tier-switching scenarios.
 */
export async function setWalletBalance(
  request: APIRequestContext,
  email: string,
  walletType: 'purchased' | 'free_tier',
  balance: string
): Promise<void> {
  const response = await request.post(`${API_BASE}/dev/wallet-balance`, {
    data: { email, walletType, balance },
  });
  if (!response.ok()) {
    throw new Error(
      `setWalletBalance failed: ${String(response.status())} ${await response.text()}`
    );
  }
}
