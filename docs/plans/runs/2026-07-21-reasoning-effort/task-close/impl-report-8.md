# impl-report-8 — Effort UI redesign (rail → founder-pivoted dropdown chip) + composer sizing

## Objective

Founder-ordered redesign of the effort UI, amended mid-task three times:
initial brief = rail redesign (full 4-char words, Effort header, 4-row column
rule, rail inside composer); mid-task additions = descending row-major flow,
item 5 (slide in/out transition), item 6 (textarea 2→7 lines), item 7 (pane
anchoring — subsequently HELD); final pivot (2026-07-23 confirmed) =
**replace the rail entirely with a dropdown chip** left of the send button,
voiding items 2/3/7; items 1 (4-char words), 5 (slide), 6 (textarea sizing)
survive re-targeted. Reuse-before-build and delete-orphans directives applied.

## Files changed

- `packages/shared/src/reasoning-effort.ts` — display label `medium: 'Medium'` → `'Mid'` (≤4-char rule; enum/wire values untouched).
- `packages/shared/src/reasoning-effort.test.ts` — pins `Mid` + all-labels-≤4-chars.
- `packages/shared/src/test-ids.ts` — added `effortChip: 'effort-chip'` (chip trigger id for tests/e2e retarget).
- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` — **new**: the effort chip (`Effort · <current>`, model-selector chip grammar: outline Button + `bg-secondary`) opening an upward `DropdownMenu` (`side="top"`, owned shadcn primitives — no new primitive built) with `DropdownMenuRadioGroup` (menuitemradio semantics); carries over the shared-plan feasibility classifier (`effortOptionStates`, ex-`railPillStates`, logic unchanged), the cause-specific disabled reasons (`EFFORT_DISABLED_REASONS`, tooltip + `aria-describedby`, aria-disabled-not-Radix-disabled so items stay hover/focus-reachable), trial hiding, trial-reset effect, and the CSS slide wrapper (`grid-template-columns 0fr↔1fr` + state-snapshot retention until `transitionend`).
- `apps/web/src/components/chat/input/reasoning-effort-menu.test.tsx` — **new**: 28 tests (6 classifier + 22 component).
- `apps/web/src/components/chat/input/reasoning-effort-rail.tsx` / `.test.tsx` — **deleted** (pivot orphans; grep-verified zero remaining consumers of `ReasoningEffortRail`/`railPillStates`/`RAIL_DISABLED_REASONS`).
- `apps/web/src/components/chat/input/prompt-input.tsx` — composer restored to single-column full-width box (right section removed); chip placed in the send-button group immediately left of Send; textarea defaults `rows 2`, `minHeight 4rem` (2 lines), `maxHeight 11.5rem` (7 lines) — auto-grow rides the ui Textarea's existing `field-sizing-content`, internal scroll via existing `overflow-y-auto`.
- `apps/web/src/components/chat/input/prompt-input.test.tsx` — rail tests replaced with chip tests (presence, left-of-send placement, absence on non-reasoning model); sizing default tests re-pinned (4rem/11.5rem/rows=2/auto-grow+scroll classes).
- `apps/web/src/components/chat/input/chat-prompt-input.tsx` — dropped its `rows={2} minHeight="56px" maxHeight="112px"` overrides so the canonical 2→7-line defaults govern the live composer.
- `apps/web/src/components/chat/input/chat-prompt-input.test.tsx` — pins that no sizing overrides are passed.

## Tests added (net, final state)

- shared: `Mid` label; all labels ≤4 chars.
- menu classifier (`effortOptionStates`): enabled-all / balance-infeasible / output-limit / None-omitted-on-mandatory / None-balance / None-output-limit (carried from rail suite, behavior identical).
- chip: hidden for non-reasoning model, Smart sentinel, non-text modality; label `Effort · Auto` default / `Effort · Mid` active / Auto fallback when preferred unoffered; opens upward (`data-side="top"`) listing full words Auto/High/Mid/Low/None in order; checked menuitemradio = effective; single click selects + closes; greyed item: aria-disabled + balance reason via aria-describedby; output-limit reason variant; activation of greyed item ignored (double guard); greyed perceivable at opacity-60 (never hidden, non-trial); trial hides infeasible + trial reset-to-auto; 44px (`min-h-11`) menu items on mobile; slide wrapper collapsed-when-hidden / expanded-when-visible / no `motion-reduce` override (global `html.reduced-motion` kill is event-preserving — verified in `packages/ui/.../styles/motion.css`) / outgoing chip retained inert until wrapper `transitionend` / bubbled child transitionend ignored / visible-state transitionend a no-op.
- prompt-input: chip shown with reasoning model, absent otherwise, placed immediately left of send; 2-line min / 7-line max / rows=2 / auto-grow+scroll classes.
- chat-prompt-input: no sizing overrides forwarded.

## Self-gate

- `pnpm test:watch <file> --run` (sequential, per gate-policy amendment): reasoning-effort-menu 28/28 · prompt-input 125/125 · chat-prompt-input 9/9 · message-input 24/24 · bottom-rows 10/10 · queued-messages 12/12 · animated-placeholder 11/11 · use-reasoning-effort 19/19 · shared reasoning-effort 11/11 · shared test-ids 41/41 — all pass.
- Per-file coverage probe (menu component): 100% stmts/lines/funcs, 98.5% branch (≥95).
- `tsc --noEmit` apps/web: only the two plan-listed foreign failures (`pipeline-bindings.ts` ExecutionContext, `model-list-body.test.tsx`) — reproduce on files I never touched. packages/shared: clean.
- `eslint` (from each package dir, after the final edit): exit 0 on all 9 touched files.

## Acceptance criteria (surviving set, post-pivot)

- 4-char full words from shared labels — **met** (labels module + menu items render full words; no abbreviations anywhere).
- Chip left of send, self-labeling `Effort · <current>`, sibling-matched grammar — **met** (model-selector chip classes reused; `size="sm"` trigger, no extra row height; exact visual match is jsdom-unverifiable — see concerns).
- Upward menu, standard menu semantics — **met** (Radix DropdownMenu `side="top"`, menuitemradio; keyboard model is the Radix menu pattern, superseding roving-radio per pivot).
- offeredLevels-only rendering, Auto first, None last, None hidden on mandatory — **met** (unchanged classifier consuming `railOfferedLabels`/`railOffersNone`).
- Greyed-never-hidden + cause-specific tooltip/aria-describedby (non-trial); trial hiding (G9) — **met**.
- One-touch selection; persistence via existing store; clamp rules unchanged — **met** (store/hook untouched).
- G5 shared-plan feasibility, live recompute with budget estimate — **met** (logic unchanged from audited T9 work).
- 44px touch targets (mobile menu items) — **met**; the chip itself matches sibling control height per the pivot's "zero extra row height" (h-8 `size="sm"`; flagged in concerns).
- Slide in/out on capability/modality change, CSS transition, reduced-motion gated — **met** (grid-columns wrapper; global `html.reduced-motion` kill governs it — deliberately no `motion-reduce:transition-none`, which would drop the `transitionend` that unmounts the outgoing chip).
- Textarea 2-line start → 7-line cap → internal scroll, no text jump — **met** as far as jsdom reaches (style/attr/class pins); actual grow/scroll behavior is browser-only (field-sizing).
- Rail fully removed, orphans deleted — **met** (files deleted; grep-verified; TEST_IDS never had rail entries; e2e retarget flagged, out of bounds).

## Deviations

- **TDD lapse on the pivot's component tests**: the chip/menu test file was authored before the component existed, but I implemented immediately without executing the RED run (module-missing failure was the predictable state). Same for the two prompt-input chip-placement tests. Compensated with mutation checks — flipping `side="top"`→`"bottom"` and deleting both disabled-activation guards each produced exactly the expected single-test failures. All earlier work (labels, rail iterations, sizing, slide) was strict red-green with observed failures.
- The pivoted keyboard model is Radix's menu pattern (typeahead/arrows/Escape owned by the primitive) — the plan's founder-ratified radiogroup/focus-then-confirm model is superseded by the pivot's explicit "standard menu semantics".
- Disabled menu items use `aria-disabled` + double activation guard instead of Radix `disabled`, so the tooltip and described-by reason stay reachable by hover AND keyboard highlight (Radix-disabled items are pointer-events-none and unfocusable, which would break the pinned discoverable-reason contract).
- Item 7 (pane anchoring) was HELD then voided by the pivot; nothing was built for it.

## Concerns and limitations

- **Visual-only, needs the live design-review pass**: chip look next to siblings (`size="sm"` h-8 vs icon-button h-9 — chosen to read as a labeled chip, not an icon button; judge live), upward-menu feel on mobile, slide smoothness and composer reflow, 7-line grow behavior (`field-sizing-content` is a modern-browser feature; jsdom can't exercise it), tooltip-inside-menu interaction feel.
- The stale chip retained during slide-out shows the last label; its dropdown could theoretically be opened during the ~300ms collapse (pointer-events-none + aria-hidden mitigate; window is small).
- `chat-welcome.tsx` still passes `rows={6}` (out of my bounds) — inert for sizing under `field-sizing-content` + the new min-height, but contradicts the 2-line ruling on the welcome screen.
- Residual uncovered branch (98.5%): one arm of the wrapper `transitionend` guard.

## Confidence

high — every surviving pinned behavior is test-pinned and green, checks clean, deletions grep-verified; the open items are visual-fidelity questions explicitly deferred to the design-review pass.
