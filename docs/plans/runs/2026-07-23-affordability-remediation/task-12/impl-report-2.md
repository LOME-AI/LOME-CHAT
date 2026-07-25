# Task 12 — fix cycle — impl report 2

Scope: the one validated audit finding (picker floor traps an already-selected
model) plus the two items the auditor routed back (dead `isAuthenticated` prop;
A7's open client bullet — the pool-candidate `maxOutputTokens` copy). Nothing
else from impl-report-1 was reworked.

## Files changed

Source:

- `apps/web/src/components/chat/model-selector/model-selector-modal.tsx` — the
  below-floor activation guard no longer blocks a REMOVAL: `handleRowActivate`
  computes `isRemoval = pickerMode === 'multi' && localSelectedIds.has(modelId)`
  and only refuses when `!isRemoval`. `localSelectedIds` added to the callback's
  dependency list (it is now read directly, not only through
  `isMultiModelSignupBlocked`).
- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` — the dead
  `isAuthenticated` prop and its "unused, kept for the call site" comment are
  gone from `ReasoningEffortMenuProps`.
- `apps/web/src/components/chat/input/prompt-input.tsx` — one line: the
  `isAuthenticated={…}` pass to `ReasoningEffortMenu` (the prop's last passer).
  `isAuthenticated` itself is still live in this file (media-icon gating).
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — `smartModelPoolFromCatalog`
  now copies the wire `maxOutputTokens` onto each `SmartModelPoolCandidate`
  (conditional spread: the field is optional on both sides, and
  `exactOptionalPropertyTypes` forbids passing `undefined`).

Tests: `model-selector-modal.test.tsx`, `use-prompt-budget.test.ts`,
`reasoning-effort-menu.test.tsx`.

## Tests added (behavior — item covered)

`model-selector-modal.test.tsx` — three cases, the trap plus both
over-correction directions:

1. *lets a below-floor model already in the pending selection be removed* —
   multi mode, selection `[gpt-4-turbo, llama]` with llama below the floor:
   the row starts `data-selected="true"` and a click flips it to `"false"`.
   **This is the finding's pin.**
2. *still refuses to add a below-floor model that is not already selected* —
   multi mode, llama below the floor and not selected: a click leaves
   `data-selected="false"` (grey is still not selectable).
3. *still refuses to commit the selected below-floor model in single mode* —
   single mode with llama selected AND below the floor: neither `onSelect` nor
   `onOpenChange(false)` fires (see Deviations 1 — single-mode activation is a
   commit, not a removal, so it stays blocked).

`use-prompt-budget.test.ts` — *excludes a catalog model whose provider cap
cannot fund a minimum answer from the Smart Model floor*: a catalog of a cheap
model with `maxOutputTokens = MINIMUM_OUTPUT_TOKENS − 500` and a pricier model
that can emit the answer. The expectation is computed through
`smartModelMinimumRequiredNanoUsd` over candidates carrying their caps; at that
allowance the Smart Model row is selectable, one nano below it greys. Without
the copy the hook prices the floor through the capped model and reports
affordable — the under-denial.

`reasoning-effort-menu.test.tsx` — no new case; the prop drops out of the
render helper and the two direct renders. The former "greys infeasible levels
for trial users too" case keeps both assertions (infeasible level
`aria-disabled`, feasible level not) under a name that no longer claims a tier
input the component cannot receive; a comment records why the tier dimension is
gone (see Concerns 2).

## TDD, red → green per item

1. **Trap (modal).** All three cases written first. Case 1 RED:
   `expected data-selected="false", received "true"` at the post-click
   assertion — the guard swallowed the toggle. Cases 2 and 3 passed on the old
   code by construction (they pin what must NOT change); after the fix all
   three are green, so the pin brackets the change in both directions.
   Green: `model-selector-modal.test.tsx` 137/137.
2. **Pool cap (use-prompt-budget).** RED: `expected false to be true` at the
   `floor − 1n` assertion — the hook said "affordable" one nano below the true
   floor, exactly the under-denial. Green after the copy: 64/64 in that file.
3. **Dead prop.** A deletion, so the red is the compiler, not a new assertion:
   removing the prop from the interface produced four `TS2322 Property
   'isAuthenticated' does not exist` errors — `prompt-input.tsx(792,11)` (the
   only production passer) and three in `reasoning-effort-menu.test.tsx`
   (83, 487, 502). All four sites updated; both web typecheck legs exit 0 and
   `grep -rn 'ReasoningEffortMenu' apps/web/src e2e` shows only the import +
   the single (now prop-free) render in `prompt-input.tsx`; `grep -n
   isAuthenticated` in `reasoning-effort-menu.tsx` and its test: no matches.

## Self-gate

- `pnpm test:web`, forced/uncached (`turbo test --filter=@hushbox/web --force`,
  `apps/web/node_modules/.vite` cleared) — see the attribution note below; the
  run is polluted by a CONCURRENT agent running the same package suite and
  editing web source mid-run.
  - Run 1 (17:01): 380/382 files, 6239/6241 tests. 2 failures:
    `src/lib/auth.test.ts > signOutAndClearCache > stops push delivery to this
    device before the session ends` and `src/components/shared/app-shell.test.tsx
    > … Enable button`. Both are the push/notification lane (A1 addendum 3):
    the assertions are about `notificationChannel.unregister` and the
    notification-enable prompt, the sources are untracked
    (`src/lib/notification-channel/`, `src/hooks/notifications/`), and
    `app-shell.test.tsx` was rewritten at 17:01:36 — inside the run.
  - Run 2 (17:06): 380/381 files, 6243/6244 tests; only `auth.test.ts` failed,
    and that file was written at 17:06:41 — one second after the run started.
  - Run 3 (17:17): aborted by `Unhandled Rejection: Something removed the
    coverage directory … coverage/.tmp` — `ps` confirmed a second vitest
    (`--coverage --maxWorkers=24`, foreign pid tree, its own weights file)
    running the same package concurrently. Re-run per A1 (below).
  - **Run 4 — CLEAN, the run of record:** the whole package suite under
    `--coverage` (so the config's `perFile: true` 95 gate applies), with
    `--coverage.reportsDirectory` pointed at a private scratch dir so the
    foreign vitest could not remove my `coverage/.tmp` again:
    **381 files, 6247 tests, exit 0** — no failures, no threshold errors
    (aggregate 99.63 stmt / 98.74 branch / 99.72 func / 99.85 line). The push
    lane's `auth.test.ts` passes now that its edit settled, which retro-confirms
    the run-1/2 attribution. This run goes through `vitest` directly rather
    than `scripts/run-package-tests.ts`, so it applies the same coverage gate
    but not the wrapper's worker sizing or the pole gate; nothing in this cycle
    adds a test file, so the pole gate is unaffected.
  - None of my four source files is imported by `auth.test.ts` or
    `app-shell.test.tsx`; every suite touching my files is green.
- Per-file coverage for the owned files (run 4 table):
  `model-selector-modal.tsx` 98.85 stmt / 95.83 branch / 100 func / 100 line;
  `use-prompt-budget.ts` 97.38 / 96.49 / 100 / 100; `prompt-input.tsx` 99.31 /
  99.14 / 100 / 100 — all clear the 95 gate on every axis. The new conditional
  spread is covered on both sides (existing catalog fixtures carry no cap; the
  new test's do), and the `isRemoval` guard on all three of its paths
  (multi+selected, multi+unselected, single).
- `pnpm typecheck` web — both legs (`tsgo --noEmit`, `tsgo -p
  tsconfig.native-tests.json`) exit 0, run after the final edit.
- `eslint <owned files>` from `apps/web`, after the final edit — exit 0.
  Per A15 the probe used the default formatter and carried a positive control:
  the same invocation included a deliberately mis-formatted scratch file, which
  reported `1 problem (prettier/prettier)` while all seven owned files stayed
  silent; the scratch file was deleted immediately. (An earlier round did fire
  on two owned prettier wraps in the menu test, fixed with `--fix` from the
  package dir.)
- Repo-wide typecheck not run: unchanged from report 1 (A1 addendum 3 keeps it
  red from the push/sandbox lane). No shared package was touched this cycle —
  all four edits are web-local, so A3's sweep is satisfied by the two web
  typecheck legs.

## Acceptance criteria (this cycle's items)

1. **Finding — an already-selected model that falls below the floor must stay
   removable, while grey stays not-selectable** — MET. `isRemoval` opens the
   guard only for a multi-mode de-selection; pinned in all three directions
   (removal works, addition still refused, single-mode commit still refused).
   The trap the finding describes (selection `[cheap A, pricey B]`, B greys,
   only Clear-all escapes) is gone: clicking B drops it and A remains.
2. **Routed item — the dead `isAuthenticated` prop and its last pass site** —
   MET. Prop and pass site removed; grep + typecheck evidence above.
3. **Routed item — A7's client bullet: copy the wire `maxOutputTokens` into
   `SmartModelPoolCandidate`** — MET. `smartModelPoolFromCatalog` carries it;
   the under-denial is pinned by a test that was red for exactly that reason.
   Both consumers of the helper (the composer's Smart Model estimate at
   `resolveEstimatedCostNanoUsd` and the picker floor) tighten together, which
   is the direction A7 asked for and lands before T16.

## Deviations, with reasons

1. **The guard falls through on `pickerMode === 'multi' && localSelectedIds
   .has(modelId)`, not on `localSelectedIds.has(modelId)` alone** (the
   finding's literal suggestion). In single mode, activating the
   already-selected row is a COMMIT (`commitSingleSelection` → `onSelect` +
   close), not a removal, so the literal form would let a user send with a
   below-floor model — the criterion's "grey = not selectable" break. Single
   mode has no trap to fix: another model can always be picked, which replaces
   the greyed one. Case 3 pins this.

## Concerns and limitations

1. **A removable below-floor row still renders `aria-disabled`.** The grey +
   tooltip is the information the user needs ("this one doesn't fit your
   balance" — that is *why* they should drop it), so the row must keep it; but
   assistive tech now hears "disabled" on a control whose click does something
   (removal). The honest rendering would be to drop `aria-disabled` only when
   the row is a pending selection in multi mode — that lives in
   `model-list-item.tsx` / `model-list-body.tsx`, outside this fix's bounds.
   Flagged for the orchestrator rather than silently taken.
2. **"Trial greying" is no longer expressible as a menu input.** Removing the
   prop removes the only auth-shaped input the menu had; its greying now
   depends solely on the selection, `maxOutputTokens`, and context. The former
   trial case keeps its assertions but not its tier framing (a test name
   claiming a tier the component cannot observe would be a wrong comment).
   Criterion "trial greying" from the original task is now satisfied
   structurally — the menu cannot branch on tier — plus the grey-never-hide
   pins; if the auditor wants a live trial-tier assertion it belongs at the
   composer level, not here.
3. **Concurrency, not flake, dominated this cycle's package runs.** A second
   agent is editing `apps/web` (push/notification lane: `auth.ts`,
   `app-shell.tsx`, untracked `notification-channel/`, `hooks/notifications/`,
   plus `lib/document-parser.ts` mid-session) and running the same vitest
   package with the same `coverage.reportsDirectory`. Any auditor re-running
   `pnpm test:web` should expect the same two failure sources and the same
   `coverage/.tmp` ENOENT class, and should re-run rather than attribute.

## Confidence

High on all three items: each was watched red for the right reason and is green
with the surrounding suites intact, the deviation is pinned by its own case,
lint/typecheck are clean after the final edit, and the full package suite runs
green under the per-file coverage gate once the concurrent lane's collision is
isolated away.
