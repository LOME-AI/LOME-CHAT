import { createEnvUtilities } from '@hushbox/shared';
import { createMockEmailSender } from './email-mock.js';
import { createResendEmailSender } from './email-resend.js';
import type { EnvContext } from '@hushbox/shared';
import type { MockEmailSender } from './email-mock.js';
import type { BatchEmailSender, EmailMessage } from '../ports/index.js';

interface EmailSenderEnv extends EnvContext {
  RESEND_API_KEY?: string;
}

export interface CapturedEmail {
  readonly id: string;
  readonly message: EmailMessage;
}

/**
 * The dev mailbox: every message a factory-built MOCK sender delivers, across
 * all instances (the factory constructs a fresh mock per request, so a
 * per-instance capture would be invisible to the dev mailbox routes).
 * Module-level state is admissible here only because the mock path never runs
 * in production — the real adapter is never captured.
 */
const capturedEmails: CapturedEmail[] = [];
let mailboxCounter = 0;

function capture(message: EmailMessage): void {
  mailboxCounter += 1;
  capturedEmails.push({ id: `email-${String(mailboxCounter)}`, message });
}

function withMailboxCapture(mock: MockEmailSender): MockEmailSender {
  return {
    ...mock,
    send: (message) =>
      mock.send(message).map(() => {
        capture(message);
      }),
    sendBatch: (messages, options) =>
      mock.sendBatch(messages, options).map((result) => {
        for (const message of messages) capture(message);
        return result;
      }),
  };
}

/** Newest-last list of every mock-delivered email (dev mailbox viewer). */
export function listCapturedEmails(): readonly CapturedEmail[] {
  return [...capturedEmails];
}

export function findCapturedEmail(id: string): CapturedEmail | undefined {
  return capturedEmails.find((entry) => entry.id === id);
}

/**
 * envUtils-gated sender selection: local dev and CI get the in-process mock
 * (no real email leaves either mode, so no automated check ever observes a
 * real Resend call), production gets the real Resend adapter. Missing config
 * fails fast — there is no degraded mode.
 */
export function createEmailSenderFromEnv(env: EmailSenderEnv): BatchEmailSender {
  // Explicit fail-fast at the selection seam: createEnvUtilities throws on an
  // absent NODE_ENV, and this guard restates that with an email-specific message
  // so a production deploy that omitted it fails loudly instead of ever risking
  // the mock (which drops every email).
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select an email sender');
  }

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return withMailboxCapture(createMockEmailSender());
  }

  if (env.RESEND_API_KEY === undefined) {
    throw new Error('RESEND_API_KEY is required outside local dev and CI');
  }

  return createResendEmailSender({ apiKey: env.RESEND_API_KEY });
}
