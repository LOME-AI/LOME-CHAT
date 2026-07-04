import { getContext } from 'hono/context-storage';
import { createEmailSenderFromEnv, welcomeEmail } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { WelcomeEmailPort } from '../slices/billing/index.js';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const WELCOME_EMAIL_SUBJECT = 'Welcome to HushBox';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface WelcomeEmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind billing's WelcomeEmailPort: composes
 * the notifications slice's welcome template + EmailSender (the same shape
 * as the password-changed port binding). The port contract is best-effort —
 * billing ignores a failed Result — so send-failure observability lives
 * here: the failure's error code goes through the typed logger (codes only,
 * never the address or content), and the failure still returns on the error
 * channel for callers that do look.
 */
export function createWelcomeEmailAdapter(resolve: () => WelcomeEmailSendDeps): WelcomeEmailPort {
  return {
    sendWelcomeEmail(args) {
      const { sender, logger } = resolve();
      const content = welcomeEmail(args.userName === undefined ? {} : { userName: args.userName });
      return sender
        .send({
          to: args.to,
          subject: WELCOME_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('welcome email send failed', { errorCode: error.code });
          return error;
        });
    },
  };
}

/**
 * The production binding: billing's provisioning takes ONE static port
 * object, but the sender selection (env), the evidence db, and the request
 * logger only exist per invocation on Workers — so each send resolves them
 * from the current request via hono's context storage.
 */
export function createAppWelcomeEmailPort(): WelcomeEmailPort {
  return createWelcomeEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      logger: c.var.logger,
    };
  });
}
