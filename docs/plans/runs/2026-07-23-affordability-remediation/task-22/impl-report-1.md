# Task 22 — impl report 1

## Objective

A2 micro-task: repair the pre-existing unsatisfiable smart-model fixture in
`chat/routes.integration.test.ts` (test-only), and finish three T10 tails —
replace the two remaining hand-rolled history char reduces with shared
`historyCharacterCount`, and remove the dead `PromptBudgetInput.capabilities`
input and its feed.

## Files changed

- `apps/api/src/slices/chat/routes.integration.test.ts` — the four seeders'
  `limits: { contextLength: 1000 }` → `{ contextLength: 100_000 }` (seedModelId,
  seedToolCapableModelId, trial decoys, seedGateModel). Fixture lines only, per A2;
  no eligibility semantics touched, no non-test file in the smart-model path edited.
- `apps/api/src/slices/models/domain/trial-eligibility.ts` — the line-191 hand
  reduce is now `historyCharacterCount(history)` (+ import). The shared function body
  is byte-identical to the removed reduce, so no count can change; the 25 existing
  tests pass unmodified (no re-pin needed — no divergence).
- `apps/web/src/components/chat/page/trial-chat-page.tsx` — the historyCharacters
  reduce is now `historyCharacterCount(trialMessages)` (+ import; prettier reflowed
  the import block). 61 existing tests pass unmodified.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — `capabilities: ModelFeatureId[]`
  removed from `PromptBudgetInput`; `ModelFeatureId` import dropped (last use).
- `apps/web/src/components/chat/input/prompt-input.tsx` — `capabilities` prop,
  defaults entry, Pick member, destructure, and the `usePromptBudget` feed removed;
  `ModelFeatureId` import dropped. No production caller passed the prop (grep-verified;
  only a test did).
- `apps/web/src/hooks/billing/use-prompt-budget.test.ts` — `capabilities` removed from
  the harness input type/value and from the measurement test (renamed
  "measures the send-path prompt through the shared counter"; its assertion — measured
  count === shared counter over the builder output — is unchanged and still meaningful).
- `apps/web/src/components/chat/input/prompt-input.test.tsx` — deleted the
  "accepts capabilities prop for system prompt calculation" test (the prop no longer
  exists; keeping it would be a type error).

## Fixture diff (evidence)

```
-          limits: { contextLength: 1000 },
+          limits: { contextLength: 100_000 },
```
× 4 seeder sites (lines 195, 225, 264, 297). Decoy/gate pricing untouched, so the
trial premium-percentile and affordability fixtures keep their intent.

## Tests added

None added — this task is a fixture repair + behavior-identical refactor + dead-code
removal. Red/green evidence:

- Fixture: RED observed first — `vitest run routes.integration.test.ts -t "smart-model"`
  at baseline: **7 failed** (all 402→201: smart-model send 201, smart-model
  regenerate 201, and the 4 parametrized sentinel-resolution retry/edit × fork cases
  + one more regenerate case), matching A1's diagnosed cause. GREEN after the fixture
  fix: full file **185/185**.
  Note: A1 said "2 failures"; at current tree state it is **7** smart-model cases, all
  with the same root cause and all repaired by this one fixture change (raised below).
- Refactor sites: shared `historyCharacterCount` body is textually identical to both
  removed reduces (`packages/shared/src/prompt/prompt-character-count.ts:12`), so
  counts are unchanged by construction; existing suites re-run green with zero re-pins
  (trial-eligibility 25/25, trial-chat-page 61/61) — the A2 STOP trigger (a computed
  count changing) did not fire.
- Dead-input removal: the failing signal is the type system — stale references in the
  two test files errored until updated; `tsgo --noEmit` green both packages after.

## Grep proof (multiline-safe, repo-wide)

`rg -U --pcre2 'reduce\(\s*\((?:total|sum|acc)[^)]*\)\s*=>\s*[^,]*\.content\.length' apps packages e2e`
after the change matches exactly:

- `packages/shared/src/prompt/prompt-character-count.ts:12` — the ONE shared impl.
- `packages/shared/src/smart-model/prompts.test.ts:163,172` — test oracles summing
  **classifier prompt messages** (not chat history) to check
  `computeClassifierPromptOverhead`; sharing the impl there would not be a history
  counter collapse (different domain) and the file is out of my bounds.
- `apps/api/src/slices/models/domain/trial-eligibility.test.ts:247` — a test oracle
  independently deriving the expected char total for the function under test; using
  `historyCharacterCount` inside it would make the assertion partially tautological
  (CODE-RULES "Identical ≠ complementary": test authority vs implementation).

Zero hand-rolled history char reduces remain in **production** code; both A2-named call
sites import the shared counter. A supplementary sweep
(`rg '\.content\.length'` over non-test production code) found only: the shared impl,
`settlement.ts:1140` (single message's storage fee — not a history sum), a for-loop sum
in `packages/shared/src/smart-model/prompts.ts:157` (classifier prompt overhead —
different domain, out of bounds, no drift coupling with history counting), and two
`length > 0` filters. Interpretation of "zero repo-wide" as production-code-zero is
raised to the orchestrator.

## Self-gate (after final edit)

- `pnpm test:api` — exit 1; **6090 passed / 7 failed / 2 skipped (447 files)**. All 7
  failures are `notifications/domain/templates/template-html.test.ts` snapshots — the
  exact pre-existing flake A1 names; notifications untouched by this task. Every file
  I touched is green in the same run. (A first attempt also hit the known concurrent-run
  coverage-`.tmp` clobber, A1/T10-documented; the retry above did not.)
- Targeted: `routes.integration.test.ts` 185/185 · `trial-eligibility` 25/25 ·
  `trial-chat-page.test.tsx` 61/61 · `use-prompt-budget.test.ts` +
  `prompt-input.test.tsx` 173/173.
- `pnpm test:web` — **exit 0** (full suite + coverage gate).
- `pnpm typecheck` — exit 0 in `apps/api` and `apps/web` (both configs).
- `eslint <owned files>` from each package dir after the last edit — api exit 0;
  web: one prettier import-reflow surfaced and was `--fix`ed
  (trial-chat-page.tsx), then exit 0 on all five owned web files.

## Acceptance criteria

- 2 smart-model cases pass / no semantics change — **met** (in fact 7 cases repaired;
  185/185 file-green; only fixture lines edited; no non-test smart-model-path file
  touched).
- Zero hand-rolled history char reduces repo-wide; both call sites on the shared
  counter; behavior byte-identical — **met** under the production-code reading
  (evidence above; remaining matches are the shared impl + three deliberate test
  oracles; zero count changes, zero re-pins).
- `capabilities` gone from `PromptBudgetInput` and the `prompt-input.tsx` feed; web
  typecheck/lint/tests green — **met**.

## Deviations

- Edited two test files not named in A2's Files list
  (`use-prompt-budget.test.ts`, `prompt-input.test.tsx`) — required for the dead-input
  removal to typecheck; A2's Files list ends with ", tests".
- Test-oracle reduces left in place (see Grep proof) — reading A2's "zero repo-wide"
  as production-code scope; collapsing them would weaken the tests they power.

## Concerns and limitations

- A1's "2 failures" undercounts the current tree: 7 smart-model cases were failing
  (same single root cause). Possibly the 4 parametrized sentinel cases postdate A1's
  observation or landed via a sibling task's edits to the same file.
- `pnpm test:api` cannot exit 0 while the pre-existing template-html snapshot flake
  stands (A1-attributed, not mine to fix).
- T02/T08 in flight; api-side runs shared the tree with their uncommitted edits — all
  failures observed were attributable (template-html, coverage-tmp clobber).

## Confidence

High — fixture repair verified red→green on the exact failing cases; both refactor
sites replaced by a textually identical shared body with all existing pins green
unmodified; dead-input removal is typechecker-verified across both packages.
