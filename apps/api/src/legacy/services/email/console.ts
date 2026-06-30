import type { EmailClient, EmailOptions } from './types.js';

export function createConsoleEmailClient(): EmailClient {
  return {
    sendEmail(options: EmailOptions): Promise<void> {
      console.log('=== Email Sent ===');
      console.log(`To: ${options.to}`);
      console.log(`Subject: ${options.subject}`);
      if (options.from) {
        console.log(`From: ${options.from}`);
      }
      console.log('--- HTML Content ---');
      console.log(options.html);
      console.log('==================');

      const urlMatch = /href="([^"]*verify-email[^"]*)"/.exec(options.html);
      if (urlMatch?.[1]) {
        console.log('\n🔗 Verification link (click or copy):');
        console.log(urlMatch[1]);
      }

      return Promise.resolve();
    },
  };
}
