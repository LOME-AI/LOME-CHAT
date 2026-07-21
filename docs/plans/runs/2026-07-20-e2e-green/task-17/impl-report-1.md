# Task-17 impl-report-1 — second strict-image model in E2E catalog; kill the known-red image tests

## Objective

Give the E2E catalog a genuine second exposed strict-`["image"]` ZDR model so
`multi-model-media.spec.ts`'s image fan-out selects two DISTINCT ids and passes,
via option (d): inject an E2E/dev-seed synthetic strict-image catalog row through
the models slice's published `upsertCatalog` barrel (respecting single-writer).
Remove the "intentionally red" marker on those tests and sweep the repo for the
same marker class.

## Design

- The live OpenRouter catalog exposes exactly ONE ZDR strict-image model
  (seedream-4.5); the only other live ZDR strict-image model (mai-image-2.5) is
  token-priced → excluded at settlement (`token-priced-image`, a founder-ruled
  guard, not relaxable). So a real second live id is impossible.
- Fix: the seed upserts one synthetic strict-image descriptor
  (`hushbox-e2e/mock-image-2`) AFTER `catalog:refresh`, keyed by a new seed-only
  constant kept OUT of `E2E_MODELS.image` (that set is validated against the LIVE
  catalog BEFORE the seed injects the row — a synthetic id would fail the
  pre-seed live assertion). The mock send-provider renders a canned PNG for any
  image id, so nothing is needed on the send side.
- Descriptor mirrors a real per-image model exactly: `outputs:["image"]`,
  `inputs:["text"]` (runnable), `zdrReachable:true`, `pricing.perImage` = 40 000 000
  nano-USD ($0.04, same as seedream, so admission/settlement price it normally),
  fixed well-past `releasedAt` (no premium-recency gate can hide it).
- Single-writer respected: seed calls `upsertCatalog` (models slice barrel →
  `@hushbox/api/dev-seed`), never a raw `model_catalog` insert.
- No mode-gating: the seed is a single no-branching path; its `assertLocalDatabaseUrl`
  guard already makes the synthetic row impossible to reach production. Dev also
  gets the row (harmless — mock renders it).
- Default-image-model safety: `use-resolve-default-model` (Task-16, landed) picks
  the highest-ranked eligible model with a model-id `localeCompare` tie-break;
  both seedream and the synthetic are unranked, and `bytedance/...` sorts before
  `hushbox-e2e/...`, so seedream stays the default image model. Verified by code
  read, not by run.

## Files changed (path — why)

- `apps/api/src/slices/models/domain/index.ts` — export `upsertCatalog` +
  `UpsertCatalogParams` from the domain barrel.
- `apps/api/src/slices/models/index.ts` — re-export both from the slice barrel.
- `apps/api/src/platform/dev/seed-toolkit.ts` — re-export both on the
  `@hushbox/api/dev-seed` seed surface (single sanctioned path scripts use).
- `scripts/lib/e2e-model-ids.ts` — add import-free `E2E_SEEDED_IMAGE_MODEL_ID`
  (shared with the db-banned spec).
- `scripts/lib/e2e-seeded-image-model.ts` (new) — pure `seededImageModelUpsert(fetchedAt)`
  builder returning `UpsertCatalogParams`.
- `scripts/lib/e2e-models.ts` — add `assertSeededImageModelPresent(db)` post-seed
  guard; extract shared `readCatalogDescriptors(db)` (kills a jscpd clone).
- `scripts/seed.ts` — `seedSyntheticImageModel(db)`: upsert via barrel + assert;
  called first in `runSeed`.
- `scripts/seed-run.test.ts` — mock `upsertCatalog` + `assertSeededImageModelPresent`;
  cover the new upsert + fail-loud path.
- `e2e/chat/multi-model-media.spec.ts` — `IMAGE_MODELS = [seedream, E2E_SEEDED_IMAGE_MODEL_ID]`;
  remove the intentionally-red comment block; import the seeded id.
- `docs/plans/runs/2026-07-20-e2e-green/research/media-gen.md` — RC-D marked
  RESOLVED (diagnosis retained for provenance); removed the known-red/intent-conflict
  license and the `test.fixme` suggestion.

## Tests added (TDD; name — behavior — criterion)

- `scripts/lib/e2e-seeded-image-model.test.ts` (new, 6 tests): the built descriptor
  is a runnable strict-`["image"]` shape (`isRunnableModelShape`,
  `callShapeFamilyFor==='image'`), is exposable (ZDR + `perImage` price), satisfies
  the `ModelDescriptor` contract, is unranked, echoes `fetchedAt`, and is a SECOND
  distinct id absent from `E2E_MODELS.image` — pins AC1/AC2 at the catalog layer.
- `scripts/lib/e2e-models-assert.test.ts` (+3): `assertSeededImageModelPresent`
  resolves when the seeded strict-image row is present/exposed, throws when absent,
  throws when not strict-image — pins the post-seed ≥2 guard.
- `scripts/seed-run.test.ts` (+2): `runSeed` upserts the synthetic row through the
  slice barrel with `outputs:["image"]`; fails loud when the upsert errors.

TDD: wrote the two new test targets first, ran them RED (`assertSeededImageModelPresent
is not a function`; module not found), then implemented to GREEN.

## Self-gate (command — result)

- `vitest run` new/changed scripts tests — pass (31/31: seeded-image, e2e-models,
  e2e-models-assert, seed-run).
- `turbo typecheck --filter=@hushbox/api --filter=@hushbox/scripts` — pass.
- `turbo typecheck --filter=@hushbox/e2e` — pass (spec imports the seeded id).
- eslint (from each owning pkg dir) on all edited files — exit 0.
- `pnpm arch:check` — OK (11 rules / 1815 files); barrel exports respect boundaries.
- jscpd on changed source paths — 0 clones after extracting `readCatalogDescriptors`
  (the 3 remaining multi-model-media.spec clones are PRE-EXISTING test-body
  similarity I did not introduce).
- api models-domain unit tests (`normalize.test.ts` etc.) — pass, barrel imports
  resolve at runtime.
- `pnpm lint:unused` (knip) — FAILS on 2 unused exports in
  `e2e/helpers/idempotent-request.ts` (Task-06's file — I never touched it;
  confirmed via `git diff --name-only`). My new exports are all consumed.

Full `pnpm test:api` / any `pnpm e2e` NOT run (per brief: e2e centralized; api suite
needs the full stack — barrel change is a pure additive re-export covered by
typecheck + arch + targeted unit tests). E2E proof deferred to the orchestrator's
consolidated run.

## Acceptance criteria

- AC1 (≥2 distinct exposed strict-image ZDR ids in the E2E catalog) — MET: seedream
  (live, pre-seed-validated) + synthetic (`assertSeededImageModelPresent` post-seed).
- AC2 (image tests select two distinct ids; red block removed; intent unchanged) —
  MET: `IMAGE_MODELS` now two distinct ids; comment block deleted; assertions
  untouched. E2E green pending central run.
- AC3/AC4 (TDD at seed/catalog layer) — MET: pure builder + assertion + runSeed
  covered; RED-first evidence above.
- AC5 (repo-wide intentional-red sweep) — MET for my scope: removed the spec block
  and updated media-gen.md RC-D. Residual markers listed under Concerns.

## Deviations / boundary decisions

- The founder ruling listed plan.md/ledger.md IC-4 and "the two CODEBASE-AUDIT docs"
  as markers to remove. Per BOUNDS + file ownership, plan.md/ledger.md at the run
  root are NOT in my ownership (orchestrator-owned) — I did not edit them; RAISED.
- The two CODEBASE-AUDIT docs contain NO image-fanout red-marker: their "IC-4" /
  "known-red" hits are unrelated topics (a deletion-finish table row; scrub allowlist).
  The research doc's claim they mention this marker is inaccurate. I made no edits
  there to avoid corrupting unrelated audit content.

## Concerns / residual red-markers (for orchestrator → diagnosis task)

- `e2e/chat/video-generation.spec.ts:373-376` — a GENUINELY-red test ("Runs RED
  until a 4k-capable video model is ZDR-exposed"; no 4k ZDR video model exists).
  Task-16's file, out of my scope; NOT silently stripped. The same option-(d)
  synthetic-model technique could resolve it (inject a synthetic 4k-tier video
  model) if the orchestrator wants a follow-up.
- plan.md / ledger.md IC-4 "known-red / intentionally red" mentions — run-root docs
  I don't own; need the orchestrator to update to reflect resolution.
- knip failure in `e2e/helpers/idempotent-request.ts` (`idempotentPatch`,
  `idempotentDelete` unused) — Task-06's file, pre-existing/in-flight, not mine.

## Confidence

High for the catalog/seed mechanism (typecheck + arch + TDD green; descriptor mirrors
the real seedream shape byte-for-byte on the load-bearing fields; single-writer
respected). Medium only on the end-to-end e2e green, which is deferred to the central
run — the send path is exercised only by the mock provider, which the research and
mock-provider code confirm renders any image id.
