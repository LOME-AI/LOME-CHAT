import { test } from './fixtures.js';
import { expect } from './helpers/expect.js';
import { navigateToSettings } from './helpers/auth.js';
import { personaEmail } from './helpers/personas.js';
import {
  fetchMailboxFor,
  fetchNewsletterStatus,
  NEWSLETTER_CONFIRM_SUBJECT,
  setMailingListToggle,
} from './helpers/newsletter.js';
import { waitForAppStable } from './helpers/page-signals.js';
import { TIMEOUTS } from './config/timeouts.js';

/**
 * The Settings mailing-list toggle, one journey: on → proven subscribed with
 * NO confirmation round-trip (the account email is already verified, so
 * toggle-on subscribes instantly) → off → proven unsubscribed. Both state
 * changes are proven via the dev token read-back and the captured mailbox
 * (rule 1.5), not the switch alone. Uses the per-project persona, so parallel
 * browser projects touch disjoint rows; the journey ends unsubscribed, and
 * the toggle helper is start-state-agnostic, so a leaked prior state never
 * breaks the run.
 */
test.describe('Newsletter settings toggle', () => {
  test('toggling the mailing list on subscribes instantly without a confirmation email, and off unsubscribes', async ({
    authenticatedPage,
    request,
  }) => {
    const email = personaEmail('test-alice');

    await authenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(authenticatedPage);
    await navigateToSettings(authenticatedPage);

    // On: server truth flips to subscribed…
    await setMailingListToggle(authenticatedPage, true);
    await expect
      .poll(async () => fetchNewsletterStatus(request, email), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe('subscribed');
    // …and no double-opt-in confirmation was ever sent for the account email.
    expect(await fetchMailboxFor(request, email, NEWSLETTER_CONFIRM_SUBJECT)).toHaveLength(0);

    // Off: converges on unsubscribed.
    await setMailingListToggle(authenticatedPage, false);
    await expect
      .poll(async () => fetchNewsletterStatus(request, email), {
        timeout: TIMEOUTS.API_SETUP,
      })
      .toBe('unsubscribed');
  });
});
