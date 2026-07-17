import { TEST_IDS } from '@hushbox/shared';
import { executeOpOk } from './op-modal.js';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Audit-trail screen helpers: the filter form, the rows table, and API-side
 * trail seeding. Raw element selectors live here, never in specs (rule 3.3).
 */

/** The server's default `GET /admin/audit` page size (limit 1–100, def 50);
 * the SPA's infinite query never passes `limit`, so Load more appears only
 * past this many rows for the active filter set. */
export const AUDIT_PAGE_SIZE = 50;

const AUDIT_FILTER_KEYS = ['actor', 'action', 'targetType', 'targetId', 'from', 'to'] as const;

export type AuditFilterKey = (typeof AUDIT_FILTER_KEYS)[number];

/** One filter-form input by its field key (`#audit-filter-<key>`). */
export function auditFilterInput(page: Page, key: AuditFilterKey): Locator {
  return page.locator(`#audit-filter-${key}`);
}

/**
 * Apply exactly the given filter set: every field is written (absent keys are
 * cleared) so the form's remount-preserved draft can never smuggle a previous
 * step's filter into this apply. Each apply costs one audit read for the
 * SPA's actor.
 */
export async function applyAuditFilters(
  page: Page,
  values: Partial<Record<AuditFilterKey, string>>
): Promise<void> {
  for (const key of AUDIT_FILTER_KEYS) {
    await auditFilterInput(page, key).fill(values[key] ?? '');
  }
  await page.getByTestId(TEST_IDS.adminAuditApplyFilters).click();
}

/** The trail's table rows (the screen renders a single audit table). */
export function auditTableRows(page: Page): Locator {
  return page.locator('tbody tr');
}

/** Parallel-chunk size for trail seeding: concurrent same-wallet credits
 * serialize on the settlement row locks, so a small chunk is safe and keeps
 * 50 executes to a few seconds. */
const SEED_CONCURRENCY = 5;

/** $1 in nano-USD — far under the wallet-adjustment cap. */
const SEED_CREDIT_NANO_USD = '1000000000';

/**
 * Seed `count` wallet.credit audit rows against one wallet via the op engine
 * (executes are not rate-limited, unlike audit READS). Reasons are unique per
 * call — the ledger identity is (op, wallet, amount, reason) and a repeat 409s.
 */
export async function seedWalletCredits(
  api: APIRequestContext,
  walletId: string,
  count: number,
  reasonPrefix: string
): Promise<void> {
  for (let start = 0; start < count; start += SEED_CONCURRENCY) {
    const size = Math.min(SEED_CONCURRENCY, count - start);
    await Promise.all(
      Array.from({ length: size }, (_, offset) =>
        executeOpOk(
          api,
          'wallet.credit',
          {
            walletId,
            amountNanoUsd: SEED_CREDIT_NANO_USD,
            reason: `${reasonPrefix} ${String(start + offset)}`,
          },
          { idempotencyKey: crypto.randomUUID() }
        )
      )
    );
  }
}
