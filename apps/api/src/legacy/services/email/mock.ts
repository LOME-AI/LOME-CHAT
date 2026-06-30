import type { EmailOptions, MockEmailClient, SentEmail } from './types.js';

export function createMockEmailClient(): MockEmailClient {
  const sentEmails: SentEmail[] = [];

  return {
    sendEmail(options: EmailOptions): Promise<void> {
      sentEmails.push({ ...options });
      return Promise.resolve();
    },

    getSentEmails(): SentEmail[] {
      return [...sentEmails];
    },

    clearSentEmails(): void {
      sentEmails.length = 0;
    },
  };
}
