import type { SessionOptions } from 'iron-session';

export const SESSION_COOKIE_NAME = 'hushbox_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionData {
  sessionId: string;
  userId: string;
  email: string | null;
  username: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
  pending2FA: boolean;
  pending2FAExpiresAt: number;
  createdAt: number;
  /** When true, session is restricted to billing routes only (mobile → web handoff) */
  billingOnly?: boolean;
}

export function getSessionOptions(secret: string, isProduction: boolean): SessionOptions {
  return {
    password: secret,
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  };
}
