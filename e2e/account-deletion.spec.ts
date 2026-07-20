import { test, expect, expectApiErrors, expectConsoleErrors } from './fixtures.js';
import { LoginPage, SettingsPage, TwoFactorSetupModal, ChatPage } from './pages/index.js';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  navigateToSettings,
  clearAuthRateLimits,
  getAcceptableTOTPCode,
} from './helpers/auth.js';
import { requireEnv } from './helpers/env.js';
import { openShareModalForMessage } from './helpers/share-message.js';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from './config/timeouts.js';
import type { Page, APIRequestContext, Locator, Response as WireResponse } from './fixtures.js';

const apiUrl = requireEnv('VITE_API_URL');
const FRESH_PASSWORD = 'TestPassword123!';

// Post-delete redirect to ROUTES.MARKETING. Gate on waitForURL, not the
// settled indicator, which can read true mid-navigation.
//
// TanStack Query's pending refetch of `/billing/balance` can land after
// the iron-session cookie has been cleared and 401 with NOT_AUTHENTICATED
// before user-only providers unmount. Anchor on `$` so the leaf endpoint
// match can't accidentally mask a 401 on a different `/billing/...` route.
async function expectRedirectedToMarketing(page: Page): Promise<void> {
  expectApiErrors(page, [
    /401 Unauthorized GET .*\/billing\/balance$/m,
    /"code":"NOT_AUTHENTICATED"/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: the server responded with a status of 401/]);
  await page.waitForURL(new RegExp(ROUTES.MARKETING), { timeout: TIMEOUTS.ROUTE });
}

interface FreshUser {
  email: string;
  username: string;
  password: string;
}

async function provisionFreshUser(
  page: Page,
  request: APIRequestContext,
  prefix: string
): Promise<FreshUser> {
  const email = uniqueEmail(prefix);
  const username = uniqueUsername(prefix);
  await signUpAndVerify(page, request, { username, email, password: FRESH_PASSWORD });
  return { email, username, password: FRESH_PASSWORD };
}

/**
 * The delete-account password input is an HTML `id` (no associated label or
 * test-id), so it must be targeted by id.
 */
function deleteAccountPasswordField(page: Page): Locator {
  // eslint-disable-next-line playwright/no-raw-locators -- HTML id input; no semantic role/label/test-id to target
  return page.locator('#delete-account-password');
}

async function seedWalletBalance(
  request: APIRequestContext,
  email: string,
  balance: string
): Promise<void> {
  const response = await request.post(`${apiUrl}/dev/wallet-balance`, {
    data: { email, walletType: 'purchased', balance },
  });
  if (!response.ok()) {
    throw new Error(`Failed to seed wallet balance for ${email}: ${String(response.status())}`);
  }
}

async function enableTwoFactorViaUI(page: Page): Promise<string> {
  await navigateToSettings(page);
  const settingsPage = new SettingsPage(page);
  await settingsPage.openTwoFactor();

  const setupModal = new TwoFactorSetupModal(page);
  await setupModal.start();
  const secret = await setupModal.waitForSecret();
  await setupModal.continueToVerify();

  const code = generateTOTPCode(secret);
  await setupModal.enterCode(code);
  await setupModal.verify();
  await setupModal.expectSuccess();
  await setupModal.done();

  return secret;
}

function modalLocator(page: Page): Locator {
  return page.getByTestId(TEST_IDS.deleteAccountModal);
}

async function openDeleteAccountModal(page: Page): Promise<Locator> {
  await navigateToSettings(page);
  await page.getByTestId(TEST_IDS.deleteAccountTrigger).click();
  const modal = modalLocator(page);
  await expect(modal).toBeVisible();
  return modal;
}

async function continueFromIntro(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.deleteAccountIntroContinue).click();
}

async function continueFromWallet(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox).click();
  await page.getByTestId(TEST_IDS.deleteAccountWalletContinue).click();
}

async function advanceThroughIntroAndWallet(page: Page): Promise<void> {
  await continueFromIntro(page);
  // The wallet/forfeit step renders only for a user with a non-zero balance;
  // otherwise intro advances straight to the password step. Both are
  // deterministic end-states, so wait for whichever lands before branching —
  // reading forfeit visibility point-in-time would race the React transition
  // and silently skip the required forfeit step for a user with credits.
  const forfeit = page.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox);
  const passwordField = deleteAccountPasswordField(page);
  await expect(forfeit.or(passwordField)).toBeVisible();
  if (await forfeit.isVisible()) {
    await forfeit.click();
    await page.getByTestId(TEST_IDS.deleteAccountWalletContinue).click();
  }
}

async function submitPasswordStep(page: Page, password: string): Promise<void> {
  await deleteAccountPasswordField(page).fill(password);
  const initWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/init') && response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountPasswordContinue).click();
  await initWait;
}

async function typeConfirmationAndDelete(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.deleteAccountConfirmationInput).fill('delete my account');
  const finishWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/finish') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
  const finishResponse = await finishWait;
  expect(finishResponse.status()).toBe(204);
}

/**
 * Drives one full modal pass — correct password, wrong TOTP (`000000`), exact
 * confirmation phrase — and returns the `/finish` response. The correct
 * password is required to reach `/finish` at all (the OPAQUE client throws on
 * a wrong one right after `/init`); the wrong TOTP is what makes the attempt
 * fail server-side after the lockout slot has been reserved.
 */
async function submitFinishWithWrongTotp(page: Page, password: string): Promise<WireResponse> {
  await openDeleteAccountModal(page);
  await advanceThroughIntroAndWallet(page);
  await submitPasswordStep(page, password);

  const otpInput = page.getByTestId(TEST_IDS.otpInput);
  await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  await otpInput.pressSequentially('000000');
  await page.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

  await page.getByTestId(TEST_IDS.deleteAccountConfirmationInput).fill('delete my account');
  const finishWait = page.waitForResponse(
    (response) =>
      response.url().includes('/auth/account/delete/finish') &&
      response.request().method() === 'POST'
  );
  await page.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
  return finishWait;
}

test.describe('Account deletion', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test.describe('Happy path: no 2FA', () => {
    test('signed-up user deletes account and is redirected to marketing root', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-no2fa');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);

      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(/login failed/i);
    });
  });

  test.describe('Happy path: with 2FA', () => {
    test('user with 2FA enters TOTP then deletes account', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-2fa');
      const secret = await enableTwoFactorViaUI(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const totpCode = await getAcceptableTOTPCode(request, user.email, secret);
      const otpInput = unauthenticatedPage.getByTestId(TEST_IDS.otpInput);
      await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await otpInput.pressSequentially(totpCode);
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      await unauthenticatedPage.goto('/login', { waitUntil: 'domcontentloaded' });
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.login(user.email, user.password);
      await loginPage.expectError(/login failed/i);
    });
  });

  test.describe('Wallet forfeit step', () => {
    test('non-zero balance surfaces forfeit step and gates Continue on the checkbox', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wallet');
      await seedWalletBalance(request, user.email, '5.00');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);

      const forfeit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountForfeitCheckbox);
      const continueButton = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountWalletContinue);

      await expect(forfeit).toBeVisible();
      await expect(unauthenticatedPage.getByText('$5.00').first()).toBeVisible();
      await expect(continueButton).toBeDisabled();

      await forfeit.click();
      await expect(continueButton).toBeEnabled();
      await continueButton.click();

      await expect(deleteAccountPasswordField(unauthenticatedPage)).toBeVisible();
    });
  });

  test.describe('Back button', () => {
    test('back navigates through previous steps and is hidden on intro', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-back');
      await seedWalletBalance(request, user.email, '3.00');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });

      await openDeleteAccountModal(unauthenticatedPage);
      // The Back button is rendered by OverlayNavButtons as a sibling of
      // OverlayContent (which carries the `delete-account-modal` testid),
      // so we scope to the dialog itself, not the modal's content wrapper.
      const backButton = unauthenticatedPage
        .getByRole('dialog', { name: 'Delete account' })
        .getByRole('button', { name: 'Back' });

      await expect(backButton).toHaveCount(0);

      await continueFromIntro(unauthenticatedPage);
      await expect(unauthenticatedPage.getByText('$3.00').first()).toBeVisible();
      await expect(backButton).toBeVisible();

      await continueFromWallet(unauthenticatedPage);
      await expect(deleteAccountPasswordField(unauthenticatedPage)).toBeVisible();

      await backButton.click();
      await expect(unauthenticatedPage.getByText('$3.00').first()).toBeVisible();

      await backButton.click();
      await expect(
        unauthenticatedPage.getByRole('heading', { name: /delete your account/i })
      ).toBeVisible();
      await expect(backButton).toHaveCount(0);
    });
  });

  test.describe('Shared content after deletion', () => {
    test('shared message link returns an error once the owner deletes their account', async ({
      unauthenticatedPage,
      createPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-share');

      const convResponse = await request.post(`${apiUrl}/dev/conversation`, {
        data: {
          ownerEmail: user.email,
          messages: [
            { content: 'Hello, please share this', senderType: 'user' },
            { content: 'Echo: sharing this assistant reply', senderType: 'ai' },
          ],
        },
      });
      expect(convResponse.ok()).toBe(true);
      const { conversationId } = (await convResponse.json()) as { conversationId: string };

      const chatPage = new ChatPage(unauthenticatedPage);
      await chatPage.gotoConversation(conversationId);
      await chatPage.waitForConversationLoaded();

      const aiMessage = chatPage.messagesByRole('assistant').first();
      const shareModal = await openShareModalForMessage(unauthenticatedPage, aiMessage);
      await expect(shareModal).toBeVisible();
      await unauthenticatedPage.getByTestId(TEST_IDS.shareMessageCreateButton).click();

      const urlEl = unauthenticatedPage.getByTestId(TEST_IDS.shareMessageUrl);
      await expect(urlEl).toBeVisible();
      const shareUrl = (await urlEl.textContent()) ?? '';
      expect(shareUrl).toContain('/share/m/');
      await unauthenticatedPage.keyboard.press('Escape');

      const guestBeforeDelete = await createPage();
      await guestBeforeDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestBeforeDelete.getByTestId(TEST_IDS.sharedMessageLoading)).not.toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
      await expect(guestBeforeDelete.getByTestId(TEST_IDS.sharedMessageError)).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await typeConfirmationAndDelete(unauthenticatedPage);
      await expectRedirectedToMarketing(unauthenticatedPage);

      const guestAfterDelete = await createPage();
      // Deliberate: this test asserts the share URL surfaces an error to a
      // guest once the owner deletes their account. The guest's GET against
      // the share endpoint resolves to 404 SHARE_NOT_FOUND.
      expectApiErrors(guestAfterDelete, [
        /404 Not Found GET .*\/conversations\/shared\/message\/[A-Za-z0-9_-]+/,
        /"code":"SHARE_NOT_FOUND"/,
      ]);
      expectConsoleErrors(guestAfterDelete, [
        /Failed to load resource: the server responded with a status of 404/,
      ]);
      await guestAfterDelete.goto(shareUrl, { waitUntil: 'domcontentloaded' });
      await expect(guestAfterDelete.getByTestId(TEST_IDS.sharedMessageError)).toBeVisible({
        timeout: TIMEOUTS.CONVERSATION_LOAD,
      });
    });
  });

  test.describe('Cancel at each step', () => {
    test('cancel from intro, wallet, password, and final closes modal and leaves account intact', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-cancel');
      await seedWalletBalance(request, user.email, '2.50');
      await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      const modal = modalLocator(unauthenticatedPage);

      await openDeleteAccountModal(unauthenticatedPage);
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountCancel).click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await continueFromIntro(unauthenticatedPage);
      await continueFromWallet(unauthenticatedPage);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);
      await modal.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).not.toBeVisible();

      await unauthenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
      await expect(unauthenticatedPage).toHaveURL(/\/chat/);
    });
  });

  test.describe('Wrong password rejected', () => {
    test('incorrect password keeps modal on password step with friendly error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongpw');

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await deleteAccountPasswordField(unauthenticatedPage).fill('Wrong-Password-1!');
      // OPAQUE init is constant-time and returns 200 even for a wrong
      // password; the mismatch only surfaces when finishLogin throws
      // client-side, so wait on /init rather than /finish.
      const initWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/auth/account/delete/init') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountPasswordContinue).click();
      const initResponse = await initWait;
      expect(initResponse.status()).toBe(200);

      await expect(modal.getByRole('alert')).toContainText(/incorrect password/i);
      await expect(modal.getByTestId(TEST_IDS.deleteAccountPasswordContinue)).toBeVisible();
    });
  });

  test.describe('Wrong TOTP rejected', () => {
    test('invalid TOTP from final-step submit routes back to TOTP step with friendly error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      // Deliberate: this test submits `000000` and asserts the 400 response.
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/account\/delete\/finish/,
        /"code":"INVALID_TOTP_CODE"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
      ]);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-wrongtotp');
      await enableTwoFactorViaUI(unauthenticatedPage);

      const modal = await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      // Enter a wrong TOTP code and advance past the TOTP step — the server
      // doesn't see the code until /finish, so we have to reach the final step
      // and submit the phrase to exercise the wrong-TOTP path.
      const otpInput = unauthenticatedPage.getByTestId(TEST_IDS.otpInput);
      await expect(otpInput).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      await otpInput.pressSequentially('000000');
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountTotpContinue).click();

      // Final step — type phrase and submit
      await unauthenticatedPage
        .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
        .fill('delete my account');
      const finishWait = unauthenticatedPage.waitForResponse(
        (response) =>
          response.url().includes('/auth/account/delete/finish') &&
          response.request().method() === 'POST'
      );
      await unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit).click();
      const finishResponse = await finishWait;
      expect(finishResponse.status()).toBe(400);

      // After my fix: modal auto-navigates back to TOTP step with the error visible there.
      await expect(modal.getByTestId(TEST_IDS.otpInput)).toBeVisible();
      await expect(modal.getByText(/invalid verification code/i)).toBeVisible();
    });
  });

  test.describe('Phrase gating on step 5', () => {
    test('wrong phrase keeps submit disabled; exact phrase enables it', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-phrase');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      const input = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountConfirmationInput);
      const submit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit);

      await input.fill('delete account');
      await expect(submit).toBeDisabled();

      await input.fill('delete my account');
      await expect(submit).toBeEnabled();
    });
  });

  test.describe('Rate-limit lockout', () => {
    // The deletion lockout (3 attempts per 24h window) is reserved inside
    // /finish BEFORE the proof/TOTP verdict, so the UI-reachable path that
    // burns an attempt without deleting the account is a CORRECT password plus
    // a WRONG TOTP code: the step-up proof verifies, the TOTP gate rejects
    // (400 INVALID_TOTP_CODE), and the reserved attempt is never cleared. (A
    // wrong password never reaches /finish — the OPAQUE client throws after
    // /init — so the bad-proof branch stays route-test territory in the
    // identity slice.) Each /finish consumes its step-up handshake, so every
    // attempt re-drives the modal from a fresh page load.
    test('fourth failed attempt surfaces lockout error', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XXLONG);
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/account\/delete\/finish/,
        /"code":"INVALID_TOTP_CODE"/,
        /429 Too Many Requests POST .*\/auth\/account\/delete\/finish/,
        /"code":"TOO_MANY_ATTEMPTS"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
        /Failed to load resource: the server responded with a status of 429/,
      ]);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-lockout');
      await enableTwoFactorViaUI(unauthenticatedPage);

      for (let attempt = 0; attempt < 3; attempt++) {
        const failed = await submitFinishWithWrongTotp(unauthenticatedPage, user.password);
        expect(failed.status()).toBe(400);
        // The modal routes back to the TOTP step on INVALID_TOTP_CODE; the
        // reload resets its kept-mounted state so the next pass drives a
        // fresh /init handshake instead of resubmitting a consumed session.
        await unauthenticatedPage.reload({ waitUntil: 'domcontentloaded' });
      }

      const locked = await submitFinishWithWrongTotp(unauthenticatedPage, user.password);
      expect(locked.status()).toBe(429);
      const body = (await locked.json()) as { code: string; details?: Record<string, unknown> };
      expect(body.code).toBe('TOO_MANY_ATTEMPTS');
      expect(typeof body.details?.['retryAfterSeconds']).toBe('number');
      await expect(modalLocator(unauthenticatedPage).getByText(/too many attempts/i)).toBeVisible();
    });
  });

  test.describe('Front-end idempotency', () => {
    test('final submit disables on click so double-click cannot fire twice', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const user = await provisionFreshUser(unauthenticatedPage, request, 'e2e-del-idem');

      await openDeleteAccountModal(unauthenticatedPage);
      await advanceThroughIntroAndWallet(unauthenticatedPage);
      await submitPasswordStep(unauthenticatedPage, user.password);

      // Hold `/finish` in-flight on a deterministic signal (not a wall-clock
      // sleep) so the assertion below observes the pending-disabled state. The
      // route is released only after the button is confirmed disabled, which is
      // the exact condition under test (gate on state, not time).
      let finishCount = 0;
      let releaseFinish!: () => void;
      const finishHeld = new Promise<void>((resolve) => {
        releaseFinish = resolve;
      });
      await unauthenticatedPage.route('**/auth/account/delete/finish', async (route) => {
        finishCount++;
        await finishHeld;
        await route.continue();
      });

      await unauthenticatedPage
        .getByTestId(TEST_IDS.deleteAccountConfirmationInput)
        .fill('delete my account');
      const submit = unauthenticatedPage.getByTestId(TEST_IDS.deleteAccountFinalSubmit);

      await submit.click();
      // The real guard: the button becomes disabled immediately after the
      // click while the mutation is pending. A disabled button does not fire
      // onClick events in any browser, so a user double-clicking can't issue
      // a second request.
      await expect(submit).toBeDisabled();
      releaseFinish();

      await expectRedirectedToMarketing(unauthenticatedPage);
      expect(finishCount).toBe(1);
    });
  });
});
