import { generateTotpCodeSync } from '@hushbox/crypto';
import { isMobileWidth, TEST_IDS } from '@hushbox/shared';
import { TEST_EMAIL_DOMAIN } from '../../packages/shared/src/constants.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { requireEnv } from './env.js';
import { waitForAppStable } from './page-signals.js';
import type { Page, APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/**
 * Fills the signup form and submits. Does NOT verify email.
 * After success, expects the "Check your email" confirmation.
 */
export async function signUpViaUI(
  page: Page,
  request: APIRequestContext,
  options: { username: string; email: string; password: string }
): Promise<void> {
  const submit = async (): Promise<void> => {
    await page.goto('/signup', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Username').fill(options.username);
    await page.getByLabel('Email').fill(options.email);
    await page.getByLabel('Password', { exact: true }).fill(options.password);
    await page.getByLabel('Confirm password').fill(options.password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Check your email').waitFor({ timeout: TIMEOUTS.ROUTE });
  };

  try {
    await submit();
  } catch {
    // A wrangler/workerd recycle under host saturation severs the in-flight
    // OPAQUE register call (the page stays on /signup with no confirmation). The
    // dev verify-token endpoint is the oracle: a committed register/finish
    // leaves the account and its verify token present even when the response was
    // severed, so accept that as success rather than re-submitting into the
    // unique-email constraint. If no account landed, the register never reached
    // commit, so a single fresh submit is safe.
    if (await accountExists(request, options.email)) return;
    await submit();
  }
}

/**
 * Calls the dev endpoint to get the email verification token, then navigates
 * to the verification URL. Returns the token.
 */
export async function verifyEmailViaAPI(
  request: APIRequestContext,
  page: Page,
  email: string
): Promise<string> {
  const response = await request.get(`${API_BASE}/dev/verify-token/${encodeURIComponent(email)}`);
  if (!response.ok()) {
    throw new Error(`Failed to get verify token for ${email}: ${String(response.status())}`);
  }
  const { token } = (await response.json()) as { token: string };
  await page.goto(`/verify?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Email verified' }).waitFor({ timeout: TIMEOUTS.ROUTE });
  return token;
}

/**
 * Fills the login form and submits. Waits for navigation to /chat.
 * Does NOT handle 2FA — use loginWithTOTP for 2FA users.
 */
export async function loginViaUI(
  page: Page,
  options: { email: string; password: string; keepSignedIn?: boolean }
): Promise<void> {
  const submit = async (): Promise<void> => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email or Username').fill(options.email);
    await page.getByLabel('Password', { exact: true }).fill(options.password);

    if (options.keepSignedIn) {
      await page.getByLabel('Keep me signed in').check();
    }

    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForURL('/chat', { timeout: TIMEOUTS.ROUTE });
  };

  try {
    await submit();
  } catch {
    // A wrangler/workerd recycle under host saturation severs the in-flight
    // OPAQUE login call, leaving the page on /login with no navigation. A login
    // carries no server-side state to collide with, so re-running it from a
    // fresh form is safe; one retry covers a single recycle window. This helper
    // is for expected-success logins only (failure-path tests drive the form
    // directly), so the broad catch is intentional — a genuine failure still
    // surfaces when the second attempt also fails to reach /chat.
    await submit();
  }
  // Login fires a non-awaited client navigation to /chat; waitForURL resolves on
  // URL commit, not when that navigation settles. Wait for the landing page's
  // stability signal so a caller's next hard navigation (reload/goto) can't race
  // and cancel the still-in-flight redirect.
  await waitForAppStable(page);
}

/**
 * Full signup + verify + login combo.
 */
export async function signUpAndVerify(
  page: Page,
  request: APIRequestContext,
  options: { username: string; email: string; password: string }
): Promise<void> {
  await signUpViaUI(page, request, options);
  await verifyEmailViaAPI(request, page, options.email);
  await loginViaUI(page, { email: options.email, password: options.password });
}

/**
 * True once a user row with a pending email-verify token exists for `email` —
 * i.e. register/finish committed. The request context retries a recycle drop on
 * its own, so the oracle survives saturation; a 404 (terminal) means no account
 * yet.
 */
async function accountExists(request: APIRequestContext, email: string): Promise<boolean> {
  const response = await request.get(`${API_BASE}/dev/verify-token/${encodeURIComponent(email)}`);
  return response.ok();
}

/**
 * Generates a TOTP code from a secret.
 */
export function generateTOTPCode(secret: string): string {
  return generateTotpCodeSync(secret);
}

/**
 * Generates a unique email for test isolation.
 * Format: {prefix}-{timestamp}-{random}@test.hushbox.ai
 */
export function uniqueEmail(prefix: string): string {
  const timestamp = Date.now();
  const random = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${String(timestamp)}-${hex}@${TEST_EMAIL_DOMAIN}`;
}

/**
 * Generates a unique canonical username for test isolation. Returns the
 * already-normalized form (lowercase, no spaces) so callers don't have to
 * think about USERNAME_REGEX (`/^[a-z][a-z0-9_]{2,19}$/`). Mirrors
 * `uniqueEmail`'s entropy recipe — without 4 bytes of random suffix,
 * parallel tests starting in the same millisecond collide on the
 * `users_username_unique` constraint and the /register/finish call fails.
 *
 * Output length: 3 (prefix) + 4 (timestamp) + 8 (hex) = 15 chars.
 */
export function uniqueUsername(prefix: string): string {
  const cleanPrefix =
    prefix
      .slice(0, 3)
      .toLowerCase()
      .replaceAll(/[^a-z]/g, '') || 'tst';
  const random = crypto.getRandomValues(new Uint8Array(4));
  const hex = [...random].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${cleanPrefix}${String(Date.now()).slice(-4)}${hex}`;
}

/**
 * Clears all auth-related rate limits via dev endpoint.
 * Call this in beforeEach to prevent rate limit failures across test runs.
 */
export async function clearAuthRateLimits(request: APIRequestContext): Promise<void> {
  await request.delete(`${API_BASE}/dev/auth-rate-limits`);
}

/**
 * Clears authenticated-user usage rate limits (chat stream, media download,
 * share creation) so consecutive E2E tests sharing a user don't saturate the
 * per-minute buckets. Excludes trial IP limits and IP-scoped anti-scraping
 * limits, which `trial-chat.spec.ts` and friends legitimately exercise.
 */
export async function clearUsageRateLimits(request: APIRequestContext): Promise<void> {
  await request.delete(`${API_BASE}/dev/usage-rate-limits`);
}

/**
 * Returns a TOTP code the server will accept now, even when a code was already
 * consumed earlier in the same 30-second window. Clears the user's replay
 * markers via the dev endpoint so the current code is no longer replay-blocked;
 * the server's replay check and crypto verification still run against it.
 */
export async function getAcceptableTOTPCode(
  request: APIRequestContext,
  email: string,
  secret: string
): Promise<string> {
  await request.delete(`${API_BASE}/dev/totp-replay`, { data: { email } });
  return generateTOTPCode(secret);
}

/**
 * Opens the main sidebar Sheet on mobile if it's not already visible.
 * On desktop viewports this is a no-op (sidebar is always rendered).
 */
export async function openMobileSidebarIfNeeded(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null || !isMobileWidth(viewport.width)) return;

  const sidebar = page.getByTestId(TEST_IDS.sidebar);
  if (await sidebar.isVisible()) return;

  await page.getByTestId(TEST_IDS.hamburgerButton).click();
  await sidebar.waitFor({ state: 'visible' });
}

/**
 * Logs out via the sidebar footer dropdown menu.
 * Clicks the sidebar trigger → "Log Out" → waits for /login.
 */
export async function logoutViaUI(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.sidebarTrigger).click();
  await page.getByTestId(TEST_IDS.menuLogout).click();
  await page.waitForURL('/login', { timeout: TIMEOUTS.ROUTE });
}

/**
 * Navigates to settings via the sidebar footer dropdown menu.
 * Clicks the sidebar trigger → "Settings" → waits for /settings.
 */
export async function navigateToSettings(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.sidebarTrigger).click();
  await page.getByTestId(TEST_IDS.menuSettings).click();
  await page.waitForURL('/settings', { timeout: TIMEOUTS.ROUTE });
}

/**
 * Navigates to usage via the sidebar footer dropdown menu.
 * Clicks the sidebar trigger → "Usage" → waits for /usage.
 */
export async function navigateToUsage(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.sidebarTrigger).click();
  await page.getByTestId(TEST_IDS.menuUsage).click();
  await page.waitForURL('/usage', { timeout: TIMEOUTS.ROUTE });
}
