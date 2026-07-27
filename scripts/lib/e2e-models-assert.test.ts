import { describe, expect, it } from 'vitest';
import { E2E_MODELS, assertE2eModelsPresent, assertSeededImageModelPresent } from './e2e-models.js';
import { E2E_SEEDED_IMAGE_MODEL_ID } from './e2e-model-ids.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';

// `assertE2eModelsPresent` reads `model_catalog` and validates every E2E id is
// exposed and in its strict call-shape family. Here a fake `db.select().from()`
// returns hand-built descriptor rows (in the persisted wire form the models
// slice re-parses) so the exposure/family predicates are driven directly,
// without a live catalog.

/**
 * A persisted-wire-form descriptor: nano-USD pricing crosses the JSON boundary
 * as a string, so a stored descriptor uses string pricing (re-parsed by
 * `ModelDescriptor.safeParse`). Returned as `unknown` — the callee validates it.
 */
function descriptor(overrides: { outputs: readonly string[] } & Record<string, unknown>): unknown {
  return {
    id: 'x/y',
    provider: 'x',
    version: '1',
    inputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: { input: '1' },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 1_700_000_000,
    ...overrides,
  };
}

const OUTPUTS_BY_BUCKET = { text: ['text'], image: ['image'], video: ['video'] } as const;

/** Every E2E id mapped to a valid, exposed, strict-family descriptor. */
function validRows(): { modelId: string; descriptor: unknown }[] {
  return (['text', 'image', 'video'] as const).flatMap((bucket) =>
    E2E_MODELS[bucket].map((id) => ({
      modelId: id,
      descriptor: descriptor({ id, outputs: [...OUTPUTS_BY_BUCKET[bucket]] }),
    }))
  );
}

/**
 * The SQL of the WHERE clause the last catalog read applied. A fake handle
 * cannot enforce SQL semantics, so the sellability filter is pinned on the query
 * the guard actually builds.
 */
let lastWhereSql = '';

/**
 * The chain deliberately requires `.where(...)` and resolves nowhere else, so an
 * unfiltered catalog read fails every test in this file rather than only the one
 * asserting the clause.
 */
function fakeDb(rows: { modelId: string; descriptor: unknown }[]): Database {
  lastWhereSql = '';
  return {
    select: () => ({
      from: () => ({
        where: (condition: SQL): Promise<typeof rows> => {
          lastWhereSql = new PgDialect().sqlToQuery(condition).sql;
          return Promise.resolve(rows);
        },
      }),
    }),
  } as unknown as Database;
}

describe('assertE2eModelsPresent', () => {
  it('resolves when every id is present, exposed, and in its strict family', async () => {
    await expect(assertE2eModelsPresent(fakeDb(validRows()))).resolves.toBeUndefined();
  });

  it('reads only sellable rows, so a soft-deleted or kill-switched id cannot pass', async () => {
    await assertE2eModelsPresent(fakeDb(validRows()));
    // Asserted whole, not by substring: `or(...)` renders both of these null
    // checks too, and a disjunction would admit a soft-deleted row whose kill
    // switch happens to be clear — the exact regression this guard exists to
    // catch. Only the connective distinguishes them.
    expect(lastWhereSql).toBe(
      '("model_catalog"."excluded_reason" is null and "model_catalog"."admin_disabled_at" is null)'
    );
  });

  it('throws when an id is absent from the catalog', async () => {
    const rows = validRows().filter((row) => row.modelId !== E2E_MODELS.text[0]);
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow(
      'is not sellable in the live OpenRouter catalog'
    );
  });

  it('throws when a stored descriptor fails its contract', async () => {
    const rows = validRows();
    rows[0] = { modelId: E2E_MODELS.text[0], descriptor: { not: 'a descriptor' } };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow(
      'has a stored descriptor that fails its contract'
    );
  });

  it('throws when a model is not ZDR-reachable', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text'], zdrReachable: false }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow('present but NOT exposed');
  });

  it('throws when a model has empty pricing', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['text'], pricing: {} }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow('present but NOT exposed');
  });

  it('throws when a model classifies to the embedding call shape', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['embedding'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow('present but NOT exposed');
  });

  it('throws when a model has no classifiable call shape', async () => {
    const rows = validRows();
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: [] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow('present but NOT exposed');
  });

  it('throws when an exposed model is in the wrong bucket for its family', async () => {
    const rows = validRows();
    // A strict-image model sitting in the text bucket: exposed, but classifies
    // as 'image', not the required 'language'.
    rows[0] = {
      modelId: E2E_MODELS.text[0],
      descriptor: descriptor({ id: E2E_MODELS.text[0], outputs: ['image'] }),
    };
    await expect(assertE2eModelsPresent(fakeDb(rows))).rejects.toThrow(
      'the send path requires a strict-family match'
    );
  });
});

// The seed injects a second, synthetic strict-image model AFTER `catalog:refresh`
// (`E2E_SEEDED_IMAGE_MODEL_ID`), so the E2E catalog carries >=2 distinct exposed
// strict-image ids for a genuine image fan-out. This post-seed guard asserts the
// injected row landed and is exposed + strict-image — the pre-seed
// `assertE2eModelsPresent` cannot cover it because a synthetic id is (by design)
// absent from the live catalog it validates against.
describe('assertSeededImageModelPresent', () => {
  function seededRow(overrides: Record<string, unknown> = {}): {
    modelId: string;
    descriptor: unknown;
  } {
    return {
      modelId: E2E_SEEDED_IMAGE_MODEL_ID,
      descriptor: descriptor({ id: E2E_SEEDED_IMAGE_MODEL_ID, outputs: ['image'], ...overrides }),
    };
  }

  it('resolves when the seeded strict-image row is present and exposed', async () => {
    await expect(assertSeededImageModelPresent(fakeDb([seededRow()]))).resolves.toBeUndefined();
  });

  it('throws when the seeded row is absent', async () => {
    await expect(assertSeededImageModelPresent(fakeDb([]))).rejects.toThrow(
      'is not sellable in the live OpenRouter catalog'
    );
  });

  it('throws when the seeded row is not strict-image', async () => {
    await expect(
      assertSeededImageModelPresent(fakeDb([seededRow({ outputs: ['text'] })]))
    ).rejects.toThrow('the send path requires a strict-family match');
  });
});
