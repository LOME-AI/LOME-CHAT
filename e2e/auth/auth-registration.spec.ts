import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { LoginPage, SignupPage } from '../pages';
import {
  signUpViaUI,
  verifyEmailViaAPI,
  loginViaUI,
  uniqueEmail,
  uniqueUsername,
  clearAuthRateLimits,
} from '../helpers/auth.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Registration & Verification', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test('signup → verify → login succeeds', async ({ unauthenticatedPage, request }) => {
    test.setTimeout(TIMEOUTS.XLONG);
    const email = uniqueEmail('e2e-reg');
    const username = uniqueUsername('reg');
    const password = 'TestPassword123!';

    await test.step('signup with valid credentials shows "Check your email"', async () => {
      await signUpViaUI(unauthenticatedPage, request, { username, email, password });
      await expect(unauthenticatedPage.getByText('Check your email')).toBeVisible();
    });

    await test.step('verify email via dev API succeeds', async () => {
      await verifyEmailViaAPI(request, unauthenticatedPage, email);
      await expect(unauthenticatedPage).toHaveURL(/\/verify\?token=/, { timeout: TIMEOUTS.ROUTE });
      await expect(
        unauthenticatedPage.getByRole('heading', { name: /email verified/i })
      ).toBeVisible();
    });

    await test.step('login with new credentials navigates to /chat', async () => {
      await loginViaUI(unauthenticatedPage, { email, password });
      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });
  });

  test.describe('Signup validation', () => {
    test('weak password shows validation error', async ({ unauthenticatedPage }) => {
      const signupPage = new SignupPage(unauthenticatedPage);
      await signupPage.goto();

      await signupPage.usernameInput.fill('validuser');
      await signupPage.emailInput.fill(uniqueEmail('e2e-weak'));
      await signupPage.passwordInput.fill('short');
      await signupPage.confirmPasswordInput.fill('short');
      await signupPage.submit();

      await expect(unauthenticatedPage.getByText(/at least 8 characters/i)).toBeVisible();
    });

    test('mismatched passwords shows validation error', async ({ unauthenticatedPage }) => {
      const signupPage = new SignupPage(unauthenticatedPage);
      await signupPage.goto();

      await signupPage.usernameInput.fill('validuser');
      await signupPage.emailInput.fill(uniqueEmail('e2e-mismatch'));
      await signupPage.passwordInput.fill('TestPassword123!');
      await signupPage.confirmPasswordInput.fill('DifferentPassword456!');
      await signupPage.submit();

      await expect(unauthenticatedPage.getByText(/do not match/i)).toBeVisible();
    });
  });

  test.describe('Email verification resend', () => {
    test('resend from signup success page', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-resend');
      const username = uniqueUsername('resend');
      const password = 'TestPassword123!';

      await test.step('sign up shows check-your-email with resend button', async () => {
        await signUpViaUI(unauthenticatedPage, request, { username, email, password });
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible();
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();
      });

      await test.step('click resend shows success feedback and cooldown', async () => {
        const resendButton = unauthenticatedPage.getByTestId(TEST_IDS.resendButton);
        await expect(resendButton).toBeEnabled();
        await resendButton.click();

        const feedback = unauthenticatedPage.getByTestId(TEST_IDS.resendFeedback);
        await expect(feedback).toBeVisible();
        await expect(feedback).toContainText('Verification email sent.');

        await expect(resendButton).toBeDisabled();
        await expect(resendButton).toContainText(/\d+s/);
      });

      await test.step('verify with latest token and login', async () => {
        await verifyEmailViaAPI(request, unauthenticatedPage, email);
        await loginViaUI(unauthenticatedPage, { email, password });
        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });

    test('login unverified redirects to check-email with auto-resend', async ({
      unauthenticatedPage,
      request,
    }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      // Deliberate: logging in with an unverified email returns 401
      // EMAIL_NOT_VERIFIED, which the UI translates to a redirect to
      // /check-your-email plus an auto-resend.
      expectApiErrors(unauthenticatedPage, [
        /401 Unauthorized POST .*\/auth\/login\/finish/,
        /"code":"EMAIL_NOT_VERIFIED"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 401/,
      ]);
      const email = uniqueEmail('e2e-unverified');
      const username = uniqueUsername('unver');
      const password = 'TestPassword123!';

      await test.step('sign up but do not verify', async () => {
        await signUpViaUI(unauthenticatedPage, request, { username, email, password });
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible();
      });

      await test.step('login with unverified email shows check-your-email with auto-resend', async () => {
        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.goto();
        await loginPage.login(email, password);

        await expect(unauthenticatedPage.getByTestId(TEST_IDS.checkYourEmail)).toBeVisible({
          timeout: TIMEOUTS.ROUTE,
        });
        await expect(unauthenticatedPage.getByText(email)).toBeVisible();

        const feedback = unauthenticatedPage.getByTestId(TEST_IDS.resendFeedback);
        await expect(feedback).toBeVisible({ timeout: TIMEOUTS.ASSERT });
        await expect(feedback).toContainText('Verification email sent.');

        const resendButton = unauthenticatedPage.getByTestId(TEST_IDS.resendButton);
        await expect(resendButton).toBeDisabled();
      });

      await test.step('verify with latest token and login', async () => {
        await verifyEmailViaAPI(request, unauthenticatedPage, email);
        await loginViaUI(unauthenticatedPage, { email, password });
        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });
  });
});
