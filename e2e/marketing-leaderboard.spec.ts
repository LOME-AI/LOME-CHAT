import { test } from './fixtures.js';
import { expect } from './helpers/expect.js';
import { openMobileLandingMenuIfNeeded } from './helpers/marketing-nav.js';
import { waitForStatsSettled, statsReadyBoard } from './helpers/page-signals.js';

/**
 * End-to-end coverage of the public /leaderboard page. Like /roadmap, the page
 * is built by Astro, merged on top of the web app's dist, and served by
 * `vite preview`. The stats React island fetches `/api/public/stats`, whose
 * payload is a snapshot built by the real cron entry from the deterministic
 * `db:seed` usage records (see scripts/lib/seed-fixtures.ts).
 *
 * The snapshot aggregates the WHOLE usage_records table (deliberately no
 * userId conjunct), so on a shared local database it also folds in residue
 * from vitest integration runs. Assertions therefore pin only facts the seed
 * guarantees under any superset of usage rows: both seeded modalities appear,
 * text has data in every window, the ranking is non-empty, and the
 * selection-driven labels — never exact row counts, model names, or the
 * Others row, all of which shift with unrelated usage.
 */

test.describe('Public leaderboard', () => {
  test('renders seeded stats, switches windows, and is reachable from landing nav', async ({
    page,
  }) => {
    await page.goto('/welcome');
    await openMobileLandingMenuIfNeeded(page);
    // `.filter({ visible: true })` picks whichever of the two nav variants
    // (desktop nav or the now-open mobile drawer) is currently rendered;
    // the other lives in DOM but with `display: none` via Tailwind.
    await page.getByRole('link', { name: 'Leaderboard' }).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/leaderboard/);

    await expect(page.getByRole('heading', { name: 'Leaderboard', level: 1 })).toBeVisible();
    await waitForStatsSettled(page);
    // Settled AND ready: the seeded snapshot loaded with data (not the
    // unavailable branch, which is settled but never ready).
    await expect(statsReadyBoard(page)).toBeVisible();

    // Modality tabs come from the payload: the seed writes text + image usage.
    const modalityTabs = page.getByRole('group', { name: 'Modality' });
    await expect(modalityTabs.getByRole('button', { name: 'Text' })).toBeVisible();
    await expect(modalityTabs.getByRole('button', { name: 'Image' })).toBeVisible();

    // Window pills; the board defaults to the 30-day window.
    const windowPills = page.getByRole('group', { name: 'Window' });
    for (const name of ['7 days', '30 days', 'All time']) {
      await expect(windowPills.getByRole('button', { name })).toBeVisible();
    }
    await expect(windowPills.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Ranked list (the chart's text alternative): seeded text usage
    // guarantees at least one displayed model, and every row carries its
    // share percentage.
    const ranking = page.getByRole('list', { name: 'Model share ranking' });
    await expect(ranking.getByRole('listitem').first()).toBeVisible();
    await expect(ranking.getByRole('listitem').first()).toContainText('%');

    // Trend figure: its accessible name pins modality + window.
    await expect(page.getByRole('img', { name: /Model share for Text, 30 days/ })).toBeVisible();

    // Cost by model section with its per-message basis annotation.
    await expect(page.getByRole('heading', { name: 'Cost by model' })).toBeVisible();
    await expect(page.getByText('average per message')).toBeVisible();

    // Switch windows: aria-pressed moves and the trend chart re-labels for
    // the all-time window (its content, not just the pill, updated).
    await windowPills.getByRole('button', { name: 'All time' }).click();
    await expect(windowPills.getByRole('button', { name: 'All time' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(windowPills.getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(page.getByRole('img', { name: /Model share for Text, all time/ })).toBeVisible();
  });
});
