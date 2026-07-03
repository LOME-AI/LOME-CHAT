import { getContext } from 'hono/context-storage';
import { createEmailSenderFromEnv, passwordChangedEmail } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { PasswordChangedEmailPort } from '../slices/identity/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const PASSWORD_CHANGED_EMAIL_SUBJECT = 'Your password was changed';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface PasswordChangedEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind identity's PasswordChangedEmailPort:
 * composes the notifications slice's password-changed template + EmailSender.
 * The port contract is best-effort — the domain ignores a failed Result — so
 * send-failure observability lives here: the failure's error code goes
 * through the typed logger (codes only, never the address or content), and
 * the failure still returns on the error channel for callers that do look.
 */
export function createPasswordChangedEmailAdapter(
  resolve: () => PasswordChangedEmailSendDeps
): PasswordChangedEmailPort {
  return {
    sendPasswordChangedEmail(args) {
      const { sender, logger } = resolve();
      const content = passwordChangedEmail(
        args.userName === undefined ? {} : { userName: args.userName }
      );
      return sender
        .send({
          to: args.to,
          subject: PASSWORD_CHANGED_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('password-changed email send failed', { errorCode: error.code });
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
 * verification-email port binding).
 */
export function createAppPasswordChangedEmailPort(): PasswordChangedEmailPort {
  return createPasswordChangedEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
