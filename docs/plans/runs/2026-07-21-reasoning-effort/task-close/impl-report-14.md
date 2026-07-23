# impl-report-14 — Fifth effort level "Lite" (founder ruling 2026-07-23)

## Objective

Canonical effort enum gains `lite` below `low` (display "Lite"); ladder Lite < Low < Mid < High < Max; positional assignment N=1..4 unchanged, N=5 → all five, deeper vocabularies keep their strongest five; budget-native models offer all five tiers; Min stays the off row (wire unchanged); ghost stack + e2e union + property tests updated.

## Files changed

- `packages/shared/src/reasoning-effort.ts` — enum → `['lite','low','medium','high','max']`; `REASONING_EFFORT_LABELS.lite = 'Lite'` (4 chars, fits the ≤4 rule); ladder comment updated (Lite is the fifth level's word; Min stays the off row).
- `packages/shared/src/estimate/reasoning-plan.ts` — tier table gains `lite: 2048` (**placeholder choice documented in-code**: continues the low←4096 halving progression, above the 1024 protocol floor; tunable data); `ladderFor` gains the explicit N=4 arm (full-ladder arm now serves N=5); `NATIVE_EFFORT_BY_LABEL` reintroduced for the null-vocabulary path (`lite → 'minimal'` — `lite` is not an upstream word; the other four are identity); strongest-four comments → strongest-five.
- `packages/shared/src/reasoning-effort.test.ts` — enum/selections/labels expectations; ladder-ends test now pins Lite and Max.
- `packages/shared/src/estimate/reasoning-plan.test.ts` — N=5 ladder case; five-vocab now offers all five; six-vocab keeps strongest five; **new GPT-5+xhigh N=5 pin** (minimal→Lite, low→Low, medium→Mid, high→High, xhigh→Max — the ruling verbatim); null-vocab ladder + planReasoning wiring back to the translation map; five-entry tier table incl. lite 2048; budget clamp row (lite 2048 unclamped at context 8000); `effort-not-supported` pins both unoffered ends (lite, max) at N=3; seeded property LADDERS gains the 5-rung row and `slice(0,5)`.
- `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx` — ghost-stack pin now requires all seven words `Auto/Lite/Low/Mid/High/Max/Min` (component needed no change — the stack iterates the labels map).
- `e2e/pages/chat.page.ts` — `selectReasoningEffort` level union gains `'Lite'` (in bounds per the brief; the union had already been fixed by another hand to drop 'None' and document Min-as-off — I only added Lite).

## Tests (TDD)

Expectations reshaped first: 11 tests watched RED for feature-missing reasons (4-rung ladder still live), then implemented, then 73/73 GREEN.

## Self-gate

- `vitest run` reasoning-effort + reasoning-plan tests (packages/shared) — pass 73/73 (was 11 RED).
- `pnpm test:shared` (full, coverage-gated) — pass (smart-model/effort-dimension, classifier scale low|medium|high untouched and green).
- `pnpm test:watch` turn-reasoning — 19/19; turn-definition — 90/90; menu suite — 30/30; prompt-input — 125/125 (all through the env harness, sequential).
- eslint (shared 4 files, web test file, e2e chat.page.ts — each from its package dir, after final edits) — pass.
- `tsc --noEmit` packages/shared — pass; e2e tsconfig — pass.

## Acceptance criteria

- `lite` below `low`, label "Lite" — met (enum + labels pinned).
- Tier entry below low's 4096 respecting the 1024 floor, documented — met (2048, halving-progression rationale in-code).
- N=1..4 assignments unchanged, N=5 all five — met (ladder test; GPT-5 N=4 pin unchanged).
- GPT-5+xhigh N=5 mapping — met (pinned verbatim).
- Budget-native models offer all five tiers — met (pinned incl. clamp row).
- Min stays the off row, wire unchanged — met (turn-reasoning 19/19; labels map `none: 'Min'` untouched).
- Ghost stack + e2e union + property tests updated, red-watched — met.
- Classifier scale unchanged — met (no edit; shared suite green).

## Deviations

None.

## Concerns and limitations

- OUT OF BOUNDS, still failing: `apps/web/src/hooks/chat/use-reasoning-effort.test.ts:66` (pins the pre-report-12 5-ladder with `min`). The correct one-line fix after this ruling: `['lite','low','medium','high','max']`. Raised in report-12; the fix line has now changed — whoever owns it should apply the new value.
- `packages/shared/src/smart-model/effort-dimension.ts:61` comment says "Min < Low < …" — after this ruling the true ladder is "Lite < Low < …"; comment remains stale (out of bounds), code remains correct (`indexOf` positioning; classified low/medium/high keep identical relative distances on the 5-rung ladder — same uniform-shift argument as report-12, now shift zero for low..high).
- The report-12 concern about a persisted `'min'` preference stands unchanged (clamped to auto; no invalid request possible). A persisted `'lite'` value from before this ruling cannot exist.

## Confidence

high — every behavior change red-watched then pinned; all doctrine suites green; the ruling's two mapping examples pinned verbatim.
