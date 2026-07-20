import { test } from './fixtures.js';
import { expect } from './helpers/expect.js';
import { openMobileLandingMenuIfNeeded } from './helpers/marketing-nav.js';
import {
  waitForRoadmapReady,
  roadmapSections,
  roadmapSectionsByStatus,
} from './helpers/page-signals.js';

/**
 * End-to-end coverage of the public /roadmap page. The page is built by
 * Astro, merged on top of the web app's dist by
 * `scripts/merge-marketing-into-web.ts`, then served by `vite preview` —
 * the same merged layout Cloudflare Pages serves in production. The
 * roadmap's React island fetches `/api/public/roadmap`, which in E2E mode
 * uses the Linear mock client, so the response is deterministic.
 */

test.describe('Public roadmap', () => {
  test('renders, filters, and is reachable from landing nav', async ({ page }) => {
    await page.goto('/welcome');
    await openMobileLandingMenuIfNeeded(page);
    // `.filter({ visible: true })` picks whichever of the two nav variants
    // (desktop nav or the now-open mobile drawer) is currently rendered;
    // the other lives in DOM but with `display: none` via Tailwind.
    await page.getByRole('link', { name: 'Roadmap' }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/roadmap/);

    await expect(page.getByRole('heading', { name: 'Roadmap', level: 1 })).toBeVisible();
    await waitForRoadmapReady(page);
    await expect(roadmapSections(page).first()).toHaveAttribute('data-status', 'in_progress');
    for (const name of ['Shipping now', 'Up next', 'Shipped', 'Features', 'Bugs']) {
      await expect(page.getByRole('button', { name: new RegExp(name, 'i') })).toBeVisible();
    }

    await page.getByRole('button', { name: /Shipped/i }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('status'))
      .toContain('in_progress');
    await expect(roadmapSectionsByStatus(page, 'shipped')).toHaveCount(0);

    await page.getByRole('button', { name: /Bugs/i }).click();
    await expect(page.getByText(/hidden by filter/i).first()).toBeVisible();

    await page.goto('/roadmap?status=in_progress&type=feature');
    await waitForRoadmapReady(page);
    await expect(page.getByRole('button', { name: /Shipped/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(page.getByRole('button', { name: /Shipping now/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
