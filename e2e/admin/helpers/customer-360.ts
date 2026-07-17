import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { Customer360View } from '@hushbox/shared';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Customer-360 helpers, API and UI halves.
 *
 * BUDGET WARNING: `GET /admin/users/overview` is rate-limited at 120/hr per
 * admin actor and the reset auto-hook does NOT clear the admin limiter keys
 * (`admin:read:*:ratelimit:*` — no dev route covers them). Every API fetch
 * here AND every SPA customer-360 render (including query invalidations
 * after an op execute) consumes the shared per-actor bucket, so keep reads
 * per test modest and prefer spreading API contexts across the two dev
 * actors.
 */

export interface WalletSummary {
  readonly id: string;
  readonly type: string;
  readonly balanceNanoUsd: string;
}

/** One audited customer-360 API read. Throws on any non-200. */
export async function fetchCustomer360(
  api: APIRequestContext,
  query: { email: string } | { userId: string }
): Promise<Customer360View> {
  const response = await api.get('/admin/users/overview', { params: { ...query } });
  if (response.status() !== 200) {
    throw new Error(`customer-360 read failed: ${String(response.status())}`);
  }
  return (await response.json()) as Customer360View;
}

/** The user's wallet of the given type, from one customer-360 read. */
export async function fetchWallet(
  api: APIRequestContext,
  query: { email: string } | { userId: string },
  type: 'purchased' | 'free'
): Promise<WalletSummary> {
  const view = await fetchCustomer360(api, query);
  const money = view.panels.money;
  if (!money.ok) {
    throw new Error(`customer-360 money panel failed: ${money.error}`);
  }
  const wallet = money.data.wallets.find((candidate) => candidate.type === type);
  if (wallet === undefined) {
    throw new Error(`customer-360 money panel has no ${type} wallet`);
  }
  return wallet;
}

/**
 * Drive the SPA to a user's 360 view via the screen's own search form and
 * gate on the panels grid rendering (one SPA-side audited read).
 */
export async function openCustomer360(page: Page, term: string): Promise<void> {
  await page.goto('/customer-360');
  await page.getByTestId(TEST_IDS.adminUserSearchInput).fill(term);
  await page.getByRole('button', { name: 'Open Customer 360' }).click();
  await expect(page.getByTestId(TEST_IDS.adminC360Panels)).toBeVisible({
    timeout: TIMEOUTS.ROUTE,
  });
}

/**
 * Drive the SPA's search WITHOUT gating on a hit — for the invalid/miss
 * states (`openCustomer360` above gates on the panels grid and only fits
 * successful lookups). An invalid term never fires a request; a valid miss
 * costs one audited read for the SPA's actor.
 */
export async function searchCustomer360(page: Page, term: string): Promise<void> {
  await page.goto('/customer-360');
  await page.getByTestId(TEST_IDS.adminUserSearchInput).fill(term);
  await page.getByRole('button', { name: 'Open Customer 360' }).click();
}

/** One Customer-360 panel section by its PanelFrame title (the direct-child
 * `h2` carries exactly the title). Raw selector confined to this helper. */
export function c360Panel(page: Page, title: string): Locator {
  return page.locator(`section:has(> h2:text-is("${title}"))`);
}

/** The money-panel table row for one wallet id (the id renders as a
 * monospace CopyableId inside the row). Raw locator confined to this helper. */
export function walletRow(page: Page, walletId: string): Locator {
  return page.locator('tr').filter({ hasText: walletId });
}

/** The row-scoped "Credit" button that opens the wallet.credit OpModal. */
export function creditButtonFor(page: Page, walletId: string): Locator {
  return walletRow(page, walletId).getByRole('button', { name: 'Credit' });
}
