import { getContext } from 'hono/context-storage';
import { accountLockedEmail, createEmailSenderFromEnv } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { AccountLockedEmailPort } from '../slices/identity/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const LOGIN_LOCKOUT_EMAIL_SUBJECT = 'Your account has been temporarily locked';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface LoginLockoutEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind identity's AccountLockedEmailPort:
 * composes the notifications slice's failed-sign-in `accountLockedEmail`
 * template (distinct from billing's chargeback-lock notification) + the
 * EmailSender. The port contract is best-effort — the login flow ignores a
 * failed Result — so send-failure observability lives here: the failure's
 * error code goes through the typed logger (codes only, never the address),
 * and the failure still returns on the error channel for callers that do look.
 */
export function createLoginLockoutEmailAdapter(
  resolve: () => LoginLockoutEmailSendDeps
): AccountLockedEmailPort {
  return {
    sendAccountLockedEmail(args) {
      const { sender, logger } = resolve();
      const content = accountLockedEmail({
        lockoutMinutes: args.lockoutMinutes,
        ...(args.userName === undefined ? {} : { userName: args.userName }),
      });
      return sender
        .send({
          to: args.to,
          subject: LOGIN_LOCKOUT_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('login-lockout email send failed', { errorCode: error.code });
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
export function createAppLoginLockoutEmailPort(): AccountLockedEmailPort {
  return createLoginLockoutEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
