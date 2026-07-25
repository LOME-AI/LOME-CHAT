import { test, expectConsoleErrors } from './fixtures.js';
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

/**
 * Guards the Content-Security-Policy the on-device TTS model download runs
 * under. The engine (chat read-aloud and the blog "Listen" control) fetches
 * model files from `https://huggingface.co`; without it in `connect-src` the
 * first download is CSP-blocked in production. `vite preview` serves the real
 * generated `_headers` CSP (via `scripts/lib/headers-vite-plugin.ts`), so this
 * asserts genuine browser enforcement — no model download, no network egress:
 * a disallowed host must raise a `securitypolicyviolation`, the Hugging Face
 * host must not.
 */
test.describe('TTS model-download CSP', () => {
  test('blocks an unknown connect-src host but allows Hugging Face', async ({ page }) => {
    // The deliberate blocked fetch logs a CSP console error; opt this test out
    // of the console-error auto-fail for exactly that message.
    expectConsoleErrors(page, [/Refused to connect|Content Security Policy/i]);

    // The Hugging Face probe is CSP-allowed, so the browser would egress it —
    // the network-allowlist guard fails on real external requests. Fulfill it
    // locally (page routes take priority over the guard's context route) so the
    // probe stays offline and never depends on Hugging Face being reachable.
    await page.route('https://huggingface.co/**', (route) =>
      route.fulfill({ status: 204, body: '' })
    );

    // Record every CSP violation the page raises, installed before navigation.
    await page.addInitScript(() => {
      (globalThis as unknown as { __cspBlocked: string[] }).__cspBlocked = [];
      globalThis.addEventListener('securitypolicyviolation', (event) => {
        (globalThis as unknown as { __cspBlocked: string[] }).__cspBlocked.push(event.blockedURI);
      });
    });

    await page.goto('/welcome');

    // `blocked.invalid` is not in `connect-src`: the browser blocks the fetch at
    // CSP (before any network request) and raises a violation. `huggingface.co`
    // is in `connect-src`: it is permitted, so it raises no violation.
    await page.evaluate(async () => {
      await fetch('https://blocked.invalid/probe', { mode: 'no-cors' }).catch(() => null);
      await fetch('https://huggingface.co/probe', { mode: 'no-cors' }).catch(() => null);
    });

    await expect
      .poll(() =>
        page.evaluate(() => (globalThis as unknown as { __cspBlocked: string[] }).__cspBlocked)
      )
      .toEqual(expect.arrayContaining([expect.stringContaining('blocked.invalid')]));

    const blocked = await page.evaluate(
      () => (globalThis as unknown as { __cspBlocked: string[] }).__cspBlocked
    );
    expect(blocked.some((uri) => uri.includes('huggingface.co'))).toBe(false);
  });
});
