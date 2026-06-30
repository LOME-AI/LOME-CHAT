import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { runSettlement } from './settlement.js';
import type { SettlementTx } from './brands.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for idempotency integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];

function freshUserId(): string {
  const userId = crypto.randomUUID();
  createdUserIds.push(userId);
  return userId;
}

/** A money-write stand-in: the signature every `*WithinTx` helper uses. */
async function writeWithinTx(tx: SettlementTx, userId: string): Promise<void> {
  await tx.insert(idempotencyKeys).values({
    userId,
    route: '/settlement',
    key: crypto.randomUUID(),
    kind: 'run',
    bodyHash: 'settled',
    claimedBy: 'settler',
  });
}

async function countRows(userId: string): Promise<number> {
  const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
  return rows.length;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.userId, createdUserIds));
  }
  await db.$client.end();
});

describe('runSettlement', () => {
  it('hands the body a settlement handle whose writes commit atomically', async () => {
    const userId = freshUserId();
    const outcome = await runSettlement(db, async (tx) => {
      await writeWithinTx(tx, userId);
      await writeWithinTx(tx, userId);
      return 'settled';
    });
    expect(outcome).toBe('settled');
    expect(await countRows(userId)).toBe(2);
  });

  it('rolls back every write when the body throws', async () => {
    const userId = freshUserId();
    await expect(
      runSettlement(db, async (tx) => {
        await writeWithinTx(tx, userId);
        throw new Error('settlement aborted');
      })
    ).rejects.toThrow('settlement aborted');
    expect(await countRows(userId)).toBe(0);
  });

  it('rejects a plain transaction where the settlement capability is required', () => {
    const requireSettlement = (tx: SettlementTx): SettlementTx => tx;
    const witness = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]): void => {
      // @ts-expect-error — only runSettlement can mint SettlementTx; a plain transaction cannot carry money writes
      requireSettlement(tx);
    };
    expect(typeof witness).toBe('function');
  });
});
