import { TEST_IDS } from '@hushbox/shared';
import { expect } from './expect.js';
import { requireEnv } from './env.js';
import type { NewsletterStatus } from '@hushbox/shared';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Newsletter helpers: the marketing signup interaction, the settings toggle,
 * and the dev read-backs (tokens, minted subscribers, the captured mailbox).
 * Raw selectors and dev-endpoint calls live here, never in specs (rule 3.3);
 * side effects are proven through these read-backs (rule 1.5).
 */

const API_BASE = requireEnv('VITE_API_URL');

/** The confirmation the signup island shows for every well-formed submit. */
export const NEWSLETTER_SIGNUP_DONE_TEXT = 'Check your inbox to confirm.';

/** The subject line of the double-opt-in confirmation email. */
export const NEWSLETTER_CONFIRM_SUBJECT = 'Confirm your subscription';

/** One subscriber row's live credentials, as the dev read-back projects it. */
export interface NewsletterTokens {
  readonly confirmToken: string | null;
  readonly unsubscribeToken: string;
  readonly status: NewsletterStatus;
}

/**
 * Dev read-back of a subscriber row's tokens + status. `null` when no row
 * exists yet — the signup POST is fire-and-forget behind the enumeration-safe
 * UI, so callers poll this until the row lands. Any status other than
 * 200/404 throws so a broken seam fails at the call site.
 */
export async function fetchNewsletterTokens(
  request: APIRequestContext,
  email: string
): Promise<NewsletterTokens | null> {
  const response = await request.get(
    `${API_BASE}/dev/newsletter/tokens/${encodeURIComponent(email)}`
  );
  if (response.status() === 404) return null;
  if (response.status() !== 200) {
    throw new Error(`dev newsletter token read-back failed: ${String(response.status())}`);
  }
  return (await response.json()) as NewsletterTokens;
}

/**
 * The subscriber row's status, or `'missing'` when no row exists yet — the
 * poll-friendly projection of {@link fetchNewsletterTokens}.
 */
export async function fetchNewsletterStatus(
  request: APIRequestContext,
  email: string
): Promise<NewsletterStatus | 'missing'> {
  const tokens = await fetchNewsletterTokens(request, email);
  return tokens === null ? 'missing' : tokens.status;
}

/** One minted precondition subscriber row (dev endpoint response shape). */
export interface MintedSubscriber {
  readonly id: string;
  readonly email: string;
  readonly unsubscribeToken: string;
  readonly confirmToken: string | null;
}

/**
 * Bulk-mint precondition subscriber rows via the dev endpoint. Emails are
 * unique per call (uuid-suffixed under `emailPrefix`), so parallel specs own
 * private rows.
 */
export async function mintSubscribers(
  request: APIRequestContext,
  options: {
    readonly count: number;
    readonly status?: NewsletterStatus;
    readonly emailPrefix?: string;
  }
): Promise<readonly MintedSubscriber[]> {
  const response = await request.post(`${API_BASE}/dev/newsletter/subscribers`, {
    data: options,
  });
  if (response.status() !== 200) {
    throw new Error(`dev newsletter subscriber mint failed: ${String(response.status())}`);
  }
  return ((await response.json()) as { subscribers: MintedSubscriber[] }).subscribers;
}

/** Mint exactly one subscriber row; throws when the mint came back empty. */
export async function mintOneSubscriber(
  request: APIRequestContext,
  options: { readonly status?: NewsletterStatus; readonly emailPrefix?: string }
): Promise<MintedSubscriber> {
  const [minted] = await mintSubscribers(request, { count: 1, ...options });
  if (minted === undefined) {
    throw new Error('dev newsletter subscriber mint returned no rows');
  }
  return minted;
}

/** One captured email's listing entry (`GET /dev/mailbox`). */
export interface MailboxEmail {
  readonly id: string;
  readonly to: string;
  readonly subject: string;
}

/** Every email the mock sender delivered, oldest first. */
export async function listMailbox(request: APIRequestContext): Promise<readonly MailboxEmail[]> {
  const response = await request.get(`${API_BASE}/dev/mailbox`);
  if (response.status() !== 200) {
    throw new Error(`dev mailbox list failed: ${String(response.status())}`);
  }
  return ((await response.json()) as { emails: MailboxEmail[] }).emails;
}

/** The captured emails delivered to `recipient` (optionally one subject). */
export async function fetchMailboxFor(
  request: APIRequestContext,
  recipient: string,
  subject?: string
): Promise<readonly MailboxEmail[]> {
  const emails = await listMailbox(request);
  return emails.filter(
    (email) => email.to === recipient && (subject === undefined || email.subject === subject)
  );
}

/** One captured email's raw HTML body (`GET /dev/mailbox/:id`). */
export async function fetchMailboxHtml(request: APIRequestContext, id: string): Promise<string> {
  const response = await request.get(`${API_BASE}/dev/mailbox/${encodeURIComponent(id)}`);
  if (response.status() !== 200) {
    throw new Error(`dev mailbox html fetch failed: ${String(response.status())}`);
  }
  return await response.text();
}

/** The visible label on the confirmation email's action button. */
export const NEWSLETTER_CONFIRM_LINK_LABEL = 'Confirm subscription';

/** The visible label on an issue email's footer unsubscribe link. */
export const NEWSLETTER_UNSUBSCRIBE_LINK_LABEL = 'Unsubscribe';

/** Decode the handful of HTML entities the email builder escapes into hrefs. */
function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

/** Collapse an anchor's inner HTML to its trimmed, tag-free visible text. */
function anchorText(inner: string): string {
  return decodeEntities(inner.replaceAll(/<[^>]*>/g, ''))
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * The href of the single anchor whose visible text equals `label`, with HTML
 * entities decoded back to a real URL. Throws unless exactly one anchor
 * matches — a template that drops, renames, or duplicates the action link
 * fails at extraction instead of silently passing a wrong-link assertion.
 */
export function extractEmailLinkByLabel(html: string, label: string): string {
  const anchor = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches: string[] = [];
  for (const [, href, inner] of html.matchAll(anchor)) {
    if (href !== undefined && inner !== undefined && anchorText(inner) === label) {
      matches.push(decodeEntities(href));
    }
  }
  const [only, ...rest] = matches;
  if (only === undefined || rest.length > 0) {
    throw new Error(
      `expected exactly one "${label}" link in email HTML, found ${String(matches.length)}`
    );
  }
  return only;
}

/**
 * The primary action link (`label`) from the newest captured email to
 * `recipient`, or `null` when no such email has been captured yet — the
 * poll-friendly projection callers gate on before extracting. A captured
 * email whose HTML lacks the expected link throws (via
 * {@link extractEmailLinkByLabel}), so a broken template fails loud rather
 * than polling to timeout.
 */
export async function fetchEmailActionLink(
  request: APIRequestContext,
  recipient: string,
  options: { readonly label: string; readonly subject?: string }
): Promise<string | null> {
  const emails = await fetchMailboxFor(request, recipient, options.subject);
  const latest = emails.at(-1);
  if (latest === undefined) return null;
  const html = await fetchMailboxHtml(request, latest.id);
  return extractEmailLinkByLabel(html, options.label);
}

/**
 * Fill and submit the marketing signup island, gating on the uniform done
 * state (the island shows it for every well-formed submit — the subscribe
 * POST itself is fire-and-forget, so persistence is proven by polling
 * {@link fetchNewsletterTokens}, never by this UI state).
 */
export async function submitNewsletterSignup(page: Page, email: string): Promise<void> {
  await page.getByTestId(TEST_IDS.newsletterSignupInput).fill(email);
  await page.getByTestId(TEST_IDS.newsletterSignupSubmit).click();
  await page.getByText(NEWSLETTER_SIGNUP_DONE_TEXT).waitFor({ state: 'visible' });
}

/**
 * Drive the Settings mailing-list switch to `subscribed`, gating on the
 * `PUT /newsletter/me` 200 and the switch settling on server truth (the
 * control always renders the response state, never optimistic local state).
 * Idempotent: an already-matching switch is left untouched, so the helper is
 * safe against state leaked by an earlier aborted run.
 */
export async function setMailingListToggle(page: Page, subscribed: boolean): Promise<void> {
  const toggle = page.getByTestId(TEST_IDS.settingsMailingListToggle);
  await expect(toggle).toBeEnabled();
  const current = await toggle.getAttribute('aria-checked');
  if (current !== String(subscribed)) {
    const updated = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname.endsWith('/newsletter/me') &&
        response.status() === 200
    );
    await toggle.click();
    await updated;
  }
  await expect(toggle).toHaveAttribute('aria-checked', String(subscribed));
}
