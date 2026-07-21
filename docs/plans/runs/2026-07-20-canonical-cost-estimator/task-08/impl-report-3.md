# T8 impl-report-3 — STATUS: DONE — media-turn admission now reserves what settlement charges

## Objective (restated)
Close the founder-ruled media gap (option 2 "reserve whatever settlement charges"): a media
turn's settlement charges media byte-storage + prompt char-storage + provider, but its
admission reserved NONE of the storage because media turns carried no `.storage` stamp. Make
admission reserve media byte-storage (estimated) + input(prompt) char-storage + provider.
Settlement is unchanged.

## Where/how media turns are now stamped
The stamp reuses the SAME mechanism text turns use (`withStorageStamp`); no new stamping path.

1. **`turn-definition.ts` — `MediaTurnParams` gained an optional `budget?: TurnBudget`.**
   `buildMediaTurn` now applies `withStorageStamp(compiled.definition, params.budget,
   CHAT_TURN_HOOKS)` in its `.map`. Media is paid-only and always persists, so the persisting
   chat hooks always apply — the hooks gate inside `withStorageStamp` therefore always stamps
   when a budget is present. Unit callers that pass no budget stay unstamped (provider-cost
   only), preserving the existing pure `buildMediaTurn` tests.

2. **`turn-definition.ts` — `buildMediaTurnDefinition` threads the budget.** Its 4th positional
   `params` arg was folded into a new `MediaTurnDefinitionOptions = { params, budget }` object
   (the `deps / primary-list / options` convention `buildTurnDefinition` and
   `buildMultiModelTurnDefinition` already use). This keeps the arity at 4 — the vendored
   `max-params` rule caps at 4; a bare 5th positional `budget` tripped it. `budget` is REQUIRED
   here (media always persists), forcing the stamp — "reserve ≥ charge" by construction. It
   passes `budget` down to `buildMediaTurn`.

3. **`routes.ts` (media branch of `turnDefinitionOrRefusal`, ~L580).** The call site already had
   `turn.budget` in scope (the same `TurnBudget` the text paths pass). Now:
   `buildMediaTurnDefinition({ db, telemetry }, selectedModels(body), body.modality,
   { params, budget: turn.budget })`. `turn.budget.promptCharacterCount` =
   `promptCharacterCount(body.userMessage.content, history)` (prompt + history) — the same value
   the text paths reserve on, ≥ settlement's user-message-only prompt fee (safe over-reserve).

## A stamped media turn reserves byte-storage + input-char-storage + provider, and NO text-output char-storage
Confirmed by reading the estimator, not just the test. In `estimate-run.ts`
`createEstimateRun` (unchanged):
- Per media node: `estimateModelNode → modelCeiling` (media branch) →
  `estimateRunCeilingNanoUsd(pricing, {kind:'media',units}, ceiling, mediaNodeStorage(...))`.
  `mediaNodeStorage` returns `{ outputCharsPerToken: 1, mediaStorageBytes }`.
- `callManifest` (media branch, `estimate.ts`) calls `buildMediaLineItems`, which emits exactly
  two items: `media-generation` (marksUp, provider) and `media-storage` (not marksUp,
  `bytes × 18n × modelCount`). `buildMediaLineItems` IGNORES `outputCharsPerToken` entirely —
  there is no output char-storage item for media — and the media node's output-token ceiling is
  `0` (`outputTokensOf` returns 0n for media), so even a char-storage variable rate would fold to
  zero. Hence NO spurious text-output char-storage.
- Definition-level input storage: `inputChars × STORAGE_COST_PER_CHARACTER_NANO`, added ONCE for
  ANY stamped definition (media included).

### Worked nano (prompt = 100 chars; rates char=300n, byte=18n; both settlement-identical)
Image (single model, `ESTIMATED_IMAGE_BYTES = 8_000_000`, `perImage` base 1_000_000n):
- provider (marked up ×11500/10000) = 1_150_000n — identical in stamped and unstamped holds.
- media byte-storage = 8_000_000 × 18n × 1 = 144_000_000n.
- input char-storage = 100 × 300n = 30_000n.
- stamped hold = 145_180_000n; unstamped (provider-only) = 1_150_000n; **delta = 144_030_000n**.
- Settlement charges the SAME terms/rates: provider + `byteLength × 18n` + `promptChars × 300n`.
  Admission's estimated 8 MB ≥ actual bytes and prompt+history chars ≥ user-message chars ⇒
  reserve ≥ charge.

Video (4 s @ 720p, `ESTIMATED_VIDEO_BYTES_PER_SECOND = 5_000_000`):
- media byte-storage = (4 × 5_000_000) × 18n = 20_000_000 × 18n = 360_000_000n.
- input char-storage = 30_000n.
- **delta = 360_030_000n**, provider identical in both holds.

## Did estimate-run.ts need a change?
**No.** It already prices a stamped media turn correctly (media byte-storage as a fixed
pass-through item, zero output-token ceiling ⇒ no char-storage on the output side, and
definition-level input char-storage once). Per the brief's step 2 escape hatch, it is left
unchanged. (Its working-tree diff is prior T8 report-2 work, not mine — I never edited it.)

## Recomputed test numbers (hand-derived, old → new)
New tests in `turn-definition.test.ts` › `buildMediaTurn — admission storage stamp`:
- `stamps the payer tier + prompt-char count` → `.storage` `{ inputChars: 100, tier: 'paid' }`.
- `leaves a media definition unstamped when no budget is supplied` → `.storage` undefined.
- image: `stampedHold − providerOnlyHold` — OLD (pre-fix) = **0n** (media unstamped); NEW =
  `100×300n + 8_000_000×18n` = **144_030_000n**.
- video: OLD = **0n**; NEW = `100×300n + (4×5_000_000)×18n` = **360_030_000n**.
No existing assertion weakened; the RED run showed `expected 0n to be 144030000n / 360030000n`
(delta 0 because the media definition carried no stamp), GREEN after the stamp wiring.

## TDD evidence
- Wrote the 4 media-stamp tests first. RED: `turn-definition.test.ts` 3 failed / 60 passed —
  stamp `.storage` undefined and both money deltas `0n` (media unstamped), the exact expected
  failure (media turns get no stamp).
- Implemented `budget` threading (`buildMediaTurn` stamp + `buildMediaTurnDefinition` options +
  routes call). GREEN: 63 passed.

## Files changed
- `apps/api/src/slices/chat/domain/turn-definition.ts` — `MediaTurnParams.budget?`; stamp in
  `buildMediaTurn`; `buildMediaTurnDefinition` takes `MediaTurnDefinitionOptions { params,
  budget }` and threads budget down.
- `apps/api/src/slices/chat/routes.ts` — media branch passes `{ params, budget: turn.budget }`.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — 4 new media-stamp/money tests +
  priced media resolver; imports for the byte/char constants + `WorkflowDefinition` type.
- `apps/api/src/slices/chat/domain/media-turn.integration.test.ts` — updated the one
  `buildMediaTurnDefinition` call to the new options shape (infra-gated; typecheck-verified).

## settlement.ts untouched
`withStorageFees` (~L1110) is unchanged — verified by reading it and confirming it is absent from
my working-tree edits. It still charges `promptChars × 300n` (index 0) + `responseChars × 300n` +
`mediaBytes × 18n` + provider. The fix only raised the admission reservation to match.

## Git-status note (concurrent other-agent edits left alone)
`git status` shows an in-progress rebase with many uncommitted files. I edited ONLY my four
target files. `admission.ts`, `runtime.ts`, and `settlement.ts` (flagged as carrying another
agent's concurrent edits / owned by others) were NOT touched. `estimate-run.ts` / `estimate.ts`
appear in the working-tree diff from prior T8 work — I did not edit them.

## Self-gate
- `turn-definition.test.ts` — pass (63). `estimate-run.test.ts` — pass (63). `estimate.test.ts`
  — pass (51). (Focused unit runs; full `pnpm test:api` not run because chat/billing/media
  `*.integration.test.ts` need local Postgres/Redis/MinIO — infra-gated per brief. The
  media-turn wiring rides `media-turn.integration.test.ts`, updated + typecheck-verified but not
  executed here.)
- `turbo typecheck --filter=@hushbox/api --force` — PASS (no pipeline-bindings error surfaced).
- `eslint <4 owned files>` (from `apps/api`, after the LAST edit) — EXIT 0.
- `jscpd --threshold 2` on changed source — 0.88% lines (< 2% → pass); the one 6-line clone is
  the pre-existing `createModelPricingResolver().andThen(… createTurnCompileRegistries …)`
  boilerplate shared by every `build*TurnDefinition` — below threshold, not introduced here.
- `pnpm arch:check` — OK, 11 rules over 1834 files, EXIT 0.

## Deviations
- Folded `buildMediaTurnDefinition`'s positional `params` into a `{ params, budget }` options
  object to keep arity ≤ 4 (`max-params` rule). Signature change confined to its two callers
  (routes.ts + the media integration test), both owned/test-of-owned. Matches the existing
  `deps / primary / options` convention of the sibling `build*TurnDefinition` functions.
- Applied the stamp inside the pure `buildMediaTurn` (not only in the DB-backed
  `buildMediaTurnDefinition` as multi-model does) so the media money is unit-testable end to
  end. Still one mechanism — it calls `withStorageStamp`. Media is unconditionally paid +
  persisting, so `CHAT_TURN_HOOKS` is always correct there (no trial ambiguity, unlike text).

## Concerns / limitations
- The media-turn wiring in `buildMediaTurnDefinition` and the routes call are integration-covered
  only (DB-backed) — consistent with T8 report-2's precedent for the text/smart-model builders.
  The `withStorageStamp` mechanism and the media money math are fully unit-covered.
- Admission over-reserves vs settlement on both storage terms (estimated 8 MB / 5 MB·s ≥ actual
  bytes; prompt+history chars ≥ settlement's user-message-only prompt fee). Deliberate —
  "reserve ≥ charge".

## Confidence
High. The estimator path was read end to end (media byte-storage as a fixed pass-through item,
zero output-token ceiling ⇒ no spurious char-storage, definition-level input char-storage once);
the money deltas are pinned to exact nano at the settlement rates for both image and video; RED
proved the gap (delta 0n) and GREEN proved the fix; settlement + concurrent-agent files are
untouched; all named gates are green.
