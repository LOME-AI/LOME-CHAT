import { type Page, type Locator } from '@playwright/test';
import { isMobileWidth, TEST_IDS } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { expectCorrectOverlayVariant } from '../helpers/overlay.js';

export class SidebarPage {
  readonly page: Page;
  readonly hamburgerButton: Locator;
  readonly sidebar: Locator;

  constructor(page: Page) {
    this.page = page;
    this.hamburgerButton = page.getByTestId(TEST_IDS.hamburgerButton);
    this.sidebar = page.getByTestId(TEST_IDS.sidebar);
  }

  private isMobileViewport(): boolean {
    const viewport = this.page.viewportSize();
    return viewport !== null && isMobileWidth(viewport.width);
  }

  private async openMobileSidebarIfNeeded(): Promise<void> {
    if (!this.isMobileViewport()) return;

    if (await this.sidebar.isVisible()) return;

    await this.hamburgerButton.click();
    await expect(this.sidebar).toBeVisible();
  }

  private async expandSidebarIfCollapsed(): Promise<void> {
    if (this.isMobileViewport()) return;

    const expandButton = this.sidebar.getByRole('button', { name: 'Expand sidebar' });
    if (await expandButton.isVisible()) {
      await expandButton.click();
      await expect(expandButton).not.toBeVisible();
    }
  }

  /**
   * Bring the sidebar body on screen: the drawer on mobile, the expanded
   * column on desktop (it persists collapsed, so a fresh context lands on the
   * rail). Anything living in the body — conversation rows, the notification
   * offer — is only reachable after this.
   */
  async ensureSidebarExpanded(): Promise<void> {
    await this.openMobileSidebarIfNeeded();
    await this.expandSidebarIfCollapsed();
  }

  getChatLink(conversationId: string): Locator {
    return this.sidebar.locator(`a[href="/chat/${conversationId}"]`);
  }

  getChatItemContainer(conversationId: string): Locator {
    return this.getChatLink(conversationId).locator('..');
  }

  async openMoreMenu(conversationId: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const container = this.getChatItemContainer(conversationId).first();
    await container.hover();
    await container.getByTestId(TEST_IDS.chatItemMoreButton).click();
  }

  async renameConversation(conversationId: string, newName: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(this.page.getByText('Rename conversation', { exact: true })).toBeVisible();
    await expectCorrectOverlayVariant(this.page);

    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId(TEST_IDS.saveRenameButton).click();

    await expect(this.page.getByText('Rename conversation', { exact: true })).not.toBeVisible();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await expectCorrectOverlayVariant(this.page);
    await this.page.getByTestId(TEST_IDS.confirmDeleteButton).click();
  }

  async cancelDelete(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId(TEST_IDS.cancelDeleteButton).click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  async expectConversationVisible(conversationId: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const link = this.getChatLink(conversationId);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
  }

  async expectConversationTitle(conversationId: string, title: string): Promise<void> {
    await this.ensureSidebarExpanded();
    const link = this.getChatLink(conversationId);
    await link.scrollIntoViewIfNeeded();
    await expect(link.getByText(title)).toBeVisible();
  }

  async countConversationsWithText(text: string): Promise<number> {
    await this.ensureSidebarExpanded();
    const matchingLinks = this.sidebar.locator('a[href^="/chat/"]').filter({ hasText: text });
    return matchingLinks.count();
  }

  async openInvitesTab(): Promise<void> {
    await this.ensureSidebarExpanded();
    await this.sidebar.getByRole('button', { name: /Invites/ }).click();
  }
}
