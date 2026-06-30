import { brandSettlementTx } from './brands.js';
import type { Database } from '@hushbox/db';
import type { SettlementTx } from './brands.js';

/**
 * The settlement entry point — the ONLY place a `SettlementTx` is minted.
 * Every money `*WithinTx` helper requires the branded handle, so
 * transactional composition is a capability handed down from here, never a
 * convention. The body runs in one interactive transaction: a throw rolls
 * back every write (nothing commits mid-run).
 */
export function runSettlement<T>(db: Database, body: (tx: SettlementTx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => body(brandSettlementTx(tx)));
}
