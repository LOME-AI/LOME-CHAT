# impl-report-13 — Ladder-reshape residues (three items raised by report 12)

## Objective

Close the three out-of-bounds residues report 12 raised after the ladder reshape (off row = "Min", canonical effort ladder = low/medium/high/max): the stale 5-ladder pin in `use-reasoning-effort.test.ts`, the dead `'None'` in `chat.page.ts`'s effort-label union (+ Min-semantics check on all helper/spec usages), and the stale "Min < …" ladder comment in `effort-dimension.ts`.

## Files changed

- `apps/web/src/hooks/chat/use-reasoning-effort.test.ts` — line 66 expectation `['min','low','medium','high','max']` → `['low','medium','high','max']`; adjacent fixture comment "five-rung" → "four-rung". This is a test-pin update, not a weakening: the pinned behavior changed by founder ruling (2026-07-23, executed in task-12); the old pin asserted a ladder that no longer exists.
- `e2e/pages/chat.page.ts` — dropped `'None'` from `selectReasoningEffort`'s level union (label no longer rendered); doc comment now records that "Min" is the OFF row (reasoning disabled), so future spec authors don't read it as a low effort level.
- `packages/shared/src/smart-model/effort-dimension.ts` — comment only: `ladderPosition` doc "Min < Low < Medium < High < Max" → "Low < Medium < High < Max". No code change; `CLASSIFIER_EFFORT_LEVELS` (low|medium|high) untouched per brief.

## Usage sweep (residue 2's semantics check)

Grep across `e2e/` for `selectReasoningEffort` / `'None'` / `'Min'` / `'Mid'`: the only call site is `e2e/chat/chat.spec.ts:145`, which passes `'High'` — still a valid effort level under the new ladder. **No spec uses `'Mid'`, `'Min'`, or `'None'`** (the brief said chat.spec.ts uses 'Mid'; it does not — verified by grep). Nothing to retarget; `'Mid'` remains Medium's display word in the union. Post-edit grep confirms zero `'None'` literals remain in `e2e/`.

## Tests added

None — residue 1 is an expectation update on an existing test (`offers the full ladder for a budget-native model`), which was the RED reproduction: it failed against the shipped 4-rung implementation (expected 5 rungs, received 4) before the edit and passes after. Residues 2–3 are a type-union narrowing and a comment; no behavior to test.

## Self-gate

- `vitest run src/hooks/chat/use-reasoning-effort.test.ts` (apps/web) — RED confirmed pre-edit (1 failed / 18 passed, wrong-ladder assertion), then pass 19/19.
- `vitest run src/smart-model/effort-dimension.test.ts` (packages/shared) — pass 21/21 (comment-only change sanity).
- `tsc --noEmit` e2e — pass, exit 0, zero errors.
- `tsc --noEmit` apps/web — fails with EXACTLY the two §Known-foreign-failures items and nothing else: `apps/api/src/middleware/pipeline-bindings.ts(59)` `ExecutionContext` TS2304 and `model-list-body.test.tsx(41)` TS2322 (both recorded in plan §Known-foreign-failures as committed/foreign — attributed, not fixed; neither file is in my diff).
- eslint on all three touched files, run from each package dir after the final edit — pass, exit 0 each.

## Acceptance criteria

- Residue 1: 5-ladder pin updated to `['low','medium','high','max']`, suite green — met (19/19).
- Residue 2: `'None'` dropped from the union; every helper/spec usage checked against new semantics (only `'High'` at chat.spec.ts:145 — unaffected); Min-is-off documented at the helper; tsc e2e passes — met.
- Residue 3: comment corrected, classifier scale untouched — met.

## Deviations

None. One brief inaccuracy on record: chat.spec.ts uses `'High'`, not `'Mid'` — no retargeting was needed either way.

## Concerns and limitations

- `git status` shows a large foreign uncommitted tree (run-start snapshot matches); my diff is exactly the three in-bounds files (7 insertions / 6 deletions).
- The union's `'Min'` semantics change is documentation-guarded only; a future spec selecting `'Min'` expecting low effort would compile. The doc comment is the mitigation the brief scoped.

## Confidence

high — RED→GREEN observed on the one behavioral pin, both typechecks clean modulo the two recorded foreigns, usage sweep grep-verified, diff scope confirmed.
