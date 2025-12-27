import { type Page, type Locator, expect } from '@playwright/test';

export class ChatPage {
  readonly page: Page;
  readonly promptInput: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;
  readonly newChatPage: Locator;
  readonly suggestionChips: Locator;

  constructor(page: Page) {
    this.page = page;
    this.promptInput = page.getByRole('textbox', { name: 'Ask me anything...' });
    this.messageInput = page.locator('main').getByRole('textbox', { name: /message/i });
    this.sendButton = page.getByRole('button', { name: 'Send' });
    this.messageList = page.getByRole('log', { name: 'Chat messages' });
    this.newChatPage = page.getByTestId('new-chat-page');
    this.suggestionChips = page.getByText('Need inspiration? Try these:');
  }

  async goto(): Promise<void> {
    await this.page.goto('/chat');
  }

  async gotoConversation(conversationId: string): Promise<void> {
    await this.page.goto(`/chat/${conversationId}`);
  }

  async sendNewChatMessage(message: string): Promise<void> {
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled();
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async waitForConversation(): Promise<string> {
    await expect(this.page).toHaveURL(/\/chat\/[a-f0-9-]+$/);
    return this.page.url().split('/').pop() ?? '';
  }

  async expectMessageVisible(message: string): Promise<void> {
    await expect(this.messageList.getByText(message)).toBeVisible();
  }

  async expectNewChatPageVisible(): Promise<void> {
    await expect(this.newChatPage).toBeVisible();
  }

  async expectPromptInputVisible(): Promise<void> {
    await expect(this.promptInput).toBeVisible();
  }

  async expectSuggestionChipsVisible(): Promise<void> {
    await expect(this.suggestionChips).toBeVisible();
  }
}
