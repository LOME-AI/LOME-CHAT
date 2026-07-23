# impl-report-10 — Pivot follow-ups: e2e retarget, rail-name purge, welcome rows

## Objective

Three fixes raised out-of-bounds by the UI pivot (impl-report-8): (1) retarget
the e2e effort helpers from the deleted rail to the chip
(`TEST_IDS.effortChip` + menuitemradio + 'Mid', open-then-pick); (2) rename the
stale `rail*` exports in `use-reasoning-effort.ts` to chip-era names and purge
every remaining pivot-era 'rail' identifier/string (comments included);
(3) drop `chat-welcome.tsx`'s sizing-inert `rows={6}` to align with the 2-line
ruling.

## Files changed

- `e2e/pages/chat.page.ts` — `reasoningRail()` → `effortChip()` (testid locator); `selectReasoningEffort()` rewritten to the chip's open-then-pick flow (click chip → `menuitemradio` by full word, 'Mid' not 'Medium' → assert took via the chip's self-label — app-emitted state, no wall-clock waits).
- `e2e/chat/chat.spec.ts` — consumes the new helpers (hidden-in-image-mode / visible-then-pick-High steps retargeted); header comment 'rail' → 'chip'.
- `apps/web/src/hooks/chat/use-reasoning-effort.ts` — exports renamed: `railOfferedLabels` → `offeredEffortLabels`, `railOffersNone` → `offersEffortNone`, `RailModel` → `EffortModel`; rail/pill comment wording updated.
- `apps/web/src/hooks/chat/use-reasoning-effort.test.ts` — imports/usages renamed (behavior unchanged).
- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` + `.test.tsx` — importer renames; the "replaces the docked rail" comment reworded to "replaces the earlier docked radiogroup design".
- `apps/web/src/components/chat/page/chat-welcome.tsx` — `rows={6}` dropped (PromptInput's default is the ruled 2-line start).
- `apps/web/src/components/chat/page/chat-welcome.test.tsx` — new test pinning the composer at rows=2 (no override).
- Comment-only rail/pill wording fixes (grep-driven per brief item 2): `apps/web/src/hooks/billing/use-prompt-budget.ts`, `apps/web/src/components/chat/input/prompt-input.tsx`, `apps/web/src/components/chat/page/trial-chat-page.tsx`, `apps/web/src/components/chat/input/prompt-input.test.tsx` (describe name), `packages/shared/src/reasoning-effort.ts`, `packages/shared/src/reasoning-effort.test.ts` (test name), `packages/shared/src/estimate/reasoning-plan.ts`.

## Tests added

- `chat-welcome.test.tsx` — "keeps the composer at the 2-line start (no rows override)" → asserts textarea `rows="2"` → covers criterion 3. Watched RED (rendered rows="6") before dropping the prop; GREEN after.
- No new tests for the renames (behavior-preserving refactor; existing suites pin behavior) or the e2e retarget (verified by tsc + lint per brief; suite run declared optional and not run — no stack running).

## Self-gate

- `pnpm test:watch <file> --run` sequential (gate-policy amendment): use-reasoning-effort 19/19 · reasoning-effort-menu 28/28 · prompt-input 125/125 · chat-welcome + trial-chat-page 92/92 · use-prompt-budget 45/45 · shared reasoning-effort 11/11 · shared reasoning-plan 61/61 — all pass.
- `tsc --noEmit` (e2e) — pass (exit 0): the retargeted spec + page object compile.
- `tsc --noEmit` (apps/web) — fails with EXACTLY the two recorded foreign failures (§Known-foreign-failures): `../api/src/middleware/pipeline-bindings.ts(59)` `ExecutionContext` and `model-list-body.test.tsx(41)`. Neither file touched by me (git-status attribution); no error in any file I changed.
- `eslint <touched files>` after the final edit, run from each package dir (apps/web, packages/shared, e2e) — all exit 0.

## Acceptance criteria

- E2E retarget to `TEST_IDS.effortChip` + menuitemradio + 'Mid', open-then-pick, signal-based waits, no 'rail' naming, spec compiles — **met** (tsc e2e exit 0; waits are auto-retrying expects on the chip's self-label/visibility; `TIMEOUTS`/`TEST_IDS` registries untouched — `effortChip` was already registered by the pivot; no separate e2e/contracts registration exists for test-ids).
- Stale exports renamed + all importers/tests updated + repo-wide 'rail' purge — **met** (final grep: only two unrelated survivors — the member-sidebar collapsed-"rail" comment in `test-ids.ts:503` and a "guard rails" idiom in `models.test.ts:468`; sidebar "rail mode" tests are the unrelated collapsed-sidebar concept, deliberately untouched).
- `chat-welcome.tsx` rows aligned to the 2-line start — **met** (prop dropped; new test pins rows=2; no existing visual assertion pinned rows=6 — full chat-welcome + prompt-input suites green).

## Deviations

- Chip-era names chosen: `offeredEffortLabels` / `offersEffortNone` / `EffortModel` (brief left naming to me).
- Comment-only edits extend beyond the literal BOUNDS file list into `use-prompt-budget.ts`, `trial-chat-page.tsx`, `prompt-input.tsx(.test)`, and three `packages/shared` files — authorized by brief item 2's explicit "grep for any other 'rail' identifiers/strings … comments included", but the shared-package files are outside the BOUNDS enumeration; raised.
- The menu component's founder-ruling comment keeps the historical fact but says "docked radiogroup design" instead of "rail" to satisfy the no-rail-strings directive without losing the rejected-alternative record.
- E2E suite not executed (optional per brief; no stack was running). Compile + lint verified.

## Concerns and limitations

- `selectReasoningEffort('Mid')` asserts via chip label text (`Effort · Mid`); if the chip's label grammar ever changes, the helper needs the same edit — single call site, low risk.
- The retargeted spec's live behavior (menu portal click-through under the composer, slide-out timing under reduced motion) is unverified until the chat suite runs; tsc/lint cannot prove runtime locator validity.

## Confidence

high — all touched suites green, RED→GREEN observed for the one behavior change, renames grep-verified complete, e2e compiles clean; residual risk confined to the unrun e2e suite.
