import { test, expect, allowExternalHosts } from '../fixtures.js';
import { TEST_IDS } from '@hushbox/shared';
import { BillingPage } from '../pages';
import { requireEnv } from '../helpers/env.js';
import { TIMEOUTS } from '../config/timeouts.js';

const apiUrl = requireEnv('VITE_API_URL');

test.describe('Billing & Payments', () => {
  test.describe('Billing Page', () => {
    test('displays balance and opens payment modal', async ({ authenticatedPage }) => {
      // Opening the modal mounts PaymentForm, which loads Helcim's version2.js
      // from secure.myhelcim.com when isLocalDev is false (CI). The @webhook
      // describes auto-opt into the billing hosts; this untagged Billing-Page
      // test must opt in explicitly, or the network allowlist aborts the script
      // load and fails teardown.
      allowExternalHosts(authenticatedPage);

      const billingPage = new BillingPage(authenticatedPage);
      await billingPage.goto();

      await billingPage.expectBalanceVisible();
      await expect(billingPage.addCreditsButton).toBeVisible();

      await billingPage.openPaymentModal();
      await expect(billingPage.amountInput).toBeVisible();
    });
  });

  // Dev Mode tests use simulate buttons that render only in local dev (isLocalDev).
  // In CI, VITE_CI=true makes isLocalDev=false, so the buttons are hidden. @local-only
  // gates this describe out of CI (the CI matrix passes --grep-invert @local-only) while
  // keeping it in local runs, replacing the former in-body `test.skip(isCI, …)`.
  test.describe('Payment Flow (Dev Mode)', { tag: '@local-only' }, () => {
    test('simulates successful payment and updates balance', async ({ billingDevModePage }) => {
      const billingPage = new BillingPage(billingDevModePage);
      await billingPage.goto();

      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('25');

      await billingPage.simulateSuccessButton.click();

      await billingPage.expectPaymentSuccess();

      await billingPage.closeSuccessAndReset();

      // Wait for balance to update (cache invalidation and refetch)
      await expect
        .poll(() => billingPage.getBalance(), { timeout: TIMEOUTS.MODAL })
        .toBe(initialBalance + 25);
    });

    test('simulates failed payment and shows error', async ({ billingFailurePage }) => {
      const billingPage = new BillingPage(billingFailurePage);
      await billingPage.goto();

      const initialBalance = await billingPage.getBalance();

      await billingPage.simulateFailedPayment('10');

      await billingPage.closeErrorAndRetry();
      await billingFailurePage.keyboard.press('Escape');

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance);
    });

    test('validates minimum deposit amount', async ({ billingValidationPage }) => {
      const billingPage = new BillingPage(billingValidationPage);
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('2'); // Below $5 minimum

      const amountInput = billingPage.amountInput;
      await expect(amountInput).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // Full payment flow tests run both locally (with mocks) and in CI (with real Helcim
  // sandbox). Locally: mock Helcim.js tokenizes, mock API processes, mock webhook delivers.
  // CI: real Helcim.js tokenizes, real API processes, real webhook via Hookdeck — only one
  // Hookdeck listener, so these run on the chromium runner only. @webhook gates them to that
  // runner in CI, replacing the former `SKIP_WEBHOOK_TESTS` in-body skip.
  test.describe('Payment Flow (Full)', { tag: '@webhook' }, () => {
    // Increase timeout for real payment tests (webhook may take time)
    test.setTimeout(TIMEOUTS.LONG);

    test('completes full payment flow: card → API → webhook → balance', async ({
      billingSuccessPage,
    }, testInfo) => {
      // This test verifies the COMPLETE payment flow including:
      // 1. Card tokenization via Helcim.js
      // 2. Payment processing via Helcim API
      // 3. Webhook delivery (via Hookdeck in CI)
      // 4. Webhook signature verification
      // 5. Balance update in database

      const billingPage = new BillingPage(billingSuccessPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();
      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

      // devdocs.helcim.com/docs/test-credit-card-numbers
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '100',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });

      await billingPage.submitPayment();

      // For real Helcim: payment goes to "processing" state (awaiting webhook)
      // The UI should show processing indicator while polling for confirmation
      // Webhook flow: Helcim → Hookdeck → CI runner → signature verified → balance credited

      // Wait for payment to complete (either immediate mock or webhook-based real)
      // Real Helcim + Hookdeck webhook can take 10-30s (tokenize + API + webhook delivery + poll)
      try {
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      } catch (error) {
        await testInfo.attach('diagnostic-report-full-payment', {
          body: JSON.stringify(
            {
              context: 'full payment flow',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }

      await billingPage.goto();

      // Poll for balance update (webhook may take a few seconds)
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, TIMEOUTS.WEBHOOK);

      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBe(initialBalance + 5);

      await test.step('transaction history shows the payment', async () => {
        const txList = billingSuccessPage.getByTestId(TEST_IDS.transactionListContainer);
        await expect(txList).toBeVisible();

        const txRows = txList.getByTestId(TEST_IDS.transactionRow);
        await expect(txRows.first()).toBeVisible();

        const firstRow = txRows.first();
        await expect(firstRow).toContainText('$5');
      });
    });

    test('handles declined card', async ({ authenticatedPage }, testInfo) => {
      const billingPage = new BillingPage(authenticatedPage);
      billingPage.enableDiagnostics();
      await billingPage.goto();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');

      // CVV 200 = decline (devdocs.helcim.com/docs/testing-declines-and-avs)
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '200',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });

      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentError();
      } catch (error) {
        await testInfo.attach('diagnostic-report-declined-card', {
          body: JSON.stringify(
            {
              context: 'declined card',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }
    });

    test('validates real Helcim webhook signature', async ({ billingSuccessPage2 }, testInfo) => {
      // This test ensures that:
      // 1. Real Helcim sends a properly signed webhook
      // 2. Our webhook signature validation correctly checks it
      // 3. If signature verification failed, balance would NOT update
      //
      // The fact that balance updates proves signature verification passed.

      const billingPage = new BillingPage(billingSuccessPage2);
      billingPage.enableDiagnostics();
      await billingPage.goto();
      const initialBalance = await billingPage.waitForBalanceLoaded();

      await billingPage.openPaymentModal();
      await billingPage.enterAmount('5');
      await billingPage.fillCardDetails({
        cardNumber: '4124939999999990',
        expiry: '01/28',
        cvv: '100',
        cardHolderName: 'Test User',
        billingAddress: '123 Test Street',
        zip: '12345',
      });
      await billingPage.submitPayment();

      try {
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      } catch (error) {
        await testInfo.attach('diagnostic-report-webhook-signature', {
          body: JSON.stringify(
            {
              context: 'webhook signature validation',
              uiState: await billingPage.captureCurrentState(),
              apiResponses: billingPage.getDiagnosticReport(),
            },
            null,
            2
          ),
          contentType: 'application/json',
        });
        throw error;
      }

      await billingPage.goto();

      // If webhook signature verification failed, this would timeout
      // because the webhook credit processing would never be called
      await billingPage.waitForWebhookConfirmation(initialBalance, 5, TIMEOUTS.WEBHOOK);

      // Balance updated = webhook was received AND signature was valid
      const newBalance = await billingPage.getBalance();
      expect(newBalance).toBeGreaterThan(initialBalance);
    });
  });

  // Token-login payment also drives the real Helcim → Hookdeck webhook path; @webhook gates
  // it to the chromium runner in CI, replacing the former `SKIP_WEBHOOK_TESTS` in-body skip.
  test.describe('Token-Login Billing Portal', { tag: '@webhook' }, () => {
    test.setTimeout(TIMEOUTS.LONG);

    test('unauthenticated user completes payment via billing token', async ({
      billingTokenRequest,
      unauthenticatedPage,
    }) => {
      let billingToken = '';

      await test.step('generate billing login token', async () => {
        const response = await billingTokenRequest.post(`${apiUrl}/billing/login-link`);
        expect(response.ok()).toBe(true);
        const { token } = (await response.json()) as { token: string };
        expect(token).toBeTruthy();
        billingToken = token;
      });

      await test.step('open billing portal with token', async () => {
        await unauthenticatedPage.goto(`/billing-portal?token=${billingToken}`, {
          waitUntil: 'domcontentloaded',
        });

        // Token exchange + /auth/me hydration are async — the web-first
        // retrying assertion below waits them out.
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.billingPortal)).toBeVisible({
          timeout: TIMEOUTS.APP_STABLE,
        });
      });

      await test.step('billing page renders without app shell', async () => {
        await expect(unauthenticatedPage.getByTestId(TEST_IDS.balanceDisplay)).toBeVisible({
          timeout: TIMEOUTS.ASSERT,
        });
        await expect(
          unauthenticatedPage.getByRole('button', { name: 'Add Credits' })
        ).toBeVisible();

        await expect(unauthenticatedPage.getByTestId(TEST_IDS.sidebarTrigger)).not.toBeVisible();
      });

      const billingPage = new BillingPage(unauthenticatedPage);
      billingPage.enableDiagnostics();
      const initialBalance = await billingPage.waitForBalanceLoaded();

      await test.step('complete payment flow', async () => {
        await billingPage.openPaymentModal();
        await billingPage.enterAmount('5');

        await billingPage.fillCardDetails({
          cardNumber: '4124939999999990',
          expiry: '01/28',
          cvv: '100',
          cardHolderName: 'Token User',
          billingAddress: '123 Test Street',
          zip: '12345',
        });

        await billingPage.submitPayment();
        await billingPage.expectPaymentSuccess(TIMEOUTS.WEBHOOK);
      });

      await test.step('balance updated after payment', async () => {
        // Token was consumed on first use — generate a fresh one
        const freshResponse = await billingTokenRequest.post(`${apiUrl}/billing/login-link`);
        expect(freshResponse.ok()).toBe(true);
        const { token: freshToken } = (await freshResponse.json()) as { token: string };

        await unauthenticatedPage.goto(`/billing-portal?token=${freshToken}`, {
          waitUntil: 'domcontentloaded',
        });
        await billingPage.waitForWebhookConfirmation(initialBalance, 5, TIMEOUTS.WEBHOOK);

        const newBalance = await billingPage.getBalance();
        expect(newBalance).toBe(initialBalance + 5);
      });

      await test.step('billing-only session cannot access chat', async () => {
        await unauthenticatedPage.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(unauthenticatedPage.getByText('Free preview')).toBeVisible({
          timeout: TIMEOUTS.APP_STABLE,
        });
      });
    });
  });
});
