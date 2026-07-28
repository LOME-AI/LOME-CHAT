import { getContext } from 'hono/context-storage';
import { createEmailSenderFromEnv } from '../slices/notifications/index.js';
import type { EmailContent, EmailSender } from '../slices/notifications/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { DomainError } from '../lib/errors/index.js';
import type { ResultAsync } from '../lib/result/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface EmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The single compose-and-send seam behind every composition-root email port.
 * Each port builds its own template content (subject + html + text) and passes
 * a `logFailure` callback carrying its own compile-time-literal warn message —
 * the msg-literal lint requires the literal at the `.warn` call site, so the
 * message stays with the caller while the send + error-map boilerplate is
 * single-sourced here. Best-effort by port doctrine: the failure is logged
 * (codes only, never the address or content) and still returned on the error
 * channel for callers that do look.
 */
export function sendComposedEmail(
  deps: EmailSendDeps,
  args: {
    readonly to: string;
    readonly subject: string;
    readonly content: EmailContent;
    readonly logFailure: (logger: Telemetry, errorCode: string) => void;
  }
): ResultAsync<void, DomainError> {
  return deps.sender
    .send({ to: args.to, subject: args.subject, html: args.content.html, text: args.content.text })
    .mapErr((error) => {
      args.logFailure(deps.logger, error.code);
      return error;
    });
}

/**
 * The single per-request dep resolver every `createApp*EmailPort` binds to:
 * billing/identity route deps take ONE static port object, but the sender
 * selection (env) and the request logger only exist per invocation on Workers —
 * so each send resolves them from the current request via hono's context
 * storage. Sender construction is single-sourced here.
 */
export function resolveEmailSendDeps(): EmailSendDeps {
  const c = getContext<AppEnv>();
  return { sender: createEmailSenderFromEnv(c.env), logger: c.var.logger };
}
