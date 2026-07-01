import { test } from '@playwright/test';
import { expect } from './helpers/expect.js';

/**
 * End-to-end coverage of the app-wide announcement banner on the marketing site.
 *
 * Status: this spec rides the dark `e2e/` suite — skipped in CI until the
 * Phase-4 re-pointing (see docs/history/BACKEND-REDESIGN.md, amendment
 * 2026-06-30). It also requires a deterministic active `banner_config` row in
 * E2E mode (the banner reads the row live; there is no mock seam like the
 * roadmap's Linear mock). Wire that seed at the re-point — e.g. a global-setup
 * insert of an enabled single-message set — then unskip the tests below.
 *
 * The banner is the same shared `createBanner` controller the React app mounts,
 * so verifying it on the static marketing site also exercises the compiled-Astro
 * path (no React island) end to end.
 */
test.describe('Announcement banner (marketing)', () => {
  test.fixme(true, 'requires an active banner_config seed + the Phase-4 e2e re-point');

  test('shows, dismisses, and stays dismissed across reloads', async ({ page }) => {
    await page.goto('/welcome');

    const banner = page.getByRole('region', { name: /announcements/i });
    await expect(banner).toBeVisible();

    await banner.getByRole('button', { name: /dismiss/i }).click();
    await expect(banner).toBeHidden();

    // Dismissal is persisted locally (no auth on the marketing site), so it
    // stays dismissed for the same message-set hash after a reload.
    await page.reload();
    await expect(page.getByRole('region', { name: /announcements/i })).toHaveCount(0);
  });

  test('a changed message set re-shows after a previous dismissal', async ({ page, context }) => {
    // Pre-seed a stale dismissal for a different hash; the live set's hash differs,
    // so the banner must re-appear (dismissal is keyed by message-set hash).
    await context.addInitScript(() => {
      globalThis.localStorage.setItem('hushbox.banner.dismissed.v1', 'stale-hash-from-an-old-set');
    });
    await page.goto('/welcome');
    await expect(page.getByRole('region', { name: /announcements/i })).toBeVisible();
  });
});
