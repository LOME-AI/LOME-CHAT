import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, users, wallets } from '@hushbox/db';
import { createBillingStores } from '../../billing/index.js';
import { buildSmartModelTurnDefinition } from './smart-model-turn.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for smart-model-turn integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([4, 4, 4]);
// The `chat-route` prefix survives the chat route suite's foreign-row catalog
// isolation delete, so a concurrent run never drops this suite's model.
const MODEL = `chat-route-smart/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL]));
  await db.$client.end();
});

async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function seedRichUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@smart-turn.test`,
      username: `sm${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  // A large purchased balance keeps every exposed text model affordable, so a
  // candidate is always derivable regardless of concurrent catalog rows.
  await db
    .insert(wallets)
    .values({ userId: id, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n });
  return id;
}

describe('buildSmartModelTurnDefinition without a budget', () => {
  it('builds an uncapped answer node (the omitted-budget defensive path)', async () => {
    await seedModel();
    const userId = await seedRichUser();
    const build = await buildSmartModelTurnDefinition(
      { db, telemetry: silentTelemetry, billing: createBillingStores() },
      { userId, now: new Date() }
    );
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    // No budget → no derived ceiling → the answer call keeps the model default,
    // so the node carries the schema's empty params default.
    expect(node?.type === 'smartModel' && node.params).toEqual({});
  });
});
