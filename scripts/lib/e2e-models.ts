/**
 * The single source of truth for the model ids the E2E suite and the seed
 * drive. The live OpenRouter catalog must EXPOSE every one of them (E2E media
 * is mock-synthesized in-process, not cassette-replayed — the mock produces a
 * canned PNG/MP4 for any image/video model, so no per-id cassette exists — but
 * the send path still resolves the real catalog descriptor, so a hidden or
 * mis-classified id fails the turn).
 *
 * The catalog itself is always real/live — populated by `catalog:refresh`
 * (the same job the hourly production cron runs) against OpenRouter's public
 * metadata endpoints, never by hand-authored descriptors. This constant does
 * not describe models; it names the subset E2E depends on and lets the refresh
 * fail loud (`assertE2eModelsPresent`) when the live catalog no longer exposes
 * one, or exposes it under the wrong call-shape family — the signal to update
 * this set.
 *
 * The image/video ids are exposed STRICT-family ids: their descriptor `outputs`
 * are exactly `["image"]` / `["video"]`. That strictness is load-bearing — the
 * send path's `assertModelProducesModality` refuses a model whose `outputs`
 * aren't a single element equal to the requested modality, and a language-family
 * model (e.g. `["image","text"]`) echoes text through the mock instead of
 * synthesizing media. `assertE2eModelsPresent` enforces both exposure and
 * family agreement so a catalog drift back to a language-family id is caught at
 * `e2e:prepare`, not mid-test.
 *
 * Grouped by modality because the seed's group-chat factory (`pickSeedTextModels`)
 * and the app's model picker read exposed descriptors per call-shape family.
 *
 * NOTE (seedCandidateModels / SEED_MODEL_ID): `scripts/seed.ts`'s `SEED_MODEL_ID`
 * — the model stamped on seeded AI turns — must be one of `E2E_MODELS.text`, so
 * a seeded turn always references a model the live catalog exposes and the
 * picker can render.
 */
import { ModelDescriptor, callShapeFamilyFor } from '@hushbox/shared';
import { modelCatalog, type Database } from '@hushbox/db';
import { E2E_MODELS } from './e2e-model-ids.js';
import type { E2eModelSet } from './e2e-model-ids.js';
import type { CallShapeFamily } from '@hushbox/shared';

// The id data itself lives in the import-free `e2e-model-ids.ts` so db-banned
// e2e code can share it; re-exported here so existing consumers keep one path.
export { E2E_MODELS, e2eModelIds, type E2eModelSet } from './e2e-model-ids.js';

/** The call-shape family each `E2E_MODELS` bucket must classify into. */
const FAMILY_BY_BUCKET = {
  text: 'language',
  image: 'image',
  video: 'video',
} as const satisfies Record<keyof E2eModelSet, CallShapeFamily>;

/**
 * The exposure predicate, replicated from the models slice's `isExposed`
 * (`apps/api/.../list-descriptors.ts`) — scripts must not depend on `apps/api`,
 * so the fail-closed legs are inlined: a ZDR-unreachable model, an empty-pricing
 * model, or an unclassifiable/embedding call shape stays hidden and is unusable
 * from the send path. Kept in lockstep with the slice by construction (same
 * three legs, same shared `callShapeFamilyFor`).
 */
function isExposed(descriptor: ModelDescriptor, family: CallShapeFamily | undefined): boolean {
  if (!descriptor.zdrReachable) return false;
  if (Object.keys(descriptor.pricing).length === 0) return false;
  if (family === undefined || family === 'embedding') return false;
  return true;
}

/**
 * Validate one E2E model id against its stored descriptor, returning the failure
 * message or `undefined` when it passes both the exposure and family-agreement
 * checks. Split out of {@link assertE2eModelsPresent} to keep each unit simple.
 */
function validateE2eModel(id: string, bucket: keyof E2eModelSet, raw: unknown): string | undefined {
  if (raw === undefined) {
    return (
      `e2e model '${id}' is not in the live OpenRouter catalog — ` +
      'update E2E_MODELS, or the catalog refresh failed'
    );
  }
  const parsed = ModelDescriptor.safeParse(raw);
  if (!parsed.success) {
    return `e2e model '${id}' has a stored descriptor that fails its contract`;
  }
  const family = callShapeFamilyFor(parsed.data.outputs);
  if (!isExposed(parsed.data, family)) {
    return (
      `e2e model '${id}' is present but NOT exposed (needs zdrReachable, non-empty ` +
      'pricing, and a dispatchable non-embedding call shape) — pick an exposed id'
    );
  }
  const expectedFamily = FAMILY_BY_BUCKET[bucket];
  if (family !== expectedFamily) {
    return (
      `e2e model '${id}' is in the '${bucket}' bucket but its outputs ` +
      `[${parsed.data.outputs.join(', ')}] classify as '${String(family)}', not ` +
      `'${expectedFamily}' — the send path requires a strict-family match`
    );
  }
  return undefined;
}

/**
 * Fail-loud guard: every `E2E_MODELS` id must be a row in `model_catalog` whose
 * stored descriptor is (1) EXPOSED (the `isExposed` predicate above — mere row
 * presence let a hidden model slip through) AND (2) in the call-shape family its
 * bucket requires (`text`→language, `image`→image, `video`→video). Family
 * agreement catches a language-family model (e.g. `["image","text"]`) sitting in
 * the image bucket, which the send path would refuse. Any failure lists which id
 * failed which check, and stops the E2E pipeline before a test drives a model
 * the catalog can't back.
 */
export async function assertE2eModelsPresent(db: Database): Promise<void> {
  const rows = await db
    .select({ modelId: modelCatalog.modelId, descriptor: modelCatalog.descriptor })
    .from(modelCatalog);
  const byId = new Map(rows.map((row) => [row.modelId, row.descriptor]));

  const failures: string[] = [];
  for (const bucket of ['text', 'image', 'video'] as const) {
    for (const id of E2E_MODELS[bucket]) {
      const failure = validateE2eModel(id, bucket, byId.get(id));
      if (failure !== undefined) failures.push(failure);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}
