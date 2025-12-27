import { type Page, type Locator, expect } from '@playwright/test';

export class SidebarPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  getChatLink(conversationId: string): Locator {
    return this.page.locator(`a[href="/chat/${conversationId}"]`);
  }

  getChatItemContainer(conversationId: string): Locator {
    return this.getChatLink(conversationId).locator('..');
  }

  async openMoreMenu(conversationId: string): Promise<void> {
    const container = this.getChatItemContainer(conversationId);
    await container.hover();
    await container.getByTestId('chat-item-more-button').click();
  }

  async renameConversation(conversationId: string, newName: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(this.page.getByText('Rename conversation')).toBeVisible();

    const input = this.page.locator('input[placeholder="Conversation title"]');
    await input.clear();
    await input.fill(newName);
    await this.page.getByTestId('save-rename-button').click();

    await expect(this.page.getByText('Rename conversation')).not.toBeVisible();
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('confirm-delete-button').click();
  }

  async cancelDelete(conversationId: string): Promise<void> {
    await this.openMoreMenu(conversationId);
    await this.page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(this.page.getByText('Delete conversation?')).toBeVisible();
    await this.page.getByTestId('cancel-delete-button').click();
    await expect(this.page.getByText('Delete conversation?')).not.toBeVisible();
  }

  async expectConversationVisible(conversationId: string): Promise<void> {
    await expect(this.getChatLink(conversationId)).toBeVisible();
  }

  async expectConversationTitle(conversationId: string, title: string): Promise<void> {
    await expect(this.getChatLink(conversationId).getByText(title)).toBeVisible();
  }
}
