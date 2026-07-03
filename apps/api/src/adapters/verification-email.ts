import { getContext } from 'hono/context-storage';
import { createEmailSenderFromEnv, verificationEmail } from '../slices/notifications/index.js';
import type { EmailSender } from '../slices/notifications/index.js';
import type { VerificationEmailPort } from '../slices/identity/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { AppEnv } from '../lib/context/index.js';
import type { Telemetry } from '../lib/telemetry/index.js';

export const VERIFICATION_EMAIL_SUBJECT = 'Verify your email address';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface VerificationEmailSendDeps {
  readonly sender: EmailSender;
  readonly frontendUrl: string;
  readonly logger: Telemetry;
}

/**
 * The composition-root adapter behind identity's VerificationEmailPort:
 * composes the notifications slice's verification template + EmailSender and
 * owns the frontend-link construction (the domain passes a bare token). The
 * port contract is best-effort — the domain ignores a failed Result — so
 * send-failure observability lives here: the failure's error code goes
 * through the typed logger (codes only, never the address or content), and
 * the failure still returns on the error channel for callers that do look.
 */
export function createVerificationEmailAdapter(
  resolve: () => VerificationEmailSendDeps
): VerificationEmailPort {
  return {
    sendVerificationEmail(args) {
      const { sender, frontendUrl, logger } = resolve();
      const link = new URL('/verify', frontendUrl);
      link.searchParams.set('token', args.token);
      const content = verificationEmail({
        verificationUrl: link.toString(),
        ...(args.userName === undefined ? {} : { userName: args.userName }),
      });
      return sender
        .send({
          to: args.to,
          subject: VERIFICATION_EMAIL_SUBJECT,
          html: content.html,
          text: content.text,
        })
        .mapErr((error) => {
          logger.warn('verification email send failed', { errorCode: error.code });
          return error;
        });
    },
  };
}

/**
 * Extends EnvContext (the `EmailSenderEnv` pattern): a weak all-optional
 * shape would fail assignability from `Bindings`, which declares neither var.
 */
interface FrontendUrlEnv extends EnvContext {
  readonly FRONTEND_URL?: string;
}

function requireFrontendUrl(env: FrontendUrlEnv): string {
  if (env.FRONTEND_URL === undefined || env.FRONTEND_URL === '') {
    throw new Error('FRONTEND_URL is required to build the verification link');
  }
  return env.FRONTEND_URL;
}

/**
 * The production binding: identity's route deps take ONE static port object,
 * but the sender selection (env), the evidence db, and the request logger
 * only exist per invocation on Workers — so each send resolves them from the
 * current request via hono's context storage (the `contextStorage()`
 * middleware the app assembly installs; AsyncLocalStorage under
 * `nodejs_compat`). Sender construction is instance-per-send by design —
 * the dev-link escape hatch in identity's routes documents that the local
 * mock holds no cross-request state. Missing FRONTEND_URL is a deployment
 * misconfiguration: a fail-fast defect, never a silently unsent email.
 */
export function createAppVerificationEmailPort(): VerificationEmailPort {
  return createVerificationEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return {
      sender: createEmailSenderFromEnv(c.env, c.var.db),
      frontendUrl: requireFrontendUrl(c.env),
      logger: c.var.logger,
    };
  });
}
