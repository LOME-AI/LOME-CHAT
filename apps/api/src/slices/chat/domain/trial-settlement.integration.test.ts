import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  createDb,
  idempotencyKeys,
  ledgerEntries,
  messages,
  usageRecords,
} from '@hushbox/db';
import { createFencedSettlementHook, keyRowCompletion } from '../../workflows/index.js';
import { claimKeyRow } from '../../../lib/idempotency/index.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { createTrialSettlementCommit } from './trial.js';
import type { SettlementRequest } from '@hushbox/shared';

/**
 * Trial settlement is no-persist / no-charge. The fenced runner still flips the
 * idempotency-key row (so a trial resubmit replays), but the trial commit
 * writes ZERO domain rows — no message, content, usage, or ledger legs. The
 * key-row scope is the trial session id (a uuid), never a wallet or user.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for trial settlement integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const createdKeyRowIds: string[] = [];

afterAll(async () => {
  if (createdKeyRowIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.id, createdKeyRowIds));
  }
  await db.$client.end();
});

async function claimTrialFence(
  sessionId: string,
  runKey: string,
  runId: string
): Promise<{ id: string; executorId: string; claims: number }> {
  const executorId = crypto.randomUUID();
  const claimed = await claimKeyRow(db, {
    // Trial scopes the key row on the session id (a uuid), never a user/wallet.
    scope: { userId: sessionId, route: CHAT_TURN_ROUTE, key: runKey },
    kind: 'run',
    bodyHash: 'body-hash',
    executorId,
    leaseSeconds: 90,
    runId,
  });
  const claim = claimed._unsafeUnwrap();
  if (claim.outcome !== 'executor') throw new Error('expected a fresh executor claim');
  createdKeyRowIds.push(claim.row.id);
  return { id: claim.row.id, executorId, claims: claim.row.claims };
}

/** A trial run always surfaces a text output + a charge; the commit must ignore both. */
function request(runKey: string): SettlementRequest {
  return {
    runKey,
    outputs: { answer: { kind: 'text', text: 'echo:hello' } },
    charges: [
      {
        key: 'answer',
        modelId: 'trial/model',
        providerName: 'trial-provider',
        modality: 'text',
        generationId: 'gen-1',
        baseCostNanoUsd: 1000n,
        isEstimated: false,
      },
    ],
  };
}

describe('trial settlement commit (no-persist / no-charge)', () => {
  it('flips the key row to succeeded and writes zero domain rows', async () => {
    const sessionId = crypto.randomUUID();
    const runKey = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const fence = await claimTrialFence(sessionId, runKey, runId);

    const hook = createFencedSettlementHook({
      db,
      fence,
      complete: keyRowCompletion({ runId }),
      commit: createTrialSettlementCommit(),
    });
    await hook(request(runKey));

    // The key row flipped — a resubmit replays rather than re-executes.
    const keyRows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, fence.id));
    expect(keyRows[0]?.status).toBe('succeeded');

    // No content, no charges: nothing was saved, so nothing was billed.
    expect(await db.select().from(messages).where(eq(messages.senderId, sessionId))).toHaveLength(
      0
    );
    expect(await db.select().from(usageRecords).where(eq(usageRecords.runId, runId))).toHaveLength(
      0
    );
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, runId))
    ).toHaveLength(0);
    expect(
      await db.select().from(contentItems).where(eq(contentItems.modelId, 'trial/model'))
    ).toHaveLength(0);
  });
});
