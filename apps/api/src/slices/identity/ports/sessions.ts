import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RedisClient } from './auth-state.js';

/**
 * The three session shapes this slice issues. `full` and `pending-2fa` come
 * from the login flow; `billing-only` is consumed by the billing-portal
 * token login (the mobile → web handoff), which restricts the session to
 * `billing-token`-class routes via the principal derivation.
 */
export type SessionKind = 'full' | 'pending-2fa' | 'billing-only';

export interface IssueSessionArgs {
  readonly request: Request;
  readonly response: Response;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly userId: string;
  readonly kind: SessionKind;
  readonly now: number;
}

export interface DestroyCookieArgs {
  readonly request: Request;
  readonly response: Response;
  readonly secret: string;
  readonly isProduction: boolean;
}

/** Session issuance and revocation over the sealed cookie + sessionActive key. */
export interface SessionManager {
  issue(args: IssueSessionArgs): ResultAsync<{ readonly sessionId: string }, DomainError>;
  revoke(session: {
    readonly userId: string;
    readonly sessionId: string;
  }): ResultAsync<void, DomainError>;
  destroyCookie(args: DestroyCookieArgs): Promise<void>;
}

/** Constructed per request from the pipeline's `c.var.redis`. */
export type SessionManagerFactory = (redis: RedisClient) => SessionManager;
