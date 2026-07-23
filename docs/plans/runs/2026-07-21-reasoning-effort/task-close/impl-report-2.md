# Close-batch fix — impl-report-2

## Objective

Fix three validated design-review findings in the composer bottom toolbar and the reasoning-effort rail:

1. [High] 375px collision — capacity label "Model N% filled" painted over the internet-search toggle.
2. [Medium] focus ring invisible on the checked (solid brand-red) rail pill — the roving-tabindex tab entry point.
3. [Nit] disabled rail pill at `opacity-40` near-invisible against paper.

## Files changed

- `apps/web/src/components/chat/input/prompt-input.tsx` — `TextBottomRow`: row gains `flex-wrap` (+`gap-x-4 gap-y-1`), CapacityBar's `min-w-0` (shrink-and-overflow, the collision's root cause) replaced with `min-w-40 flex-1` so the bar wraps to its own full-width line when the toolbar leaves it under 10rem; toolbar+send group gains `ml-auto` to stay right-aligned on its wrapped line; `TextBottomRow` exported for test access (symmetry with `ImageBottomRow`/`VideoBottomRow`); comments updated to record the mechanism.
- `apps/web/src/components/chat/input/reasoning-effort-rail.tsx` — `RailButton` focus styles split by checked state: checked pill gets a contrasting offset ring (`focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background` — the codebase's dialog/sheet offset-ring pattern), unchecked keeps `focus-visible:ring-ring/50 ring-[3px]`; disabled `opacity-40` → `opacity-60` (still `text-muted-foreground`, `cursor-not-allowed`, hover-suppressed, `aria-disabled` + tooltip untouched); comments record both rationales.
- `apps/web/src/components/chat/input/bottom-rows.test.tsx` — new `TextBottomRow` describe (2 tests) + `TEST_IDS` import.
- `apps/web/src/components/chat/input/reasoning-effort-rail.test.tsx` — 3 new tests (checked-pill offset ring; unchecked-ring guard pin; disabled opacity).

## Tests added

- `TextBottomRow > lets the capacity bar wrap to its own line instead of shrinking under the toolbar` — pins `flex-wrap` on the row, `min-w-40` (and absence of `min-w-0`) on the bar — criterion 1.
- `TextBottomRow > keeps the toolbar and send button pushed to the right edge when the bar wraps` — pins `ml-auto` on the group — criterion 1.
- `ReasoningEffortRail > gives the checked pill an offset focus ring in a contrasting token` — pins `focus-visible:ring-foreground`/`ring-offset-2`/`ring-offset-background` on the checked pill — criterion 2.
- `ReasoningEffortRail > keeps the translucent brand ring on unchecked pills` — guard pin (passed immediately by design: it pins the preserved unchecked style, per the brief's "keep the unchecked style") — criterion 2.
- `ReasoningEffortRail > renders disabled pills at raised opacity so they stay perceivable` — pins `opacity-60`, absence of `opacity-40`, `cursor-not-allowed`, `aria-disabled` — criterion 3.

TDD: red run showed exactly the 4 new behavior tests failing for missing classes (the guard pin green as intended), then green after implementation.

## Self-gate

All test runs from `apps/web/` via `pnpm test:watch <file> --sequence.concurrent=false` (per §Gate-policy-amendment; these jsdom suites false-fail with duplicate-element errors under the default concurrent sequence):

- `reasoning-effort-rail.test.tsx` — pass, 27/27.
- `bottom-rows.test.tsx` — pass, 10/10.
- `prompt-input.test.tsx` — pass, 123/123.
- `chat-prompt-input.test.tsx` + `message-input.test.tsx` (consumers of prompt-input) — pass, 32/32.
- `npx eslint` on all 4 touched files (from `apps/web/`, after the final edit) — exit 0 (one prettier class-order autofix applied, then re-run clean).
- `pnpm run typecheck` (apps/web) — **fails on a pre-existing foreign error**: `../api/src/middleware/pipeline-bindings.ts(59,29) TS2304: Cannot find name 'ExecutionContext'`. That file is byte-identical to HEAD (`git status` clean on it) and is in apps/api — outside my ownership; my 4 component-file edits cannot reach it. Raised.

## Visual verification (dev stack, trial chat page)

- 375×720: capacity bar now occupies its own full-width line (label box `[29,333,267,20]`), toolbar+send on the next line right-aligned (`[104,357,192,44]`), zero overlap, `document.documentElement.scrollWidth === 375` (no horizontal scroll). Screenshot: `.playwright-mcp/close-fix-composer-375.png`.
- Keyboard-Tab onto the checked Auto pill (`:focus-visible` confirmed true): clear dark offset ring with a paper gap around the solid red pill. Screenshot: `.playwright-mcp/close-fix-rail-focus-ring.png`.
- Disabled-pill state is not reachable on the trial page (G9 hides infeasible levels for trial); covered by the jsdom pin — the change is a deterministic opacity token swap.

## Acceptance criteria

1. 375px collision fixed, no horizontal scroll, reflow matches responsive flex patterns — **met** (box-measured in-browser + class pins; content-driven `flex-wrap`, no breakpoint hack).
2. Focus visible on checked pill; unchecked style kept — **met** (screenshot + pins; unchecked ring preserved and pinned).
3. Disabled pill visibility raised while clearly non-interactive — **met** (`opacity-60` over `text-muted-foreground`; `aria-disabled`, `cursor-not-allowed`, tooltip + `aria-describedby` reasons unchanged).

## Deviations

- `TextBottomRow` is now exported from `prompt-input.tsx` purely for direct test rendering — same pattern as the pre-existing `ImageBottomRow`/`VideoBottomRow` exports used by `bottom-rows.test.tsx`.

## Concerns and limitations

- The collision's deepest root — the `whitespace-nowrap` label inside `capacity-bar.tsx` (chat/layout/, outside my bounds) can never shrink — is untouched; the in-bounds wrap reflow fully resolves the collision at every width (below ~460px the bar takes its own line), so no out-of-scope edit was needed.
- Repo-root `pnpm test:watch <apps/web file>` cannot resolve the `@` alias for ANY apps/web file (verified on an untouched suite) — pre-existing runner issue; the in-package invocation works and was used.
- apps/web `typecheck` gate is red on the pre-existing apps/api `ExecutionContext` error above (and raw `npx tsc` additionally surfaces a pre-existing error in `model-selector/model-list-body.test.tsx(41,5)`); neither file was touched by this task.
- Full web coverage run not executed (close-gate item per plan); new lines are render-path and exercised by the suites above.

## Confidence

High — all four behavior tests watched red then green, four suites (192 tests) pass sequentially, lint exit 0 after final edit, and both user-visible fixes verified in the real browser at 375px.
