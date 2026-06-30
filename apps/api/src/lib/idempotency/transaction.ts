import type { Database } from '@hushbox/db';

/**
 * The Drizzle interactive-transaction handle, derived (never duplicated) from
 * the client's own `transaction` signature.
 */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything key-row writes can run on: the client or an open transaction. */
export type DbWriter = Database | DbTransaction;
