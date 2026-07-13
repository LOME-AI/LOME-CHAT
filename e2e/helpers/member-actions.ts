import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatPage } from '../pages/index.js';
import type { Page } from '@playwright/test';

/**
 * Navigate as a removed member and verify they are redirected away.
 *
 * The navigation triggers per-conversation prefetches (`/conversations|
 * budgets|members|keys|links/{id}`) for resources the principal no longer has
 * access to — each returns 404 CONVERSATION_NOT_FOUND before the router
 * redirects away. Opt out here so every caller doesn't have to repeat the
 * pattern.
 */
export async function expectAccessRevoked(page: Page, conversationId: string): Promise<void> {
  expectApiErrors(page, [
    /404 Not Found GET .*\/(budgets|conversations|keys|links|members)\/[0-9a-f-]+/,
    /"code":"CONVERSATION_NOT_FOUND"/,
  ]);
  expectConsoleErrors(page, [/Failed to load resource: the server responded with a status of 404/]);

  const chatPage = new ChatPage(page);
  await chatPage.gotoConversation(conversationId);

  // Member should be redirected away or see an error
  await expect(page).not.toHaveURL(new RegExp(conversationId), {
    timeout: TIMEOUTS.ROUTE,
  });
}
