import { and, eq } from 'drizzle-orm';
import { epochs } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/**
 * The `epochs` wrap-key read this slice publishes (single writer of `epochs`):
 * the chat settlement and the runless user-only writer wrap content to the key
 * this returns; neither ever reaches the `epochs` table itself. Runs on the
 * transaction it is handed.
 *
 * Lives in its own module — NOT in realtime-room-bindings.ts, whose canonical
 * room wiring value-imports the `@hushbox/realtime` barrel (its DO class
 * imports `cloudflare:workers`, which cannot load in node-environment tests)
 * and is therefore barred from the barrel graph. This module imports only
 * drizzle + the db schema, so barrel consumers stay node-safe with no mocks.
 */
async function readEpochPublicKey(
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
): Promise<Uint8Array | null> {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
}

export function createEpochPublicKeyReader(): typeof readEpochPublicKey {
  return readEpochPublicKey;
}
