/**
 * The `/me` bootstrap contract the web client restores a session from — the
 * single source both the API client and the auth flow read, replacing the
 * former local redeclaration in `apps/web/src/lib/auth-client.ts` (which drifted
 * against this shape).
 *
 * `passwordWrappedPrivateKey` / `publicKey` are optional here because the client
 * treats a session that lacks them as unrecoverable rather than a type error;
 * `pending2FA` marks a half-authenticated principal, and
 * `customInstructionsEncrypted` rides along for the session-restore decrypt.
 */
export interface MeResponse {
  user: {
    id: string;
    email: string;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
  };
  pending2FA?: true;
  passwordWrappedPrivateKey?: string;
  publicKey?: string;
  customInstructionsEncrypted?: string | null;
}
