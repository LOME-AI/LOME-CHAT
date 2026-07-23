# impl-report-12 — Off row "Min", ladder loses the min rung (founder ruling 2026-07-23)

## Objective

The OFF row displays "Min" (wire unchanged: selection `none` → `{enabled:false}`); "None" disappears; the canonical effort ladder becomes Low < Mid < High < Max (the `min` rung removed); positional assignment N=1→[High], 2→[Low,High], 3→[Low,Mid,High], 4→[Low,Mid,High,Max], 5+→strongest four.

## Files changed

- `packages/shared/src/reasoning-effort.ts` — `CANONICAL_REASONING_EFFORTS` → 4 rungs (`min` removed, so `REASONING_EFFORT_SELECTIONS` drops it too — a request carrying `min` is now a 400 at the schema); `REASONING_EFFORT_LABELS.none` → `'Min'` with the 2026-07-23 ruling documented.
- `packages/shared/src/reasoning-effort.test.ts` — reshaped expectations; `'min'` added to both rejected-values lists.
- `packages/shared/src/estimate/reasoning-plan.ts` — tier table → 4 entries (low 4k / medium 12k / high 32k / max 64k); `ladderFor` reshaped per ruling; **`NATIVE_EFFORT_BY_LABEL` deleted** — with `min→'minimal'` gone the map was pure identity, so the null-vocabulary full ladder wires the canonical label directly (documented in the offeredLevels doc); `slice(0, length)` now keeps the strongest four automatically; comments updated (five→four, ladder prose).
- `packages/shared/src/estimate/reasoning-plan.test.ts` — ladder-per-count, strongest-four truncation (5-vocab and 6-vocab cases), GPT-5 N=4 mapping (minimal→Low, low→Mid, medium→High, high→Max — matches the ruling verbatim), null-vocab identity wires, 4-tier table, budget clamp rows, and the seeded count-match property (pool now includes `'none'`; effort count excludes the off row; expected labels/wires derive from the strongest-four non-none slice).
- `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx` — menu items now `['Auto','High','Mid','Low','Min']`; ghost-stack list → `['Auto','Low','Mid','High','Max','Min']` (Min = off row's word).
- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` — **no change needed**: labels flow from `REASONING_EFFORT_LABELS`, the off row is already rendered last, and the ghost stack iterates the labels map, so it reflects the new set automatically (label values stay unique — no React key collision).

## Removal decision (ruling's "prefer removal if blast radius is small")

Removed. Verified blast radius before editing: literal `'min'` in non-test code existed ONLY in the two in-bounds shared files; no out-of-bounds `Record<CanonicalReasoningEffort,…>` object literal exists (only the two in-bounds maps + one test map); `AUTO_REASONING_EFFORT_ORDER` (api) never contained `min`; the classifier's `CLASSIFIER_EFFORT_LEVELS` (`low|medium|high`) is untouched; `effort-dimension.ts`'s `indexOf` positioning is shift-invariant (all distances preserved under the uniform −1 shift).

## Tests (TDD)

Reshaped expectations first and watched 14 tests fail for feature-missing reasons (5-rung ladder still live), then implemented, then green. Menu test updated the same way (label array).

## Self-gate

- `vitest run src/reasoning-effort.test.ts src/estimate/reasoning-plan.test.ts` (packages/shared) — pass 72/72 (was 14 RED pre-implementation).
- `pnpm test:shared` (full suite, coverage-gated) — pass; per-file coverage clean (smart-model/effort-dimension, classifier, format all green — G1 brand tests intact).
- `pnpm test:watch apps/api/.../turn-reasoning.test.ts --run` — pass 19/19 ('none' hard-off, mandatory refusal, auto placeholder all green; off-wire semantics untouched).
- `pnpm test:watch apps/api/.../turn-definition.test.ts --run` — pass 90/90.
- `pnpm test:watch apps/web/.../prompt-input.test.tsx --run` — pass 125/125 (a standalone raw-vitest run of this file ZodErrors on the platform env var — env-harness bypass artifact, not a product failure).
- Menu component suite — pass 30/30 (trial hiding, mandatory-hides-off, greyed-never-hidden, slide mechanics all green).
- eslint (both packages, from package dirs, after final edits) — pass.
- `tsc --noEmit` packages/shared — pass. apps/api — fails ONLY in `identity/routes.integration.test.ts`, which carries a foreign uncommitted 537-line diff (in the run-start git status); zero reasoning-related errors. apps/web tsc — the two §Known-foreign-failures items (unchanged from report 11).

## Acceptance criteria

- Off row labeled "Min", internal value stays `none`, wire `{enabled:false}` unchanged — met (labels map only; turn-reasoning suite green).
- "None" gone from the UI — met (menu items pinned).
- 4-rung ladder + ruled positional assignment incl. 5+→strongest four — met (ladder tests + seeded property).
- GPT-5 4-level mapping minimal→Low/low→Mid/medium→High/high→Max — met (pinned verbatim).
- count-match excludes the off row — met (property pool includes `'none'`, count over non-none natives).
- `min` handling: removed from enum + tier table (small blast radius, verified) — met.
- Ghost stack reflects new label set — met (pinned).
- Menu order Auto / high→low / Min(off) last — met (pinned).

## Deviations

- None beyond the sanctioned removal choice. The null-vocabulary native map deletion is a consequence of removal (identity map), documented in-code.

## Concerns and limitations

- OUT OF BOUNDS, breaks: `apps/web/src/hooks/chat/use-reasoning-effort.test.ts:66` pins the old 5-ladder for budget-native models — now fails (1 test). One-line fix: `['low','medium','high','max']`. Not in my ownership.
- OUT OF BOUNDS, stale not failing: `e2e/pages/chat.page.ts:1500` level union still permits `'None'` (label no longer exists; no spec uses it — chat.spec.ts:145 uses 'High'); note `'Min'` in that union now selects the OFF row, a semantics change for future spec authors. `packages/shared/src/smart-model/effort-dimension.ts:61` comment still names the "Min < … " ladder (code correct, comment stale).
- A persisted client preference of `'min'` (zustand-persist) will fail the enum on rehydration; zustand's default merge keeps the initial `'auto'` state on parse-safe stores — the store persists raw JSON without schema validation, so the stale `'min'` string would load as `preferredReasoningEffort`. The clamp in `effectiveReasoningSelection` sends `auto` for any unoffered value, so no invalid request can be produced; cosmetic chip label falls back to Auto via the existing not-offered path (pinned by the existing "falls back to Auto" test with `max`… which IS still in the enum — the `min` case is type-invisible but behaviorally identical: `offered.includes` fails → auto).

## Confidence

high — full shared suite green with coverage, all named doctrine suites green, blast radius grep-verified, foreign failures attributed with diffs/status evidence.
