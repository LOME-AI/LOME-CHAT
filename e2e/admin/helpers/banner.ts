import { bannerResponseSchema } from '@hushbox/shared';
import { executeOpOk, opModal } from './op-modal.js';
import type { BannerResponse } from '@hushbox/shared';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Banner-op helpers: the OpForm's repeatable-group row controls (raw element
 * selectors live here, never in specs — rule 3.3) and the public banner read
 * that anchors side-effect assertions (rule 1.5).
 */

/** One sub-field control inside a repeatable group row
 * (`#op-field-<group>-<row>-<sub>` — apps/admin op-form.tsx). */
export function groupSubInput(page: Page, group: string, row: number, sub: string): Locator {
  return opModal(page).locator(`#op-field-${group}-${String(row)}-${sub}`);
}

/** Pick a message row's variant in its Radix select: open the trigger, then
 * click the portaled option. */
export async function selectMessageVariant(
  page: Page,
  row: number,
  variant: string
): Promise<void> {
  await groupSubInput(page, 'messages', row, 'variant').click();
  await page.getByRole('option', { name: variant, exact: true }).click();
}

/** `GET /announcements/banner` — the public, unauthenticated read every
 * client renders from; `hash` is null when the banner is disabled. */
export async function fetchPublicBanner(api: APIRequestContext): Promise<BannerResponse> {
  const response = await api.get('/announcements/banner');
  if (response.status() !== 200) {
    throw new Error(`banner read failed: ${String(response.status())}`);
  }
  return bannerResponseSchema.parse(await response.json());
}

/** Guarantee the banner ends disabled — finally-block hygiene, never an
 * assertion: `banner_config` is one global row rendered app-wide, so an
 * enabled banner leaking past this spec can flake every other suite. */
export async function restoreBannerDisabled(api: APIRequestContext, reason: string): Promise<void> {
  await executeOpOk(
    api,
    'banner.set',
    { enabled: false, messages: [], reason },
    { idempotencyKey: crypto.randomUUID() }
  );
}
