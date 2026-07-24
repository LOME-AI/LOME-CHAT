# Task 10 — impl report 1

## Summary

One system-prompt builder and one `promptCharacterCount` now exist. The send-path
builder `buildTurnSystemPrompt` (packages/shared/src/prompt/system-prompt.ts) survived;
the preview-only "mirrors the API" copy `buildSystemPrompt`
(packages/shared/src/prompt/build-system-prompt.ts + its test) was **deleted**. A new
shared module `packages/shared/src/prompt/prompt-character-count.ts` exports the ONE
counter (`promptCharacterCount`) and the ONE history reduce (`historyCharacterCount`);
api routes and both web hooks import them. Server admission now counts the built system
prompt (it previously omitted it), so preview and admission measure the identical
prompt — the direction the plan pre-ruled (send content is the truth; estimates only
grew, i.e. over-reserve only).

NEEDS_CONTEXT triggers checked: unifying on send content did NOT change what models
receive (the adapter already used `buildTurnSystemPrompt`; only the preview dropped the
never-sent capability blocks and only estimates moved server-side). The web hook was
measuring the built prompt string (system + history + input). No trigger fired.

## Files changed

- `packages/shared/src/prompt/prompt-character-count.ts` — NEW: `historyCharacterCount`
  + `promptCharacterCount` (UTF-16 code-unit counts, documented).
- `packages/shared/src/prompt/prompt-character-count.test.ts` — NEW unit tests.
- `packages/shared/src/prompt/build-system-prompt.ts` / `.test.ts` — DELETED.
- `packages/shared/src/prompt/index.ts` — barrel swap.
- `packages/shared/src/prompt/system-prompt.ts` — header comment: now the ONE builder.
- `packages/shared/src/prompt/base-preamble.ts` / `.test.ts` — comments/test names no
  longer reference "both builders".
- `apps/api/src/slices/chat/routes.ts` — local `promptCharacterCount` reduce replaced by
  `turnPromptCharacterCount` composing shared builder + shared counter
  (`buildTurnSystemPrompt` + `historyCharacterCount` + `promptCharacterCount`); all 4
  call sites (trial send, paid send, link send, regenerate) updated;
  `trialTurnDefinitionOrRefusal`'s inline body type gained
  `customInstructions?: string | undefined` (the runtime body always carried it; the
  narrow type would otherwise fail TS weak-type assignability).
- `apps/api/src/slices/chat/routes.integration.test.ts` — new test pinning
  `definition.storage.inputChars` === shared counter over the exact adapter prompt;
  the two trial-ceiling tests now derive their expected cap via a `trialOutputCap()`
  oracle over the shared measurement instead of hardcoded 8312.
- `apps/api/src/slices/models/adapters/language-adapter.test.ts` — the parity test (see
  below). No production adapter change was needed (it already used the surviving builder).
- `apps/api/src/slices/chat/domain/turn-definition.ts` — comment-only: `TurnBudget`
  doc said the count was "less the system prompt"; now describes the shared measurement.
  (Disclosed bounds deviation: file not in Task 10's list, but leaving the comment would
  have made it factually wrong.)
- `packages/shared/src/models/premium-check.ts` — comment-only: `@param` example
  referenced the deleted `buildSystemPrompt`. (Same disclosure.)
- `apps/web/src/hooks/billing/use-prompt-budget.ts` — builds via `buildTurnSystemPrompt`
  and measures via shared `promptCharacterCount` (local sum removed; local const renamed
  `promptChars`). `PromptBudgetInput.capabilities` is now unused inside the hook (kept:
  its caller `prompt-input.tsx` is out of bounds — flagged below).
- `apps/web/src/hooks/billing/use-prompt-budget.test.ts` — new measurement tests
  (capability blocks never inflate; custom instructions fold in), switchable
  custom-instructions mock, `buildSystemPrompt` references migrated.
- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — the line-1415 hand reduce is now
  `historyCharacterCount(allMessages)`.

## Parity test (acceptance)

`language-adapter.test.ts` › "preview measurement equals the length of the prompt the
adapter sends (system + instructions + history + input)": runs the real adapter with
history + custom instructions + input against a captured fetch, concatenates every text
part of the wire `messages` (system + history + user), and asserts the shared
`promptCharacterCount({ systemPrompt: buildTurnSystemPrompt(...),
historyCharacters: historyCharacterCount(HISTORY), prompt })` equals `sentText.length`.
Fixtures are ASCII so the UTF-16 code-unit count is also the UTF-8 byte length of the
user-controlled text. **Nuance (named, not silently resolved):** the plan says "byte
length"; the counter (and storage billing) counts UTF-16 code units, and the base
preamble contains em-dashes (3 UTF-8 bytes, 1 code unit), so strict whole-prompt UTF-8
byte parity is unattainable by any counter both sides share — preview === send holds
under the one shared measure, which is the invariant that matters.

## TDD / red-green evidence

- Shared counter: test written first → failed "Cannot find module ./prompt-character-count.js"
  → implemented → 4/4 green.
- Server count: routes integration test written first → failed `expected 572 to be 35`
  (system prompt not counted) → routes edit → green.
- Web hook: measurement test written first → failed (hook still invoked the deleted
  `buildSystemPrompt`, import resolves undefined) → hook unified → 48/48, then 49/49 green.
- Parity test: written after the shared function existed; passed on first run (it pins
  the adapter↔counter relationship; the counter's own red was observed above).

## Grep proof

`grep -rn "reduce((total, message)"` over apps+packages (excl. node_modules/dist/legacy):
only `packages/shared/src/prompt/prompt-character-count.ts` plus ONE remaining
out-of-bounds copy (see Findings). All `promptCharacterCount(` call sites resolve to the
single shared implementation; the api's former local function is gone; the web hooks'
former local sum/reduce are gone.

## Scoped checks (after final edits)

- `pnpm test:shared` — 102 files / **2247 tests all pass**; exit 1 only from a per-file
  branch-coverage shortfall in `src/estimate/smart-model-affordability.ts` (86.02%) —
  file untouched and unmodified in git; not exercised by anything I deleted. Attributed
  to concurrent-run state, not Task 10.
- `pnpm test:api` — full-suite run hit the known coverage-`.tmp` clobber (concurrent
  Vitest runs by sibling tasks share `apps/api/coverage`). Per-file evidence instead:
  `routes.integration.test.ts` 183/185 (the 2 failures — smart-model send/regenerate
  201→402 — **reproduce with the old count semantics** (verified by temporarily
  reverting to `systemPrompt: ''` and re-running), so they are not caused by this task;
  they sit in the models-slice candidate-derivation path T01 is concurrently editing).
  `language-adapter.test.ts` 48/48. `template-html.test.ts` snapshot failures are
  notifications-slice, untouched here.
- `pnpm test:web` — **exit 0**, 364 files / 6011 tests, coverage gate green.
- `eslint` exit 0 on every owned file, run from each package dir after the last edit
  (shared, api, web outputs above in session log).
- `tsgo --noEmit`: shared and web clean; api clean except sibling T07's
  `spendable.integration.test.ts` errors (their file).
- `pnpm arch:check` OK; `pnpm lint:unused` flags only the pre-existing committed
  `packages/config/vitest.package.config.ts` (not mine).

## Findings / follow-ups (for the orchestrator)

1. **One more hand-rolled history reduce exists out of bounds:**
   `apps/api/src/slices/models/domain/trial-eligibility.ts:191` (inside the trial gate's
   `trialMessageBaseNanoUsd` basis). It duplicates `historyCharacterCount` and does NOT
   count the system prompt. It is in the models slice (T01's neighborhood, explicitly
   out of my bounds beyond language-adapter.ts). Plan named only the two reduces I
   collapsed; whether the trial gate should also price the system prompt is unruled.
2. `PromptBudgetInput.capabilities` (use-prompt-budget.ts) is now dead input; removing
   it requires touching `prompt-input.tsx` (out of bounds).
3. Server admission counts grew by the system-prompt length (~490 chars → ~123/245
   tokens by tier): strictly over-reserving, per BILLING §Affordability 8; the two
   trial-ceiling pins were re-derived accordingly.
4. Sibling-attributed failures observed this session (not fixed, per constraints):
   smart-model send/regenerate 402s (models slice), template-html snapshots
   (notifications), shared estimate coverage shortfall, api coverage-tmp clobber under
   concurrent runs, knip's `vitest.package.config.ts`.
