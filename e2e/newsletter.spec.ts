import { test } from './fixtures.js';
import { expect } from './helpers/expect.js';
import { uniqueEmail } from './helpers/auth.js';
import {
  fetchNewsletterStatus,
  fetchNewsletterTokens,
  submitNewsletterSignup,
} from './helpers/newsletter.js';
import { waitForNewsletterReady } from './helpers/page-signals.js';
import { TIMEOUTS } from './config/timeouts.js';

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

    // 2. Confirm: the landing page fires the token POST on load and reveals
    // the success headline only once the API committed.
    await page.goto(`/newsletter/confirmed?token=${String(firstConfirmToken)}`, {
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
