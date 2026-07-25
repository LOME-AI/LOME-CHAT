import { inArray, sql } from 'drizzle-orm';
import { deviceTokens } from '@hushbox/db';
import type { DbWriter } from '../../../lib/idempotency/transaction.js';

/**
 * How long a device may go unseen before its row is deleted. `lastSeenAt`
 * advances on every proof of life the system has — registration (each app
 * launch) and every successful delivery — so it only stops advancing once the
 * app is gone or its subscription is revoked. Half a year is far longer than
 * any plausible gap between two of those signals for a device still in use,
 * which keeps this delete off live rows; the reactive dead-target prune
 * (UNREGISTERED / 404 / 410 on send) is what removes gone devices promptly,
 * and this pass is the retention backstop for rows nothing sends to any more.
 */
export const DEVICE_TOKEN_STALE_DAYS = 180;

export interface DeviceTokenPurgeParams {
  readonly batchSize: number;
}

/** Deletes one bounded batch of stale device rows; returns how many went. */
export async function purgeStaleDeviceTokens(
  writer: DbWriter,
  params: DeviceTokenPurgeParams
): Promise<number> {
  const stale = writer
    .select({ id: deviceTokens.id })
    .from(deviceTokens)
    .where(
      sql`${deviceTokens.lastSeenAt} < now() - make_interval(days => ${DEVICE_TOKEN_STALE_DAYS})`
    )
    .limit(params.batchSize);
  const deleted = await writer
    .delete(deviceTokens)
    .where(inArray(deviceTokens.id, stale))
    .returning({ id: deviceTokens.id });
  return deleted.length;
}
