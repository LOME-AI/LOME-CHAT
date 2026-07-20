export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

export type SentEmail = EmailOptions;

export interface EmailClient {
  sendEmail(options: EmailOptions): Promise<void>;
}

export interface MockEmailClient extends EmailClient {
  getSentEmails(): SentEmail[];
  clearSentEmails(): void;
}
