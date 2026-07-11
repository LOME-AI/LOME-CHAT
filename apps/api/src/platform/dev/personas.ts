import { count, eq, like } from 'drizzle-orm';
import { conversations, messages, users } from '@hushbox/db';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@hushbox/shared';
import { createBillingStores, readBalance } from '../../slices/billing/index.js';
import { firstCount } from './reads.js';
import type { BalanceView } from '../../slices/billing/index.js';
import type { Database } from '@hushbox/db';
import type { DevPersona } from '@hushbox/shared';

const NANO_PER_USD = 1_000_000_000n;

/** An unreadable balance renders as empty credits — dev tooling, never money truth. */
export function creditsForView(view: BalanceView | null): string {
  return view === null ? '$0.00' : formatCredits(view.purchasedNanoUsd, view.freeNanoUsd);
}

/** Wallet total (purchased + free) rendered as the legacy `$X.XX` credits string. */
export function formatCredits(purchasedNanoUsd: bigint, freeNanoUsd: bigint): string {
  const total = purchasedNanoUsd + freeNanoUsd;
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const cents = (magnitude + NANO_PER_USD / 200n) / (NANO_PER_USD / 100n);
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  return `${negative ? '-' : ''}$${String(dollars)}.${String(remainder).padStart(2, '0')}`;
}

/**
 * List dev or test personas with their stats. Semantic adaptations from
 * legacy: `projectCount` is always 0 (the projects feature was deliberately
 * deleted in the redesign; the field survives for response-shape parity) and
 * `credits` sums the purchased + free wallets.
 */
export async function listDevPersonas(db: Database, type: 'dev' | 'test'): Promise<DevPersona[]> {
  const emailDomain = type === 'test' ? TEST_EMAIL_DOMAIN : DEV_EMAIL_DOMAIN;
  const billing = createBillingStores();

  const devUsers = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(like(users.email, `%@${emailDomain}`));

  return Promise.all(
    devUsers.map(async (user) => {
      const convCount = await db
        .select({ count: count() })
        .from(conversations)
        .where(eq(conversations.userId, user.id));

      const msgCount = await db
        .select({ count: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(eq(conversations.userId, user.id));

      const balance = await readBalance(billing, db, user.id, new Date());
      const credits = creditsForView(balance.unwrapOr(null));

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        emailVerified: user.emailVerified,
        stats: {
          conversationCount: firstCount(convCount),
          messageCount: firstCount(msgCount),
          projectCount: 0,
        },
        credits,
      };
    })
  );
}
