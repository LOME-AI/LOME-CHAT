export type { EmailClient, EmailOptions, MockEmailClient, SentEmail } from './types.js';
export { createMockEmailClient } from './mock.js';
export { createConsoleEmailClient } from './console.js';
export { createResendEmailClient } from './resend.js';
export { getEmailClient } from './factory.js';
