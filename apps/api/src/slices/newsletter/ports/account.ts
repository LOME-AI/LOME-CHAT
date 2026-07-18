import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The settings routes' view of the caller's account: just the email. The
 * composition root binds identity's published users store (structurally
 * compatible) — the newsletter slice never reads the `users` table itself.
 */
export interface AccountEmailReader {
  findById(userId: string): ResultAsync<{ readonly email: string } | null, DomainError>;
}

/** Constructed per request from the pipeline's `c.var.db`. */
export type AccountEmailReaderFactory = (db: Database) => AccountEmailReader;
