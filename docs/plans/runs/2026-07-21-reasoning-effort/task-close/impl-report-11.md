# impl-report-11 — Effort chip width tweaks (founder-ordered 2026-07-23)

## Objective

(1) Dropdown content renders at exactly the trigger chip's width; (2) the chip's width is fixed at the widest possible "Effort · <word>" label so it never resizes when the selection changes; slide-transition mechanics preserved.

## Files changed

- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` — content width via the Radix trigger-width CSS variable + ghost-label grid stack inside the trigger button.
- `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx` — two new tests; three label assertions tightened from `toHaveTextContent` to `toHaveAccessibleName`.

## Implementation choices

- **Menu width:** `className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0"` on `DropdownMenuContent`. House pattern verified: `packages/ui/src/components/select.tsx:73` already uses the analogous `--radix-select-trigger-width` variable. `min-w-0` is required because the dropdown primitive carries `min-w-[8rem]` (dropdown-menu.tsx:36) which would beat the exact width for a chip narrower than 8rem; `cn` = twMerge (packages/ui/src/lib/utilities.ts), so the caller's `min-w-0` wins the conflict group (pinned by asserting `min-w-[8rem]` is absent from the merged class).
- **Fixed chip width:** ghost-label stack — all seven `REASONING_EFFORT_LABELS` values rendered as `invisible` + `aria-hidden` spans stacked in one grid cell (`col-start-1 row-start-1`) behind the visible label. **Documented deviation from the brief's suggested ch measure:** `ch` is the width of the "0" glyph, an approximation under the proportional UI font — a `13ch` reserve could still under-reserve (chip resizes, bug survives) or over-reserve (padded chip). The stack is font-exact for the true widest label with no magic number. The brief's core demand (no magic pixel width, documented choice) is satisfied; comment in the component records the rationale.
- **Slide preserved:** no min-width was added to the slide wrapper or the overflow-hidden inner div — the fixed width lives on the button content, which the existing `grid-cols-[0fr]` + `overflow-hidden` collapse clips exactly as before. All four pre-existing slide tests pass unchanged.
- **Label tests tightened:** ghosts put every label into the chip's `textContent`, which would have made the existing `toHaveTextContent('Effort · X')` assertions vacuously true. Switched to `toHaveAccessibleName` (dom-accessibility-api excludes `aria-hidden` ghosts), keeping the assertions meaningful.

## Tests added

- `renders the menu at exactly the trigger chip width` — pins the trigger-width var class on the content and the absence of the 8rem floor — criterion 1.
- `reserves the widest possible label inside the chip so its width never changes` — pins one invisible/stacked ghost per label (all 7) and that the accessible name stays the current selection only — criterion 2.
- (updated) three chip-label tests now assert accessible name — guards ghost leakage into the label.

## Self-gate

- `pnpm exec vitest run src/components/chat/input/reasoning-effort-menu.test.tsx` (apps/web) — **pass**, 30/30. New tests watched RED first (both failed for feature-missing: class absent / ghosts absent), then GREEN.
- `pnpm exec eslint <both files>` (from apps/web, after final edit) — **pass** (one unicorn/prefer-spread caught and fixed, re-run clean).
- `pnpm exec tsc --noEmit` (apps/web) — fails ONLY on the two attributed foreign failures from §Known-foreign-failures: `../api/src/middleware/pipeline-bindings.ts(59,29)` ExecutionContext and `src/components/chat/model-selector/model-list-body.test.tsx(41,5)` — both on files I never touched, both pre-listed in plan.md. No error in my owned files.

## Acceptance criteria

- Menu same width as trigger via Radix variable — **met** (class pinned in test; house pattern followed).
- Chip width fixed at widest label, no magic pixel — **met** (ghost stack; jsdom pins class/structure presence).
- Slide transition mechanics preserved (grid-template-columns collapse, no hard min-width breaking it) — **met** (no min-width introduced on wrapper/inner; all slide tests pass unchanged).
- TDD what jsdom can pin — **met** (class-presence + accessible-name tests, watched RED first).

## Deviations

- Ghost-label stack instead of the suggested ch/tabular measure (reasoned above; comment documents it in-code).

## Concerns and limitations

- jsdom cannot measure rendered pixel widths; the tests pin structure/classes. Actual equal-width rendering rests on Radix's documented trigger-width variable (same mechanism already trusted in the select primitive) and CSS grid stacking — worth one eyeball in the design review already scheduled for T9/T10.
- The ghost stack includes `max` even though the current widest candidates are 4-char words — free future-proofing, no behavior change.

## Confidence

high — behavior pinned where jsdom can reach; the one unpinnable aspect (pixel equality) rides a mechanism the codebase already uses.
