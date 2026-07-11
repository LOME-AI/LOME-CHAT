import { getContext } from 'hono/context-storage';
import { accountDeletedEmail, createEmailSenderFromEnv } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { AccountDeletedEmailPort } from '../slices/identity/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const ACCOUNT_DELETED_EMAIL_SUBJECT = 'Your HushBox account has been deleted';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface AccountDeletedEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind identity's AccountDeletedEmailPort:
 * composes the notifications slice's account-deleted template + EmailSender.
 * The recipient is the email the deletion transaction captured — the user
 * record is gone by send time, so the template takes no personalization. The
 * port contract is best-effort — the domain ignores a failed Result — so
 * send-failure observability lives here: the failure's error code goes
 * through the typed logger (codes only, never the address), and the failure
 * still returns on the error channel for callers that do look.
 */
export function createAccountDeletedEmailAdapter(
  resolve: () => AccountDeletedEmailSendDeps
): AccountDeletedEmailPort {
  return {
    sendAccountDeletedEmail(args) {
      const { sender, logger } = resolve();
      const content = accountDeletedEmail({});
      return sender
        .send({
          to: args.to,
          subject: ACCOUNT_DELETED_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('account-deleted email send failed', { errorCode: error.code });
          return error;
        });
    },
  };
}

/**
 * The production binding: identity's route deps take ONE static port object,
 * but the sender selection (env), the evidence db, and the request logger
 * only exist per invocation on Workers — so each send resolves them from the
 * current request via hono's context storage (the same shape as the
 * password-changed email port binding).
 */
export function createAppAccountDeletedEmailPort(): AccountDeletedEmailPort {
  return createAccountDeletedEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
