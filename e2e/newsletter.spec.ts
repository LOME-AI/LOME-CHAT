import { ROUTES } from '@hushbox/shared';
import { test } from './fixtures.js';
import { expect } from './helpers/expect.js';
import { uniqueEmail } from './helpers/auth.js';
import { requireEnv } from './helpers/env.js';
import {
  NEWSLETTER_CONFIRM_LINK_LABEL,
  NEWSLETTER_CONFIRM_SUBJECT,
  fetchEmailActionLink,
  fetchNewsletterStatus,
  fetchNewsletterTokens,
  submitNewsletterSignup,
} from './helpers/newsletter.js';
import { waitForNewsletterReady } from './helpers/page-signals.js';
import { TIMEOUTS } from './config/timeouts.js';

/**
 * The configured marketing origin. In e2e web+marketing are served MERGED at
 * the Playwright baseURL, but MARKETING_URL resolves to the standalone Astro
 * origin — which the e2e stack does NOT serve. The email link's host is
 * asserted against this value (Problem B: the human link points at the
 * marketing origin, never the API or a bare path); navigation then rebases the
 * extracted path onto baseURL, the origin e2e actually serves.
 */
const MARKETING_ORIGIN = new URL(requireEnv('MARKETING_URL')).origin;

/**
 * The public double-opt-in lifecycle, one journey: signup on the marketing
 * /newsletter page → confirm via the emailed token's landing page →
 * unsubscribe via the goodbye page → re-signup with the same address. Every
 * UI step's persistence is proven through the dev token read-back (rule 1.5);
 * the signup UI itself is deliberately uniform (enumeration-safe), so the
 * read-back is polled — the subscribe POST is fire-and-forget behind the
 * done state. A unique email per run keeps parallel projects isolated.
 */
test.describe('Newsletter public lifecycle', () => {
  test('signup, confirm, unsubscribe, and re-signup issue fresh credentials at each step', async ({
    page,
    request,
  }) => {
    const email = uniqueEmail('news');

    // 1. Signup on the marketing page (island hydration-gated).
    await page.goto('/newsletter', { waitUntil: 'domcontentloaded' });
    await waitForNewsletterReady(page);
    await submitNewsletterSignup(page, email);

    // Persistence: the pending row lands with a live confirm token.
    await expect
      .poll(async () => fetchNewsletterStatus(request, email), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe('pending');
    const pending = await fetchNewsletterTokens(request, email);
    expect(pending).not.toBeNull();
    const firstConfirmToken = pending?.confirmToken;
    expect(firstConfirmToken).not.toBeNull();
    const unsubscribeToken = pending?.unsubscribeToken ?? '';
    expect(unsubscribeToken).not.toBe('');

    // 2. Follow the ACTUAL confirmation email. Poll the mailbox for the
    // captured double-opt-in email to this run's address and extract the
    // confirm button's href — never a hard-coded path (that is what let the
    // pre-B2 `/newsletter/confirm` API-verb link ship a 404 unnoticed).
    let confirmHref = '';
    await expect
      .poll(
        async () => {
          confirmHref =
            (await fetchEmailActionLink(request, email, {
              label: NEWSLETTER_CONFIRM_LINK_LABEL,
              subject: NEWSLETTER_CONFIRM_SUBJECT,
            })) ?? '';
          return confirmHref;
        },
        { timeout: TIMEOUTS.MAILBOX_DELIVERY }
      )
      .not.toBe('');

    // Path + host correctness of the email link: it targets the real
    // confirmed PAGE (not the API verb) on the marketing origin (not the API
    // origin, not a bare path), carrying this row's confirm token.
    const confirmUrl = new URL(confirmHref);
    expect(confirmUrl.pathname).toBe(ROUTES.NEWSLETTER_CONFIRMED);
    expect(confirmUrl.origin).toBe(MARKETING_ORIGIN);
    expect(confirmUrl.searchParams.get('token')).toBe(firstConfirmToken);

    // The marketing origin is not served in e2e (web+marketing are merged at
    // baseURL), so rebase the verified path+query onto baseURL to actually
    // load the confirmed page; it fires the token POST on load and reveals the
    // success headline only once the API committed.
    await page.goto(`${confirmUrl.pathname}${confirmUrl.search}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: /You're on the list\./ })).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
    expect(await fetchNewsletterStatus(request, email)).toBe('subscribed');

    // 3. Unsubscribe via the goodbye page, same success-implies-committed gate.
    await page.goto(`/newsletter/unsubscribed?token=${unsubscribeToken}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: /You're unsubscribed\./ })).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
    expect(await fetchNewsletterStatus(request, email)).toBe('unsubscribed');

    // 4. Re-signup with the SAME address: the row reopens to pending with a
    // FRESH confirm token (fresh consent evidence, new double-opt-in round).
    await page.goto('/newsletter', { waitUntil: 'domcontentloaded' });
    await waitForNewsletterReady(page);
    await submitNewsletterSignup(page, email);
    await expect
      .poll(async () => fetchNewsletterStatus(request, email), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe('pending');
    const reopened = await fetchNewsletterTokens(request, email);
    expect(reopened?.confirmToken).not.toBeNull();
    expect(reopened?.confirmToken).not.toBe(firstConfirmToken);
  });
});
