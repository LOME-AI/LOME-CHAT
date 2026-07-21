import { TEST_IDS } from '@hushbox/shared';
import { test, expect, expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { SidebarPage } from '../pages/sidebar.page.js';
import { personaEmail } from '../helpers/personas.js';
import { waitForAppStable } from '../helpers/page-signals.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Inbox decline invite', () => {
  // Each test creates its own pending invite — the decline mutation is
  // destructive so sharing a fixture would leak state between tests.
  test('Bob declines a pending invite from Alice', async ({
    testBobPage,
    authenticatedRequest,
  }) => {
    // Deliberate: after Bob declines the invite and `goto`s the declined
    // conversation, the prefetch for per-conversation resources he no
    // longer has access to returns 404 NOT_FOUND for each.
    expectApiErrors(testBobPage, [
      /404 Not Found GET .*\/conversations\/[0-9a-f-]+(?:\/(?:keychain|members|links|messages))?(?=\?|\s|$)/,
    ]);
    expectConsoleErrors(testBobPage, [
      /Failed to load resource: the server responded with a status of 404/,
    ]);
    const aliceEmail = personaEmail('test-alice');
    const bobEmail = personaEmail('test-bob');

    // Seed a group conversation where Bob is invited but has NOT accepted —
    // mirrors the production invite flow (Alice invites Bob; Bob sees a
    // pending entry in his inbox until he chooses accept or decline).
    const createResponse = await authenticatedRequest.post('/dev/group-chat', {
      data: {
        ownerEmail: aliceEmail,
        memberEmails: [bobEmail],
        pendingMemberEmails: [bobEmail],
        messages: [
          { senderEmail: aliceEmail, content: 'Welcome to the project!', senderType: 'user' },
        ],
      },
    });
    expect(
      createResponse.ok(),
      `dev group-chat creation failed: ${String(createResponse.status())}`
    ).toBe(true);
    const { conversationId } = (await createResponse.json()) as { conversationId: string };

    await testBobPage.goto('/chat', { waitUntil: 'domcontentloaded' });
    await waitForAppStable(testBobPage);

    await test.step('Bob opens the Invites tab and sees the pending conversation', async () => {
      const sidebar = new SidebarPage(testBobPage);
      await sidebar.openInvitesTab();
      const inbox = testBobPage.getByTestId(TEST_IDS.inboxContent);
      await expect(inbox).toBeVisible();
      // The invite card is labelled by the conversation title — empty for a
      // freshly-seeded chat, so we match the Decline button by aria-label
      // prefix instead. The test seed creates exactly one invite; no .first().
      await expect(testBobPage.getByRole('button', { name: /^Decline/ })).toBeVisible();
    });

    await test.step('Bob declines and confirms', async () => {
      await testBobPage.getByRole('button', { name: /^Decline/ }).click();

      const modal = testBobPage.getByTestId(TEST_IDS.leaveConfirmationModal);
      await expect(modal).toBeVisible();

      await testBobPage.getByTestId(TEST_IDS.leaveConfirmationConfirm).click();
      await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
    });

    await test.step('the declined invite is removed from the inbox', async () => {
      await expect(testBobPage.getByRole('button', { name: /^Decline/ })).not.toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
    });

    await test.step('navigating to the declined conversation redirects away', async () => {
      await testBobPage.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
      await expect(testBobPage).not.toHaveURL(new RegExp(conversationId), {
        timeout: TIMEOUTS.ROUTE,
      });
    });
  });
});
