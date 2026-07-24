import { describe, expect, it } from 'vitest';
import {
  ModelDescriptor,
  applyMarkupCeil,
  callShapeFamilyFor,
  isRunnableModelShape,
} from '@hushbox/shared';
import { DESCRIPTOR_VERSION } from '@hushbox/api/dev-seed';
import { E2E_MODELS } from './e2e-model-ids.js';
import { E2E_SEEDED_IMAGE_MODEL_ID, seededImageModelUpsert } from './e2e-seeded-image-model.js';

// `seededImageModelUpsert` builds the ONE synthetic strict-image catalog row the
// E2E seed injects after `catalog:refresh`, so `multi-model-media.spec.ts` has a
// genuine SECOND exposed strict-image id to fan out over (the live OpenRouter
// catalog exposes only one — seedream-4.5 — because the other live ZDR
// strict-image model is token-priced and excluded at settlement). These tests
// pin the descriptor against the SAME shared predicates the send path and the
// catalog exposure gate use, so a synthetic that would be hidden or
// mis-classified fails here, not mid-test.

describe('seededImageModelUpsert', () => {
  const fetchedAt = new Date('2026-07-20T00:00:00.000Z');
  const params = seededImageModelUpsert(fetchedAt);

  it('is keyed by the shared seeded-image id and echoes the fetched-at stamp', () => {
    expect(params.modelId).toBe(E2E_SEEDED_IMAGE_MODEL_ID);
    expect(params.content.id).toBe(E2E_SEEDED_IMAGE_MODEL_ID);
    expect(params.fetchedAt).toBe(fetchedAt);
  });

  it('is an unranked media row (no popularity rank)', () => {
    expect(params.popularityRank).toBeNull();
  });

  it('builds a descriptor that satisfies the ModelDescriptor contract as-is (the seed parse path)', () => {
    // Exactly what `upsertCatalog` parses: content + fetchedAt, nothing patched.
    // A missing/stale `version` fails here, not mid-`pnpm db:seed`.
    const parsed = ModelDescriptor.safeParse({
      ...params.content,
      fetchedAt: fetchedAt.getTime(),
    });
    expect(parsed.success).toBe(true);
  });

  it('stamps the current descriptor version (v2 = billable rates)', () => {
    expect(params.content.version).toBe(DESCRIPTOR_VERSION);
  });

  it('stores the BILLABLE per-image rate — ceil markup over the $0.04 provider rate', () => {
    // Same invariant the live seedream-4.5 row is pinned to: catalog rates are
    // billable (after-fee), never raw provider rates.
    expect(params.content.pricing['perImage']).toBe(applyMarkupCeil(40_000_000n).toString());
    expect(params.content.pricing['perImage']).toBe('46000000');
  });

  it('is a runnable, strict-["image"] call shape', () => {
    expect(params.content.outputs).toEqual(['image']);
    expect(callShapeFamilyFor(params.content.outputs)).toBe('image');
    expect(
      isRunnableModelShape({ inputs: params.content.inputs, outputs: params.content.outputs })
    ).toBe(true);
  });

  it('is exposable: ZDR-reachable with a per-image price', () => {
    expect(params.content.zdrReachable).toBe(true);
    expect(Object.keys(params.content.pricing).length).toBeGreaterThan(0);
    expect(params.content.pricing['perImage']).toMatch(/^[1-9]\d*$/);
  });

  it('is a SECOND, distinct image id — kept out of the live-validated E2E_MODELS set', () => {
    expect(E2E_MODELS.image).not.toContain(E2E_SEEDED_IMAGE_MODEL_ID);
    for (const liveImageId of E2E_MODELS.image) {
      expect(E2E_SEEDED_IMAGE_MODEL_ID).not.toBe(liveImageId);
    }
  });
});
