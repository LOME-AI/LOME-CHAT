# Research — multi-model-media IMAGE tests: catalog source & second strict-image model

Run: 2026-07-20-e2e-green. Read-only research. Task-17 / IC-4.

## 1. Where the E2E model catalog actually comes from — TRACED

The E2E app's `model_catalog` is populated from **LIVE OpenRouter**, not a
fixture/cassette/seed.

- `package.json:38` `e2e:prepare` = `ensure-stack --env-mode e2e && catalog:refresh
  --require-e2e-models && db:seed && e2e-clean`.
- `scripts/refresh-catalog.ts` runs the SAME real `refreshCatalog` job the hourly
  prod cron runs, with `fetch: globalThis.fetch` against `OPENROUTER_BASE_URL`.
- `OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'`
  (`apps/api/src/slices/models/adapters/openrouter-provider.ts:10`) — real host,
  hardcoded, NO E2E env override anywhere. Catalog metadata endpoints
  (`/models`, `/endpoints/zdr`, `/images/models` (+N+1 `/{id}/endpoints`),
  `/videos/models`) are hit LIVE (`apps/api/src/slices/models/domain/refresh.ts`,
  `gateway-metadata.ts`).
- `scripts/seed.ts` explicitly does NOT touch `model_catalog` (`scripts/seed.ts:21-27`,
  `:527`): "catalog is always real/live… no pinned, hand-authored descriptors."

Reconciling "gateway is mocked" vs "catalog is live": the mock is the **SEND
path** only. `resolve-model-provider.ts` swaps the OpenRouter inference provider
for `mock-provider.ts` (dev/E2E), which synthesizes a canned PNG/MP4 for ANY
image/video id. The **catalog/metadata** path is untouched and genuinely live.
Two separate concerns. So there is no per-id media cassette; the only gate on
which media models are selectable is the live catalog row.

## 2. Why only ONE strict-image model is exposable (verified against live OpenRouter today)

Exposure predicate (`scripts/lib/e2e-models.ts` `isExposed`, mirrors
`apps/api/.../list-descriptors.ts`): `zdrReachable` AND non-empty pricing AND a
classifiable non-embedding call-shape. "strict-image" = `outputs === ["image"]`
exactly (`callShapeFamilyFor` returns `image` only if `text` NOT in outputs;
`isRunnableModelShape` requires `outputs.length === 1` — shared/model-descriptor.ts:40,56).
`assertE2eModelsPresent` enforces exposure + family==image at refresh time.

Live query (2026-07-20) of `/images/models` ∩ `/endpoints/zdr`:
- 40 image entries; 28 are strict-`["image"]`.
- Of those, exactly **2** are ZDR-reachable: `bytedance-seed/seedream-4.5` and
  `microsoft/mai-image-2.5`.
- `microsoft/mai-image-2.5` prices `output_image` with `unit:"token"` → the
  normalizer excludes it as **`token-priced-image`** (`normalize.ts:213-220,268`) →
  it never lands in the catalog → NOT exposable.
- `bytedance-seed/seedream-4.5` prices `output_image` `unit:"image"` ($0.04/image)
  → per-image → exposed. The ONLY exposed strict-image ZDR model.

So the "only one" claim is TRUE today, but the cause is a legitimate
settlement gate excluding the one other live ZDR strict-image model — NOT that
only one such model exists on OpenRouter.

`IMAGE_MODELS` in the spec (`e2e/chat/multi-model-media.spec.ts:19`) =
`['bytedance-seed/seedream-4.5','bytedance-seed/seedream-4.5']` — same id twice,
sourced conceptually from `E2E_MODELS.image` (`scripts/lib/e2e-model-ids.ts:22`,
single id). The picker toggles selection per id, so `selectModelsByIds` selects
then DESELECTS → `data-selected` ends false → red before any fan-out assertion.

## 3. Cleanest way to get a genuine second strict-image ZDR-runnable model

Evaluated:
- (a) Add a second live id to `E2E_MODELS.image` — IMPOSSIBLE. The only other
  live ZDR strict-image id (`mai-image-2.5`) fails `assertE2eModelsPresent`
  (excluded as token-priced-image, so absent from the catalog).
- (b) Recorded cassette / fixture — N/A. The catalog is live, not cassette-served;
  there is no metadata fixture seam in the E2E path to add to.
- (c) Relax the `token-priced-image` gate to admit mai-image-2.5 — REJECTED. That
  gate is a founder-ruled settlement guard (a model we cannot settle per image is
  excluded, never exposed unpriced — normalize.ts:264-268). Relaxing it is a real
  product/billing behavior change, not a test fix, and would expose an
  un-settleable model in production.
- (d) RECOMMENDED — deterministic E2E-only synthetic second image model, decoupled
  from OpenRouter drift (this is exactly Task-17 AC1's "mock gateway + seed
  aligned"). The mock send-provider already renders a canned PNG for any image id
  (`mock-provider.ts`), so nothing else is needed on the send side. Concretely:
  1. After `catalog:refresh`, have the E2E `db:seed` step upsert ONE synthetic
     strict-`["image"]`, `zdrReachable:true`, per-image-priced descriptor row into
     `model_catalog` (e.g. id `hushbox-e2e/mock-image-2`). `upsertCatalog` exists
     (`apps/api/src/slices/models/domain/catalog-store.ts:56`) but is not yet on
     the dev-seed barrel — expose it via `apps/api/src/platform/dev/seed-toolkit.ts`
     + `apps/api/src/slices/models/index.ts`.
  2. Keep the synthetic id OUT of `E2E_MODELS.image` (that set is validated at
     refresh time, BEFORE seed, against the live catalog — a synthetic id would
     fail the pre-seed live assertion). Put it in a new E2E-seed-only constant
     shared with the spec (e.g. `E2E_SEEDED_IMAGE_MODEL_ID` in
     `scripts/lib/e2e-model-ids.ts`), or move the ≥2-strict-image assertion to a
     post-seed check.
  3. `e2e/chat/multi-model-media.spec.ts`: `IMAGE_MODELS = ['bytedance-seed/seedream-4.5',
     '<seeded id>']` — two distinct ids; delete the intentionally-red comment block;
     assertion intent unchanged.

  This makes the image fan-out genuinely 2-distinct (non-vacuous), deterministic,
  and independent of OpenRouter dropping seedream from ZDR (which today would break
  E2E outright).

## 4. "Intentionally red" documentation to remove (founder directive)

PRIMARY (the load-bearing in-spec claim, must be deleted):
- `e2e/chat/multi-model-media.spec.ts:7-18` — the "run RED / kept red rather than
  dark until a second strict-image model is ZDR-exposed" comment block, plus the
  duplicate-id `IMAGE_MODELS` on line 19.

Process/research docs that restate it (update to reflect the resolution; not test
gates but the sweep in Task-17 AC5 covers them):
- `docs/plans/runs/2026-07-20-e2e-green/research/media-gen.md` — "Root Cause D …
  KNOWN-RED / INTENT CONFLICT" section (~L197-220).
- `docs/plans/runs/2026-07-20-e2e-green/plan.md` — Task-17, IC-4.
- `docs/plans/runs/2026-07-20-e2e-green/ledger.md`.
- `docs/plans/CODEBASE-AUDIT-2026-07-12.md`, `…-2026-07-18.md` (audit mentions).

## File list for the fix
- `e2e/chat/multi-model-media.spec.ts` (IMAGE_MODELS + remove red comment)
- `scripts/lib/e2e-model-ids.ts` (new seeded-image constant)
- `scripts/lib/e2e-models.ts` (validate 2nd id post-seed, if assertion extended)
- `scripts/seed.ts` (upsert synthetic strict-image catalog row)
- `apps/api/src/platform/dev/seed-toolkit.ts` + `apps/api/src/slices/models/index.ts`
  (expose `upsertCatalog` to the seed)
