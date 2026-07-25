# Task 12 — Client effort & picker UX — impl report 1

Status: COMPLETE (all acceptance criteria met). This report replaces the initial
NEEDS_CONTEXT report; the blocker it raised (picker floor vs group funding) was
resolved by **plan Amendment A11**, which extended this task's file ownership to
the minimal prop-threading edits in the callers that render the model selector
and recorded the T13-seam deviation as binding on T13.

## Objective

Menu: render the shared `turnEffortOptions` union for every tier
(grey-never-hide, trial/guest included), Min per the shared labels, auto always
enabled. Picker: grey unaffordable-minimum models with a tooltip through the
same shared floor verdict that feeds the composer (exported from
`use-prompt-budget.ts`), premium lock unchanged and separate.

## Files changed

Source:

- `apps/web/src/hooks/chat/use-reasoning-effort.ts` — `EffortModel` now
  declares `maxOutputTokens` (A7/A8 structural-passthrough closure: the wire row
  carries it, the undeclared field would type-erase at this seam); new
  `serverAcceptsChoice(models, choice)` — the T13 seam predicate (below).
- `apps/web/src/components/chat/input/reasoning-effort-menu.tsx` — the choice
  SET is now `turnEffortOptions(models)` (union + Min) instead of the
  intersection ladder; the local per-model `planReasoning`/`planReasoningOff`
  headroom math died with it (A7: the cap term now rides the shared option's
  `completionCapTokens`); new `unsupported` option state + reason copy; the
  trial-only option **filter and its reset-to-auto effect are deleted**; auto
  stays hardcoded-enabled.
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — new exported
  `useModelFloor` + `ModelFloorGroupContext`/`UseModelFloorInput`/
  `ModelFloorResult`, and the internal `modelFloorNanoUsd`. Reuses this file's
  existing group plumbing (`resolveIsGroupMember`, `resolveGroupBudgetArgument`,
  `useGroupBillingContext`, `resolveSizingTier` → shared `payerSizingTier` per
  A9) so the picker and the composer resolve funding through one code path.
- `apps/web/src/components/chat/model-selector/model-list-item.tsx` —
  `isBelowFloor` prop; greyed row (`opacity-60`, `data-below-floor`),
  `aria-disabled` + `aria-describedby` + tooltip on the row button; exported
  `MODEL_BELOW_FLOOR_REASON`.
- `apps/web/src/components/chat/model-selector/model-list-body.tsx` —
  `isBelowFloor(model)` threading to each row.
- `apps/web/src/components/chat/model-selector/model-selector-modal.tsx` —
  calls `useModelFloor`, accepts `floorGroup`, and hard-guards row activation
  (grey = not selectable) after the premium gate.
- `apps/web/src/components/chat/model-selector/model-selector-button.tsx`,
  `.../layout/chat-header.tsx`, `.../layout/chat-layout.tsx` — **A11 ownership
  extension**: `floorGroup` prop threading only. `chat-layout.tsx` derives it
  from `groupChat` in a module-level `buildFloorGroup` helper (an inline
  conditional pushed `ChatLayout` over the repo's complexity-10 lint cap).

Tests: `use-reasoning-effort.test.ts`, `reasoning-effort-menu.test.tsx`,
`use-prompt-budget.test.ts`, `model-selector-modal.test.tsx`,
`model-list-item.test.tsx` / `model-list-body.test.tsx` (fixture prop),
`model-selector-button.test.tsx`, `chat-header.test.tsx`, `chat-welcome.test.tsx`,
`routes/_app/chat.index.test.tsx` (the last four: mock additions, see
Cross-task side effects).

## Tests added (behavior — criterion)

`reasoning-effort-menu.test.tsx`

- 4-case parametrised pin: **menu options (minus Auto) === `turnEffortOptions`
  output** for a single ladder, a heterogeneous selection, a mandatory sibling,
  and a 1-real-choice model, with Auto always first — criterion 1.
- Heterogeneous union rendered in display order `Auto, Max, High, Mid, Low,
  Lite, Min` with union-only rungs greyed + the reason exposed — criterion 1 +
  the T13 seam.
- Trial (`isAuthenticated: false`): infeasible High **greys** (`aria-disabled`)
  instead of disappearing, Low stays enabled — criterion 1 (filter deleted).
- Auto enabled on a 1-choice (Min-only) model; Auto enabled and selectable when
  the balance funds nothing (every level greyed) — criterion 1 (auto stays).
- Completion-cap bound: a declared 2000-token cap greys every level as
  `output-limit` while Min (B = 0) stays enabled — A7 cap term.

`use-reasoning-effort.test.ts` (4) — `serverAcceptsChoice`: accepts a level every
model offers, rejects a union-only level, accepts Min when nothing is mandatory,
rejects Min against a mandatory sibling.

`use-prompt-budget.test.ts` (11) — `useModelFloor`: exact floor boundary
(at-floor selectable / one nano below greys, computed independently in the test
through the shared `priceRequest`+`evaluateManifest` fold); paid gates on served
spendable; a mandatory-reasoning model greys where an identically-priced plain
model does not (cheapest configuration = lowest rung); **group headroom funds a
member below their own floor** and greys when both are exhausted; owner treated
as self-funded (`useConversationBudgets(null)`); trial fixed-1¢ arm; media rows
(no per-token rates) never grey; the Smart Model row prices through the shared
pool minimum; catalog-loading and nothing-prices cases never grey; pending
funding inputs suppress greying — criterion 2.

`model-selector-modal.test.tsx` (4) — a below-floor row carries
`data-below-floor` + `aria-disabled` + the reason text while siblings do not;
clicking it neither selects nor closes while a funded row still commits;
a premium-locked row shows the paywall and **never** the floor grey (separate
gates); `floorGroup` is threaded into the hook verbatim — criterion 2.

TDD: every batch was written first and watched fail for the right reason —
`serverAcceptsChoice is not a function` (4 red); 4 menu cases red on the
intersection ladder / missing cap term / hidden trial options; `useModelFloor is
not a function` (10 red); 3 modal cases red (no `data-below-floor`, selection not
blocked, hook not called). The late-added `turnEffortOptions` equality pin was
verified red by temporarily re-deriving the option set through the intersection
gate (heterogeneous case failed; implementation restored immediately, suite
re-run green).

## Self-gate

- `pnpm test:web` (`turbo test --filter=@hushbox/web --force`, cache distrusted;
  `node_modules/.vite` cleared per A6) — **pass**: 373 files, 6158 tests, exit 0,
  per-file coverage gate green.
  - Two earlier attempts failed for non-task reasons, both re-run clean:
    (a) `coverage/.tmp` `ENOENT` / "Something removed the coverage directory" —
    caused by my own two overlapping turbo runs sharing
    `coverage.reportsDirectory`; (b) a coverage shortfall on
    `src/hooks/models/use-premium-model-click.ts` (37.5% lines) — file untouched
    and git-clean, and its own test file alone yields 88.9% statements, so the
    reported figure is below what a single collection run produces; did not
    reproduce on the next run. Same class as the coverage-collection flake T09
    recorded.
  - `use-prompt-budget.ts` needed two extra branch tests to clear per-file 95%
    (94.64% → 96.42% branches); both are real behaviors (catalog loading,
    nothing prices).
- `pnpm typecheck` web (`tsgo --noEmit` + `tsgo -p tsconfig.native-tests.json`) —
  **pass**, exit 0, run after the final edit.
- `eslint <owned files>` from `apps/web` **after the final edit** — exit 0
  (three fix rounds: prettier wraps, plus the `ChatLayout` complexity cap that
  forced the `buildFloorGroup` extraction).
- Repo-wide typecheck NOT run: A1 addendum 3 records the push/sandbox lane
  keeping it red; scoped web typecheck is the meaningful gate. No shared-package
  type or schema was changed by this task (A3 sweep below).

## A3 consumer sweep

Contracts changed are all web-local: `EffortModel` (+`maxOutputTokens`),
`ModelListItemProps`/`ModelListBodyProps` (+`isBelowFloor`), the modal/button/
header `floorGroup` prop, and the new `use-prompt-budget` exports.
`grep` for each name across `apps/`, `packages/`, `scripts/`, `e2e/`: no
consumer outside `apps/web`. Both web typecheck legs pass, which covers every
in-package producer including test fixtures.

## Acceptance criteria

1. **Effort menu = shared `turnEffortOptions`; grey-never-hide for every tier;
   Min per shared labels; no separate `none`; auto stays enabled** — MET.
   Equality pinned over 4 selection shapes; trial filter + reset effect deleted
   (grep: no `isAuthenticated ? options` / `state === 'enabled'` filter remains
   in the file); Min renders from `REASONING_EFFORT_LABELS['none']` = "Min" as
   the off row, never as a distinct concept; Auto is prepended with a hardcoded
   `enabled` state and stays selectable with everything else greyed.
2. **Picker greys unaffordable-minimum models via the same shared floor that
   feeds the composer; premium lock unchanged and separate; grey = not
   selectable with an explaining tooltip** — MET. One implementation:
   `useModelFloor` resolves through `resolveClientBilling` over the same served
   spendable / allowance / trial arm and the same group dimension the composer
   uses (`useConversationBudgets` + `useGroupBillingContext`), sized by the
   shared `payerSizingTier`; the row is `aria-disabled` with a tooltip +
   `aria-describedby`, and `handleRowActivate` refuses it authoritatively.
   Premium gating is evaluated first and suppresses the floor grey entirely.
3. **A8 intersection-frozen `offeredEffortLabels` consumers in my files
   retired** — PARTIALLY, per A11 (recorded deviation, not a gap): the menu's
   rendering consumer is retired; the two remaining consumers live in
   `use-reasoning-effort.ts` (`effectiveReasoningSelection`'s wire clamp and the
   new `serverAcceptsChoice` seam predicate) because the client must not send
   what today's server 400s. A11 makes retiring them T13's final micro-edit.
4. **Component tests: union across heterogeneous selection, trial greying,
   picker greying, auto enabled on a 1-choice model** — MET (all four listed
   above).

## The T13 seam (what stays greyed until the server union lands)

The server still validates effort by unanimity (`levelEntries`) and refuses
`none` against a mandatory-reasoning model, and the client wire choice is
unchanged (`effectiveReasoningSelection` still clamps by the intersection).
So the menu renders the union but marks two classes `unsupported` — greyed with
"Not supported by every selected model":

- a rung at least one selected model does not offer (union-only rungs), and
- Min when any selected model has mandatory reasoning.

Nothing about what the client SENDS changed. When T13 lands per-model downgrade
resolution, deleting `serverAcceptsChoice` (and the intersection clamp inside
`effectiveReasoningSelection`) de-greys those options and finishes off
`offeredEffortLabels`; the menu itself needs no further change.

## Deviations, with reasons

1. **`offeredEffortLabels` survives** — see criterion 3 / the T13 seam; A11
   accepted and made it binding on T13.
2. **`ReasoningEffortMenu`'s `isAuthenticated` prop is now unused** (kept, with
   a comment): removing it requires editing `prompt-input.tsx`, which is outside
   this task's Files list. A one-line cleanup for whoever next owns the
   composer.
3. **A11 caller edits** — `chat-header.tsx` / `chat-layout.tsx` /
   `model-selector-button.tsx` carry `floorGroup` threading only; the sole
   non-passthrough line is `chat-layout.tsx`'s `buildFloorGroup`, a 4-line
   shape-mapping helper extracted because the inline form breached the
   complexity-10 lint cap. No floor logic exists in any caller.
4. **The floor prices a zero-length prompt** (model-intrinsic minimum), not the
   composer's current text — see Concerns 1.

## Concerns and limitations

1. **Interpretation raised — the floor's prompt term.** §Affordability 4's
   "fixed costs + a minimum answer" includes the turn's input cost, but the
   picker cannot see the composer's text (and re-deriving it there would be a
   second prompt-measurement path, which One Implementation forbids). The floor
   therefore prices input at zero, making it a strict lower bound of the
   composer's verdict: a model can pass the picker and still be denied by the
   composer for a long prompt. This is deliberate and directionally safe —
   greying blocks selection, so under-greying degrades to the composer's own
   (correct) denial, whereas over-greying would hard-block a model the user can
   actually afford. Flagging it because a stricter reading would thread
   `promptCharacterCount` into `useModelFloor`.
2. **Mandatory-reasoning tightening.** A mandatory-reasoning model's floor now
   includes its lowest offered rung's reasoning budget (§Affordability 4's
   "cheapest configuration ... else its lowest offered level"), so such models
   grey earlier than a same-priced non-reasoning model. Intended, and pinned.
3. **`ModelSelectorModal` now subscribes to the billing query stack** whenever
   it is mounted (even closed). No extra network: `useSpendable` /
   `useConversationBudgets` are the same query keys the composer already holds,
   so TanStack Query dedupes. It does mean any test rendering the picker tree
   needs either a `QueryClientProvider` or the module mock (below).
4. **Guest/trial picker greying** rides the shared fixed-1¢ arm; with today's
   catalog rates most models grey for trial users. That is the ruled semantics
   (§Affordability 6), but it is a visible UX shift worth a human eyeballing.
5. **Coverage flake** (§Self-gate): if an auditor's run reports the
   `use-premium-model-click.ts` shortfall, re-run before attributing — the file
   is untouched and git-clean.

## Cross-task side effects (raised)

- Any test that mocks `@/hooks/billing/use-prompt-budget` must now also return
  `useModelFloor` — four existing suites needed it
  (`model-selector-button.test.tsx`, `chat-header.test.tsx`,
  `chat-welcome.test.tsx`, `routes/_app/chat.index.test.tsx`); all were
  otherwise unmodified. Same for `ModelListItemProps`/`ModelListBodyProps`
  fixtures gaining `isBelowFloor`.
- `use-prompt-budget.test.ts` now drives `useUserTierInfo`/`useSpendable`
  through hoisted refs instead of static factories (needed to vary funding per
  test); existing cases are unchanged in behavior.

## Confidence

High — every criterion is pinned by a test that was watched red for the right
reason, the union pin was additionally verified against a re-introduced
intersection regression, and the full web suite + coverage gate, both typecheck
legs, and per-file lint are green after the final edit. Medium only on the
Concerns-1 interpretation, which is a design reading rather than an
implementation risk.
