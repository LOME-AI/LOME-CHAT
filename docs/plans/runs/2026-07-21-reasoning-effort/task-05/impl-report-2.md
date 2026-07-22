# T5 — fix round 2 — impl report

## Objective

Address the three validated audit findings on impl-report-1: (1) pin `reasoningEffort`'s
participation in the start-turn dedup body hash; (2) restore the orphaned `withAnswerCap`
docblock position in `turn-definition.ts`; (3) pin the `'none'`-is-a-no-op direction of the
engaged-effort refusal seam (media, Smart Model, trial Smart Model).

## Files changed

- `apps/api/src/slices/chat/routes.integration.test.ts` — 5 new behavior pins (findings 1 and 3);
  no production code touched.
- `apps/api/src/slices/chat/domain/turn-definition.ts` — comment-only: moved the
  "Clones a turn definition…" docblock from above `nodeReasoningBudgetTokens` down to sit
  directly above `withAnswerCap`, the function it documents. Zero code changes.

## Tests added

All in `routes.integration.test.ts`; all pin EXISTING behavior (the brief's TDD note: watch
each pass against current code — all five passed first run, none required production change).

- `scopes reasoningEffort into the dedup body hash (absent hashes the pre-feature shape)` —
  finding 1. Two paid sends on a reasoning-capable model, identical but for
  `reasoningEffort: 'low'` vs absent: bodyHashes differ, AND each hash is asserted equal to
  the directly computed `hashCanonicalJson` of its canonical shape — the absent one against
  the exact pre-feature shape (`{conversationId, model, userMessage, history: []}`), the
  engaged one against the same shape + `reasoningEffort: 'low'`. Removing the
  routes.ts:813 spread line now fails this test both ways (hashes collapse AND the exact-hash
  identity breaks). Mirrors the history pattern at the finding's cited pins.
- `passes 'none' through a media turn untouched (201 …)` — finding 3: `'none'` + image
  modality → 201 (mirrors the existing media engaged-400 test's seeding).
- `passes 'none' through a Smart Model send untouched (201 …)` — finding 3: `'none'` +
  `SMART_MODEL_ID` paid → 201 (mirrors the existing paid smart-model 201 test's seeding,
  `withIsolatedCatalog`).
- `refuses an engaged reasoning effort on a trial smart-model send with 400 (classifier stage
  owns it)` — finding 3's optional pin for the routes.ts ~730 seam's 400 direction.
- `passes 'none' through a trial smart-model send untouched (201 …)` — the ~730 seam's
  no-op direction (mirrors the existing trial smart-model 201 test).

## Self-gate

- `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts -- --run` — pass,
  174/174 (169 prior + 5 new).
- `pnpm test:watch apps/api/src/slices/chat/domain/turn-definition.test.ts -- --run` — pass,
  86/86 (comment-only change; suite unchanged).
- `npx eslint src/slices/chat/routes.integration.test.ts src/slices/chat/domain/turn-definition.ts`
  from `apps/api` AFTER the final edit — pass, 0 problems.
- `npx tsc --noEmit` from `apps/api` — pass.
- Scoped run only, per the brief ("no other api gate is running — a scoped run suffices for
  test+comment changes"). No full `pnpm test:api` this round.

## Acceptance criteria (the three findings)

- Finding 1 (hash pin) — MET. The pin covers both directions: participation (different effort
  ⇒ different hash) and back-compat (absent ⇒ byte-exact pre-feature hash via direct
  `hashCanonicalJson` computation). Passed against current code — the spread line behaves as
  report 1 claimed.
- Finding 2 (docblock move) — MET. The clone docblock now sits directly above
  `withAnswerCap`; `nodeReasoningBudgetTokens` keeps its own docblock. No code change;
  turn-definition suite green.
- Finding 3 ('none' no-op pins) — MET. Four pins: 'none'+image → 201, 'none'+Smart Model
  (paid) → 201, 'none'+trial Smart Model → 201, engaged+trial Smart Model → 400. All passed
  against current code. Video not separately pinned: 'none' short-circuits
  `engagedReasoningRefusal` at `reasoningEngaged()` before the modality check, so image and
  video take the identical no-op path; the image pin covers the branch.

## Deviations

None. Test-only + comment-only; no production behavior changed.

## Concerns and limitations

- The trial-smart-model 'none' 201 pin was not in the finding's required list (it named the
  400 direction as the optional) — added because the trial seam's no-op direction was equally
  unpinned; one cheap test.
- The exact-hash assertions couple the test to `startTurnBodyHash`'s canonical field set; any
  future field added to the hash body will surface here as a deliberate update (that is the
  pin's purpose).

## Confidence

High — all three findings are mechanical (pins + a comment move); every new test observed
passing against unchanged production code, exactly as the brief predicted; lint/typecheck
green after the final edit.
