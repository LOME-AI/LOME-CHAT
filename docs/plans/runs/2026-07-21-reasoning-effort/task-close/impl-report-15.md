# impl-report-15 — Re-fix of report-13's two ladder items after the 'lite' ruling

## Objective

The founder's fifth effort level `lite` (report-14; ladder Lite < Low < Mid < High < Max, Min still = off) invalidated two of report-13's fixes. Re-fix: (1) `use-reasoning-effort.test.ts:66` ladder pin → the 5-rung `lite…max` ladder; (2) `effort-dimension.ts:61` comment → the actual current ladder.

## Files changed

- `apps/web/src/hooks/chat/use-reasoning-effort.test.ts` — line 66 expectation → `['lite','low','medium','high','max']`; fixture comment back to "five-rung". The intersection test (line 74, `['low','medium','high']`) needed no change: N=3 positional assignment is unchanged by the ruling and still intersects the full ladder to low/medium/high (suite green confirms).
- `packages/shared/src/smart-model/effort-dimension.ts` — comment only: `ladderPosition` doc → "Lite < Low < Medium < High < Max". Verified against the landed source of truth before editing: `packages/shared/src/reasoning-effort.ts:16` `CANONICAL_REASONING_EFFORTS = ['lite','low','medium','high','max']` and `reasoning-plan.ts`'s five-tier table (`lite: 2048`) / `lite → 'minimal'` native map, matching report-14's record. Code untouched; `indexOf` positioning is unaffected (classifier scale low|medium|high unchanged).

## Tests added

None — item 1 is the same expectation-update pattern as report-13: the existing test was the RED reproduction (failed pre-edit with "expected [lite, low, medium, …] to deeply equal [low, medium, high, max]" — i.e. the implementation already ships five rungs), green after. Item 2 is a comment.

## Self-gate

- `vitest run src/hooks/chat/use-reasoning-effort.test.ts` (apps/web) — RED confirmed pre-edit (1 failed / 18 passed, wrong-ladder assertion), then pass 19/19.
- `vitest run src/smart-model/effort-dimension.test.ts` (packages/shared) — pass 21/21.
- eslint on both touched files, from each package dir, after the final edit — pass, exit 0.
- `tsc --noEmit` e2e — pass, exit 0.
- `tsc --noEmit` apps/web — exit 2 with EXACTLY the two §Known-foreign-failures items (`pipeline-bindings.ts(59)` ExecutionContext TS2304; `model-list-body.test.tsx(41)` TS2322) and nothing else — attributed, not fixed; neither file in my diff.

## Acceptance criteria

- Ladder pin → `['lite','low','medium','high','max']`, suite green — met (19/19).
- Comment describes the actual current ladder, verified against `reasoning-plan.ts`/`reasoning-effort.ts` as landed per report-14 — met.

## Deviations

None.

## Concerns and limitations

- Report-14's concerns section describes `effort-dimension.ts:61` as still saying "Min < Low < …" — that was stale relative to report-13's fix (the file said "Low < Medium < High < Max" until this edit). No action needed; noting so the auditor doesn't chase a phantom third state.
- Report-13's `'Min'`-in-e2e-union soft spot stands unchanged (doc-comment guard only).

## Confidence

high — red→green observed on the one behavioral pin; ladder verified against the landed shared source, not the brief's prose; foreigns attributed with identical signatures to reports 12–13.
