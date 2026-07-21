# Task-16 impl-report-1 — deterministic default media model

## Objective

Make the default media (image/video) model selection deterministic and
non-positional (founder ruling), so a catalog reorder can no longer silently
change which model auto-resolves; and ensure the E2E catalog deterministically
yields `google/veo-3.1-lite` as the default video model so the existing
video-generation spec assertions (720p+1080p pills) hold.

## Files changed

- `apps/web/src/hooks/models/use-resolve-default-model.ts` — replaced the
  positional `models.find(...)` (first eligible array entry) with a deterministic
  selection: filter eligible models for the modality, then pick the highest
  catalog popularity (`popularityRank`, rank 0 = most used; absent sorts last)
  with a stable `id.localeCompare` tie-break. Updated the two stale doc comments
  that described the old "first eligible" behavior.
- `apps/web/src/hooks/models/use-resolve-default-model.test.ts` — added a
  `videoModel` factory and four tests (see below).

No `scripts/**` or spec files changed — see "Deviations / key finding".

## Tests added

- `picks the highest-ranked model for a modality, not the first array entry` —
  shuffled catalog (kling rank 5 placed first, veo rank 1 second) resolves veo,
  not the positional first. Covers AC1 (non-positional, ranked) / AC3 (shuffled).
- `breaks ties by model id when popularity ranks are equal or absent` — two
  unranked video models resolve the lower id (veo). Covers AC1 stable tie-break;
  this is the exact path the live E2E catalog exercises (see finding).
- `keeps the higher-ranked model when it already leads the array` — already-sorted
  input still resolves the ranked model (covers the comparator's `-1` arm).
- `resolves a default for an unauthenticated user with no balance` — covers the
  unauthenticated/no-balance branch.

## Self-gate

- `cd apps/web && npx eslint use-resolve-default-model.ts + .test.ts` — pass (exit 0).
- `npx turbo typecheck --filter=@hushbox/web --force` — pass.
- `npx vitest run use-resolve-default-model.test.ts --coverage.include=...ts` —
  pass, 13/13 tests; coverage on the owned file: Stmts 100%, **Branches 100%
  (31/31)**, Funcs 100%, Lines 100%.

TDD verified: both primary tests watched RED first (positional `.find` returned
Kling — see run output) before implementing; then GREEN. A real bug surfaced
mid-implementation: `Infinity - Infinity === NaN` corrupted the comparator when
both models were unranked (the actual E2E case) — caught by the tie-break test,
fixed by comparing ranks with `===`/`<` instead of subtraction.

## Acceptance criteria

1. **Deterministic, non-positional default (image + video)** — MET. Same
   ranking+id-tie-break mechanism applies to every non-text modality (image and
   video both flow through `resolveDefault`).
2. **E2E catalog deterministically yields veo as top video model** — MET, and
   achieved WITHOUT a seed change. Key finding: `popularityRank` is assigned only
   to `source === 'language'` models in the refresh pipeline
   (`apps/api/src/slices/models/domain/refresh.ts:212-213`); all image/video
   descriptors are unranked (`popularityRank: undefined`). So both
   `google/veo-3.1-lite` and `kwaivgi/kling-video-o1` are unranked, and the stable
   id tie-break (`'google/veo-3.1-lite' < 'kwaivgi/kling-video-o1'`) resolves veo
   deterministically regardless of live catalog ordering. This is strictly more
   robust than a ranking seed and needs no scripts change.
3. **Failing web unit test first (shuffled → ranked)** — MET (watched RED, then
   GREEN).
4. **E2E proof** — DEFERRED to orchestrator consolidated run per Global
   Constraints (per-task e2e not run here).

## Deviations / key finding

- **No `scripts/lib/e2e-models.ts` / `scripts/seed.ts` ranking edit was made or is
  possible.** The brief and plan §Task-16 assumed an E2E "catalog-seed ranking"
  value to pin. There is none: the E2E model catalog is populated live from
  OpenRouter by `pnpm catalog:refresh` (`scripts/refresh-catalog.ts`,
  `e2e:prepare`), with no hand-authored descriptors — a deliberate, documented
  design (`scripts/lib/e2e-models.ts` header; `scripts/seed.ts:21-27`). Inventing
  a ranking-override seed would contradict that design (an architecture change,
  out of scope). Determinism is instead guaranteed by the unranked-media +
  id-tie-break property above, which is verifiable in code.
- **No spec edit was needed.** `video-generation.spec.ts`'s default-dependent
  assertions are model-*capability* assertions (720p + 1080p pills), satisfied
  once veo is the default; the only hardcoded veo id
  (`selectSingleModel('google/veo-3.1-lite')`, 4k test) is an explicit selection
  unaffected by default resolution. AC2 permitted (not required) switching to a
  shared constant; leaving the spec untouched is the more surgical choice.

## Concerns / limitations

- The video default's determinism rests on `google/veo-3.1-lite` sorting before
  `kwaivgi/kling-video-o1` by id and on both being unranked. If a future catalog
  change exposed a video model whose id sorts before `google/...` OR started
  ranking media models, the default could change — but that is now a *deterministic*
  outcome of catalog data, exactly the non-positional property the ruling asked
  for, and any such change is caught by the e2e video spec.

## Confidence

High — unit layer fully green with 100% branch coverage; the determinism claim is
grounded in `refresh.ts:212` (media never ranked) plus the id tie-break, both
verified this session.
