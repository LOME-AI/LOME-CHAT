import { getContext } from 'hono/context-storage';
import { verificationEmail } from '../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { VerificationEmailPort } from '../slices/identity/index.js';
import type { EnvContext } from '@hushbox/shared';
import type { AppEnv } from '../lib/context/index.js';

export const VERIFICATION_EMAIL_SUBJECT = 'Verify your email address';

/** The shared send deps plus the frontend base URL this port owns. */
export interface VerificationEmailSendDeps extends EmailSendDeps {
  readonly frontendUrl: string;
}

/**
 * The composition-root adapter behind identity's VerificationEmailPort:
 * composes the notifications slice's verification template, owns the
 * frontend-link construction (the domain passes a bare token), and sends it
 * through the shared compose-and-send seam. Best-effort — the domain ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
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
      return sendComposedEmail(
        { sender, logger },
        {
          to: args.to,
          subject: VERIFICATION_EMAIL_SUBJECT,
          content,
          logFailure: (log, errorCode) => {
            log.warn('verification email send failed', { errorCode });
          },
        }
      );
    },
  };
}

/**
 * Extends EnvContext (the `EmailSenderEnv` pattern): a weak all-optional shape
 * would fail assignability from `Bindings`, which declares neither var.
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
 * The production binding: resolves the env sender + request logger per send
 * (single-sourced) and adds the frontend base URL. Missing FRONTEND_URL is a
 * deployment misconfiguration: a fail-fast defect, never a silently unsent
 * email.
 */
export function createAppVerificationEmailPort(): VerificationEmailPort {
  return createVerificationEmailAdapter(() => {
    const c = getContext<AppEnv>();
    return { ...resolveEmailSendDeps(), frontendUrl: requireFrontendUrl(c.env) };
  });
}
