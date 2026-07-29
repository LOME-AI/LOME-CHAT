import { TTS_MODEL_HOST } from '@hushbox/shared';

import { test, expectConsoleErrors } from './fixtures.js';
import { TIMEOUTS } from './config/timeouts.js';
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
    await page.route(`${TTS_MODEL_HOST}/**`, (route) => route.fulfill({ status: 204, body: '' }));

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

/**
 * The one place anything clicks the blog's "Listen" control, and the only test
 * that runs the BUILT text-to-speech worker. Unit tests inject a fake worker
 * factory, so the real worker bundle never executes under them — which is how
 * a bundler transform that rewrote `new.target` shipped: it killed the worker
 * the moment its module evaluated, before a single model byte arrived, and
 * surfaced only as an error line about half a second after the click. Nothing
 * caught it because nothing had ever clicked. Only the built site can catch it
 * either: the dev server hands the worker over as a native ES module and never
 * applies the transform.
 *
 * The proof is a positive signal rather than an elapsed one. The worker's first
 * model-file request can only be issued after the worker was constructed, its
 * whole module graph (kokoro-js and the ONNX runtime) evaluated, and its
 * message handler took delivery of the load — a worker that dies on load never
 * reaches it. That request is then held open, so the ~90 MB model never
 * downloads and the load stays in the one state under test: still running, not
 * failed. Playback is deliberately out of scope; this guards the load, and
 * waiting for audio would mean paying for the model on every run.
 */
test.describe('Blog Listen control', () => {
  test('starts an on-device read from the built worker', async ({ page }) => {
    // Hold the model request open — never fulfilled, never aborted. Aborting
    // would fail the load and produce exactly the error this test asserts the
    // absence of; fulfilling it would need the model. Page routes take priority
    // over the network-allowlist guard's context route, so this also keeps the
    // request off the wire and the test offline.
    let modelRequested = false;
    await page.route(`${TTS_MODEL_HOST}/**`, () => {
      modelRequested = true;
    });

    await page.goto('/blog');
    // Each post card is a link wrapping the post's title heading; which post is
    // read aloud does not matter, so the first one keeps this off any slug.
    const firstPost = page
      .getByRole('link')
      .filter({ has: page.getByRole('heading', { level: 3 }) })
      .first();
    await firstPost.click();

    // The island renders its controls disabled in the server markup and enables
    // them on hydration, so "enabled" is the readiness signal to wait on. A
    // click before that lands on markup with no handler attached and does
    // nothing, which would read here as a dead worker.
    const listen = page.getByRole('button', { name: 'Listen to this post' });
    await expect(listen).toBeEnabled();
    await listen.click();

    // Left idle: the transport is one button, relabelled per state.
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();

    await expect.poll(() => modelRequested, { timeout: TIMEOUTS.TTS_WORKER_BOOT }).toBe(true);

    // ...and no error status arrived on the way there. The load is now parked
    // on the held request, so nothing further can fail it.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(stop).toBeVisible();

    // End the read through the UI instead of leaving it to context teardown, so
    // the control is shown to recover rather than merely to start.
    await stop.click();
    await expect(listen).toBeVisible();
  });
});
