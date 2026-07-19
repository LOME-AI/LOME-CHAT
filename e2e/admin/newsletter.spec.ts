import { NEWSLETTER_POSTAL_ADDRESS, ROUTES, TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from '../helpers/env.js';
import { allowExternalHosts, expectConsoleErrors } from '../fixtures.js';
import { test, expect } from './fixtures.js';
import {
  NEWSLETTER_UNSUBSCRIBE_LINK_LABEL,
  extractEmailLinkByLabel,
  fetchMailboxFor,
  fetchMailboxHtml,
  mintOneSubscriber,
  mintSubscribers,
} from '../helpers/newsletter.js';
import {
  fetchIssueStatus,
  fillCompose,
  issueRow,
  openNewsletterScreen,
  previewFrame,
  requireIssue,
  utcDatetimeLocalFromNow,
} from './helpers/newsletter.js';
import {
  executeAndAwaitResult,
  expectPreviewDiff,
  fillOpForm,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import type { Page } from '@playwright/test';

/**
 * The configured marketing origin. The issue email's VISIBLE unsubscribe link
 * points a browser at the marketing goodbye page on this origin — never the
 * API verb route. (The RFC 8058 one-click `List-Unsubscribe` HEADER does target
 * the API route, but the dev mailbox exposes only rendered HTML, not headers,
 * so that split is pinned by the `issue-email` unit test, not here.)
 */
const MARKETING_ORIGIN = new URL(requireEnv('MARKETING_URL')).origin;

/**
 * Lead the schedule aims ahead of now. It must outlast the OpModal round
 * trip (the schedule op refuses non-future instants at BOTH preview and
 * execute) while keeping the dispatch poll inside JOB_DISPATCH.
 */
const SCHEDULE_LEAD_MS = 45_000;

/** A schedule far enough out that dispatch can never begin mid-test. */
const FAR_FUTURE_MS = 6 * 60 * 60 * 1000;

/** Run the seeded OpModal (form → preview diff → execute → result → close). */
async function runSeededOp(page: Page): Promise<string> {
  await expect(page.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({ timeout: TIMEOUTS.MODAL });
  await submitOpForm(page);
  await expectPreviewDiff(page);
  await executeAndAwaitResult(page);
  const auditId = await readAuditId(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);
  return auditId;
}

/**
 * The newsletter issue lifecycle on the REAL jobs system. Preconditions are
 * minted via dev endpoints under unique prefixes (rule 4.2), the audience
 * assertions are per-address (the dispatch audience is global-by-design —
 * every subscribed row, including other parallel tests' throwaway rows —
 * so per-address exactness, not a global sent total, is the deterministic
 * invariant), and every side effect is proven via API read-backs and the
 * captured mailbox (rule 1.5).
 */
test.describe('Admin newsletter lifecycle', () => {
  test('a scheduled issue dispatches to exactly the subscribed audience with a compliant footer', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // Compose + OpModal + a real dispatch wait: wider than LONG.
    test.setTimeout(TIMEOUTS.XXLONG);
    const api = await adminApi();
    const runTag = crypto.randomUUID().slice(0, 8);
    const subscribed = await mintSubscribers(request, {
      count: 3,
      emailPrefix: `nl-sub-${runTag}`,
    });
    const unsubscribed = await mintOneSubscriber(request, {
      status: 'unsubscribed',
      emailPrefix: `nl-un-${runTag}`,
    });
    const suppressed = await mintOneSubscriber(request, {
      status: 'suppressed',
      emailPrefix: `nl-sup-${runTag}`,
    });
    const subject = `E2E issue ${runTag}`;

    // The email base template deliberately links its display font from
    // fonts.googleapis.com (mail clients fetch it); the preview iframe
    // renders that HTML verbatim, so the font CSS and its woff2 second hop
    // (fonts.gstatic.com) are this screen's one legitimate external edge —
    // sanctioned opt-in, called before the navigation that renders the
    // preview.
    allowExternalHosts(adminPage, ['fonts.googleapis.com', 'fonts.gstatic.com']);
    // The preview iframe is `sandbox=""` (scripts blocked by design); the
    // harness's own per-frame injected script is refused there and Chromium
    // logs the refusal. The sandbox doing its job, never an app fault — the
    // rendered email HTML itself carries zero scripts (verified server-side).
    expectConsoleErrors(adminPage, [/Blocked script execution in 'about:srcdoc'/]);

    // 1. Compose. The live preview pane renders the DISPATCH-PATH email (the
    // server template, never a client render) into the sandboxed iframe.
    await openNewsletterScreen(adminPage);
    await fillCompose(adminPage, {
      subject,
      bodyMarkdown: `Hello from the e2e dispatch run ${runTag}.`,
      scheduledAtLocal: utcDatetimeLocalFromNow(SCHEDULE_LEAD_MS),
      reason: `e2e newsletter dispatch ${runTag}`,
    });
    await expect(previewFrame(adminPage)).toHaveAttribute('srcdoc', new RegExp(subject), {
      timeout: TIMEOUTS.ASSERT,
    });

    // 2. Schedule through the OpModal grammar; the audit row id is readable
    // on the result step (the effect and its audit committed together).
    await adminPage.getByTestId(TEST_IDS.adminNewsletterSchedule).click();
    const auditId = await runSeededOp(adminPage);
    expect(auditId).not.toBe('');

    // 3. The REAL dispatcher claims the job once scheduledAt passes; poll the
    // admin issues read until the issue is terminal-sent.
    await expect
      .poll(async () => fetchIssueStatus(api, subject), {
        timeout: TIMEOUTS.JOB_DISPATCH,
      })
      .toBe('sent');
    const issue = await requireIssue(api, subject);
    expect(issue.sentAt).not.toBeNull();
    // The frozen audience includes every globally subscribed row; this run's
    // three are the lower bound, and none failed among them (per-address
    // mailbox exactness below is the authoritative delivery proof).
    expect(issue.recipientCount).toBeGreaterThanOrEqual(3);
    expect(issue.sentCount).toBeGreaterThanOrEqual(3);

    // 4. Mailbox truth: exactly ONE issue email per subscribed address,
    // ZERO for the unsubscribed and suppressed addresses.
    for (const target of subscribed) {
      expect(await fetchMailboxFor(request, target.email, subject)).toHaveLength(1);
    }
    expect(await fetchMailboxFor(request, unsubscribed.email)).toHaveLength(0);
    expect(await fetchMailboxFor(request, suppressed.email)).toHaveLength(0);

    // 5. Compliance footer in the delivered HTML: the postal address line and
    // the personalized VISIBLE unsubscribe link. The link resolves to the
    // marketing goodbye PAGE (ROUTES.NEWSLETTER_UNSUBSCRIBED on the marketing
    // origin) carrying the recipient's own token — never the API verb route
    // (that mismatch shipped a 404 before B2); the one-click header's API
    // target is unit-pinned (see MARKETING_ORIGIN note above).
    const firstTarget = subscribed[0];
    if (firstTarget === undefined) throw new Error('minted subscriber list was empty');
    const [delivered] = await fetchMailboxFor(request, firstTarget.email, subject);
    if (delivered === undefined) throw new Error('delivered issue email vanished from mailbox');
    const html = await fetchMailboxHtml(request, delivered.id);
    expect(html).toContain(NEWSLETTER_POSTAL_ADDRESS);
    const unsubscribeUrl = new URL(
      extractEmailLinkByLabel(html, NEWSLETTER_UNSUBSCRIBE_LINK_LABEL)
    );
    expect(unsubscribeUrl.pathname).toBe(ROUTES.NEWSLETTER_UNSUBSCRIBED);
    expect(unsubscribeUrl.origin).toBe(MARKETING_ORIGIN);
    expect(unsubscribeUrl.searchParams.get('token')).toBe(firstTarget.unsubscribeToken);
  });

  test('canceling a scheduled issue before dispatch leaves the mailbox untouched', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // Two OpModal round trips (schedule + cancel): wider than LONG.
    test.setTimeout(TIMEOUTS.XLONG);
    const api = await adminApi();
    const runTag = crypto.randomUUID().slice(0, 8);
    const audience = await mintOneSubscriber(request, { emailPrefix: `nl-cxl-${runTag}` });
    const subject = `E2E canceled issue ${runTag}`;

    // Same sanctioned opt-in as the dispatch test: the preview iframe's email
    // HTML links its font (CSS + woff2 hop) from Google Fonts by design.
    allowExternalHosts(adminPage, ['fonts.googleapis.com', 'fonts.gstatic.com']);
    // The preview iframe is `sandbox=""` (scripts blocked by design); the
    // harness's own per-frame injected script is refused there and Chromium
    // logs the refusal. The sandbox doing its job, never an app fault — the
    // rendered email HTML itself carries zero scripts (verified server-side).
    expectConsoleErrors(adminPage, [/Blocked script execution in 'about:srcdoc'/]);

    // 1. Schedule far in the future — dispatch cannot begin during the test.
    await openNewsletterScreen(adminPage);
    await fillCompose(adminPage, {
      subject,
      bodyMarkdown: `This issue must never send (${runTag}).`,
      scheduledAtLocal: utcDatetimeLocalFromNow(FAR_FUTURE_MS),
      reason: `e2e newsletter cancel setup ${runTag}`,
    });
    await adminPage.getByTestId(TEST_IDS.adminNewsletterSchedule).click();
    await runSeededOp(adminPage);

    // 2. Cancel from the issue's row action (a fresh load shows server truth;
    // the row action seeds the OpModal with the issue id).
    await openNewsletterScreen(adminPage);
    const row = issueRow(adminPage, subject);
    await expect(row).toHaveCount(1);
    await row.getByTestId(TEST_IDS.adminNewsletterCancel).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await fillOpForm(adminPage, { reason: `e2e newsletter cancel ${runTag}` });
    await runSeededOp(adminPage);

    // 3. API truth: the issue is canceled (a dead job claim-guards dispatch),
    // and the audience address never received anything.
    const issue = await requireIssue(api, subject);
    expect(issue.status).toBe('canceled');
    expect(issue.canceledAt).not.toBeNull();
    expect(await fetchMailboxFor(request, audience.email)).toHaveLength(0);
  });
});
