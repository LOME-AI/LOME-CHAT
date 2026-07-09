import { getContext } from 'hono/context-storage';
import { createEmailSenderFromEnv, twoFactorEnabledEmail } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { TwoFactorEnabledEmailPort } from '../slices/identity/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const TWO_FACTOR_ENABLED_EMAIL_SUBJECT = 'Two-factor authentication enabled';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface TwoFactorEnabledEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind identity's TwoFactorEnabledEmailPort:
 * composes the notifications slice's 2FA-enabled template + EmailSender. The
 * port contract is best-effort — the enrollment flow ignores a failed Result —
 * so send-failure observability lives here: the failure's error code goes
 * through the typed logger (codes only, never the address), and the failure
 * still returns on the error channel for callers that do look.
 */
export function createTwoFactorEnabledEmailAdapter(
  resolve: () => TwoFactorEnabledEmailSendDeps
): TwoFactorEnabledEmailPort {
  return {
    sendTwoFactorEnabledEmail(args) {
      const { sender, logger } = resolve();
      const content = twoFactorEnabledEmail(
        args.userName === undefined ? {} : { userName: args.userName }
      );
      return sender
        .send({
          to: args.to,
          subject: TWO_FACTOR_ENABLED_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('2fa-enabled email send failed', { errorCode: error.code });
          return error;
        });
    },
  };
}

/**
 * The production binding: identity's route deps take ONE static port object,
 * but the sender selection (env), the evidence db, and the request logger only
 * exist per invocation on Workers — so each send resolves them from the current
 * request via hono's context storage (the password-changed port's shape).
 */
export function createAppTwoFactorEnabledEmailPort(): TwoFactorEnabledEmailPort {
  return createTwoFactorEnabledEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
