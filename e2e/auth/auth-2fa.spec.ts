import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import {
  LoginPage,
  SettingsPage,
  TwoFactorSetupModal,
  TwoFactorInputModal,
  DisableTwoFactorModal,
} from '../pages';
import {
  generateTOTPCode,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
  logoutViaUI,
  navigateToSettings,
  clearAuthRateLimits,
  getAcceptableTOTPCode,
} from '../helpers/auth.js';
import { DEV_PASSWORD } from '../../packages/shared/src/constants.js';
import { TEST_2FA_TOTP_SECRET } from '../../scripts/seed.js';
import { personaEmail } from '../helpers/personas.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Two-Factor Authentication', () => {
  test.beforeEach(async ({ request }) => {
    await clearAuthRateLimits(request);
  });

  test.describe('Login with 2FA (seeded user)', () => {
    // eslint-disable-next-line no-restricted-syntax -- serial: both tests log in as the same seeded `test-2fa` persona; parallel runs would race that user's login + rate-limit state.
    test.describe.configure({ mode: 'serial' });

    test('invalid 2FA code shows error', async ({ unauthenticatedPage }) => {
      // Deliberate: this test submits `000000` and asserts the 400 response.
      expectApiErrors(unauthenticatedPage, [
        /400 Bad Request POST .*\/auth\/login\/2fa\/verify/,
        /"code":"INVALID_TOTP_CODE"/,
      ]);
      expectConsoleErrors(unauthenticatedPage, [
        /Failed to load resource: the server responded with a status of 400/,
      ]);
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
      await tfaModal.waitForModal();
      await tfaModal.enterCode('000000');
      await tfaModal.verify();
      await tfaModal.expectError(/invalid|failed/i);
    });

    test('valid 2FA code navigates to /chat', async ({ unauthenticatedPage }) => {
      const loginPage = new LoginPage(unauthenticatedPage);
      await loginPage.goto();
      await loginPage.login(personaEmail('test-2fa'), DEV_PASSWORD);

      const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
      await tfaModal.waitForModal();
      const code = generateTOTPCode(TEST_2FA_TOTP_SECRET);
      await tfaModal.enterCode(code);
      await tfaModal.verify();

      await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
    });
  });

  test.describe('2FA Setup Lifecycle (fresh user)', () => {
    test('setup → verify → logout → login with 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-2fa');
      const username = uniqueUsername('tfa');
      const password = 'TestPassword123!';
      let totpSecret = '';
      let setupCode = '';

      await test.step('setup 2FA: shows QR code and secret', async () => {
        await signUpAndVerify(unauthenticatedPage, request, { username, email, password });

        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.openTwoFactor();

        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.start();

        totpSecret = await setupModal.waitForSecret();
        expect(totpSecret.length).toBeGreaterThan(0);
      });

      await test.step('verify TOTP code enables 2FA', async () => {
        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.continueToVerify();

        setupCode = generateTOTPCode(totpSecret);
        await setupModal.enterCode(setupCode);
        await setupModal.verify();
        await setupModal.expectSuccess();
        await setupModal.done();
      });

      await test.step('logout then login requires 2FA', async () => {
        await logoutViaUI(unauthenticatedPage);

        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.login(email, password);

        const tfaModal = new TwoFactorInputModal(unauthenticatedPage);
        await tfaModal.waitForModal();

        // Wait for a fresh TOTP code to avoid replay protection
        const loginCode = await getAcceptableTOTPCode(request, email, totpSecret);
        await tfaModal.enterCode(loginCode);
        await tfaModal.verify();

        await expect(unauthenticatedPage).toHaveURL('/chat', { timeout: TIMEOUTS.ROUTE });
      });
    });
  });

  test.describe('2FA Disable Lifecycle (fresh user)', () => {
    test('enable → disable → login without 2FA', async ({ unauthenticatedPage, request }) => {
      test.setTimeout(TIMEOUTS.XLONG);
      const email = uniqueEmail('e2e-2fa-dis');
      const username = uniqueUsername('dis');
      const password = 'TestPassword123!';
      let totpSecret = '';

      await test.step('enable 2FA', async () => {
        await signUpAndVerify(unauthenticatedPage, request, { username, email, password });

        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.openTwoFactor();

        const setupModal = new TwoFactorSetupModal(unauthenticatedPage);
        await setupModal.start();
        totpSecret = await setupModal.waitForSecret();
        await setupModal.continueToVerify();

        const enableCode = generateTOTPCode(totpSecret);
        await setupModal.enterCode(enableCode);
        await setupModal.verify();
        await setupModal.expectSuccess();
        await setupModal.done();
      });

      await test.step('disable 2FA via settings', async () => {
        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.expectTwoFactorBadge('Enabled');
        await settingsPage.openTwoFactor();

        const disableModal = new DisableTwoFactorModal(unauthenticatedPage);
        await disableModal.fillPasswordAndContinue(password);

        // Wait for a fresh TOTP code to avoid replay protection
        const disableCode = await getAcceptableTOTPCode(request, email, totpSecret);
        await disableModal.enterCodeAndDisable(disableCode);

        await expect(disableModal.modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
      });

      await test.step('settings shows 2FA disabled', async () => {
        await navigateToSettings(unauthenticatedPage);
        const settingsPage = new SettingsPage(unauthenticatedPage);
        await settingsPage.expectTwoFactorBadge('Disabled');
      });

      await test.step('login without 2FA after disable', async () => {
        await logoutViaUI(unauthenticatedPage);

        const loginPage = new LoginPage(unauthenticatedPage);
        await loginPage.loginAndWaitForChat(email, password);
        await expect(unauthenticatedPage).toHaveURL('/chat');
      });
    });
  });
});
