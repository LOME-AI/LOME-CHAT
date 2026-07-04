import { getContext } from 'hono/context-storage';
import { chargebackLockEmail, createEmailSenderFromEnv } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { AccountLockedEmailPort } from '../slices/billing/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const ACCOUNT_LOCKED_EMAIL_SUBJECT = 'Your account was locked';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface AccountLockedEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind billing's AccountLockedEmailPort:
 * composes the notifications slice's chargeback-lock template + EmailSender.
 * The port contract is best-effort — the dispute flow ignores a failed
 * Result — so send-failure observability lives here: the failure's error
 * code goes through the typed logger (codes only, never the address), and
 * the failure still returns on the error channel for callers that do look.
 */
export function createAccountLockedEmailAdapter(
  resolve: () => AccountLockedEmailSendDeps
): AccountLockedEmailPort {
  return {
    sendAccountLockedEmail(args) {
      const { sender, logger } = resolve();
      const content = chargebackLockEmail({});
      return sender
        .send({
          to: args.to,
          subject: ACCOUNT_LOCKED_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('account-locked email send failed', { errorCode: error.code });
          return error;
        });
    },
  };
}

/**
 * The production binding: billing's route deps take ONE static port object,
 * but the sender selection (env), the evidence db, and the request logger
 * only exist per invocation on Workers — so each send resolves them from the
 * current request via hono's context storage (the password-changed email
 * port's shape).
 */
export function createAppAccountLockedEmailPort(): AccountLockedEmailPort {
  return createAccountLockedEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
