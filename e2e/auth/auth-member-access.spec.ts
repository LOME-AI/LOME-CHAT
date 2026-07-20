import { TEST_IDS } from '@hushbox/shared';
import { test, expect } from '../fixtures.js';
import { ChatPage, MemberSidebarPage } from '../pages/index.js';
import { searchAndSelectMember } from '../helpers/add-member.js';
import { expectAccessRevoked } from '../helpers/member-actions.js';
import { setWalletBalance } from '../helpers/budget.js';
import { personaEmail, personaUsername } from '../helpers/personas.js';
import { TIMEOUTS } from '../config/timeouts.js';

test.describe('Auth Member Access', () => {
  test('read member lifecycle: history access, removal, no-history re-add, privilege elevation', async ({
    authenticatedPage,
    authenticatedRequest,
    testDavePage,
    groupConversation,
  }) => {
    test.slow();

    const aliceChatPage = new ChatPage(authenticatedPage);
    await aliceChatPage.gotoConversation(groupConversation.id);
    await aliceChatPage.waitForConversationLoaded();

    // ── Goal A: read+history member sees all messages, cannot send ──

    await test.step('add Dave as read+history member', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await searchAndSelectMember(authenticatedPage, sidebar, personaUsername('test-dave'));

      await authenticatedPage.getByTestId(TEST_IDS.addMemberPrivilegeSelect).selectOption('read');

      await authenticatedPage
        .getByTestId(TEST_IDS.addMemberHistoryCheckbox)
        .getByRole('checkbox')
        .check();

      await authenticatedPage.getByTestId(TEST_IDS.addMemberSubmitButton).click();
      await expect(authenticatedPage.getByTestId(TEST_IDS.addMemberModal)).not.toBeVisible();
    });

    await test.step('Dave sees all messages and cannot send', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();

      await daveChatPage.expectMessageVisible('Hello from Alice');
      await daveChatPage.expectMessageVisible('Hi from Bob');

      const sendInput = testDavePage.getByRole('textbox', { name: 'Type a message...' });
      await expect(sendInput).toBeVisible();
      await expect(sendInput).toBeDisabled();
    });

    // ── Goal B: remove, re-add without history, verify epoch isolation ──

    await test.step('remove Dave from conversation', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const daveMemberId = await sidebar.getMemberIdByUsername(personaUsername('test-dave'));
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickRemoveMember(daveMemberId);

      const modal = authenticatedPage.getByTestId(TEST_IDS.removeMemberModal);
      await expect(modal).toBeVisible();
      await authenticatedPage.getByTestId(TEST_IDS.removeMemberConfirm).click();
      await expect(modal).not.toBeVisible();

      await expect(sidebar.memberRow(daveMemberId)).not.toBeVisible();
    });

    await test.step('Dave loses access to conversation', async () => {
      await expectAccessRevoked(testDavePage, groupConversation.id);
    });

    await test.step('add Dave as read+no-history member', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      await searchAndSelectMember(authenticatedPage, sidebar, personaUsername('test-dave'));

      await authenticatedPage.getByTestId(TEST_IDS.addMemberPrivilegeSelect).selectOption('read');

      // Explicitly uncheck history (may retain state from previous modal use)
      await authenticatedPage
        .getByTestId(TEST_IDS.addMemberHistoryCheckbox)
        .getByRole('checkbox')
        .uncheck();

      await authenticatedPage.getByTestId(TEST_IDS.addMemberSubmitButton).click();
      await expect(authenticatedPage.getByTestId(TEST_IDS.addMemberModal)).not.toBeVisible();

      const daveRow = sidebar.findMemberByUsername(personaUsername('test-dave'));
      await expect(daveRow).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      await sidebar.closeMobileSidebarIfOpen();
    });

    await test.step('fund Alice so the live send clears admission', async () => {
      // The composer defaults to Smart Model, whose admission hold exceeds the
      // $0.20 welcome credit; without funding the live send 402s and the
      // post-rotation message never persists.
      await setWalletBalance(
        authenticatedRequest,
        personaEmail('test-alice'),
        'purchased',
        '10.00000000'
      );
    });

    await test.step('Alice sends message in new epoch', async () => {
      const newMessage = `Post-rotation for Dave ${String(Date.now())}`;
      await aliceChatPage.sendFollowUpMessage(newMessage);
      // Wait for stream completion (cost badge visible) so the message is
      // persisted to the DB before Dave's page fetches. Otherwise Dave's
      // API call can beat the DB commit and return an empty conversation.
      await aliceChatPage.waitForStreamComplete();
      await aliceChatPage.expectMessageVisible(newMessage);
    });

    await test.step('Dave sees only new messages, send is disabled', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await daveChatPage.gotoConversation(groupConversation.id);
      await daveChatPage.waitForConversationLoaded();

      await daveChatPage.assertMessageNotVisible('Hello from Alice', { exact: true });

      // Should see post-rotation message (helper auto-scrolls if virtualised)
      await daveChatPage.assertMessageVisible('Post-rotation for Dave');

      const sendInput = testDavePage.getByRole('textbox', { name: 'Type a message...' });
      await expect(sendInput).toBeVisible();
      await expect(sendInput).toBeDisabled();
    });

    await test.step('promote Dave to admin — still sees only new messages but has admin controls', async () => {
      const sidebar = new MemberSidebarPage(authenticatedPage);
      await sidebar.openViaFacepile();
      await sidebar.waitForLoaded();

      const daveMemberId = await sidebar.getMemberIdByUsername(personaUsername('test-dave'));
      await sidebar.openMemberActions(daveMemberId);
      await sidebar.clickChangePrivilege(daveMemberId, 'admin');
      await sidebar.expectMemberInSection(daveMemberId, 'admin');
    });

    await test.step('Dave as admin sees only new messages (no-history preserved)', async () => {
      const daveChatPage = new ChatPage(testDavePage);
      await testDavePage.reload();
      await daveChatPage.waitForConversationLoaded();

      // Still should NOT see pre-rotation messages (privilege change doesn't grant history)
      await daveChatPage.assertMessageNotVisible('Hello from Alice', { exact: true });

      // Should still see post-rotation message (helper auto-scrolls if virtualised)
      await daveChatPage.assertMessageVisible('Post-rotation for Dave');
    });
  });
});
