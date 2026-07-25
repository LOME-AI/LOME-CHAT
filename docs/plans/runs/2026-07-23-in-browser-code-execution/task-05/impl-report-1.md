# T5 — System prompt: runnable-documents capability — impl report 1

## Objective

Extend the single shared `buildTurnSystemPrompt` (G6) with a model-facing description of
runnable documents: the four kinds + fence tags, when to emit one, and the runtime
constraints — appended as a new exported constant section, same mechanism as
`BASE_SYSTEM_PREAMBLE`. Scope limited to `packages/shared/src/prompt/**`.

## Files changed

- `packages/shared/src/prompt/base-preamble.ts` — added exported constant
  `RUNNABLE_DOCUMENTS_GUIDANCE` (the capability section text) next to `BASE_SYSTEM_PREAMBLE`.
- `packages/shared/src/prompt/system-prompt.ts` — `buildTurnSystemPrompt` now appends
  `RUNNABLE_DOCUMENTS_GUIDANCE` as a `\n\n`-joined section between the base preamble+date
  and the optional custom-instructions section.
- `packages/shared/src/prompt/prompt-character-count.ts` — doc-comment only: the prompt
  parts enumeration now names the runnable-documents guidance (kept accurate; the counter
  measures `systemPrompt.length` dynamically, so no logic change was needed).
- `packages/shared/src/prompt/base-preamble.test.ts` — new `RUNNABLE_DOCUMENTS_GUIDANCE`
  describe block pinning the load-bearing phrases.
- `packages/shared/src/prompt/system-prompt.test.ts` — replaced the now-obsolete
  "code-execution capability blocks are omitted (deferred capability)" describe (the
  capability ships now) with a "runnable-documents capability section" describe pinning
  presence + ordering; updated the base-only exact-output test to expect
  preamble+date + guidance.

## Tests added / changed

- `names each runnable-document fence tag` — asserts `` `html` ``, `` `js` ``, `` `jsx` ``,
  `` `python` `` present (kinds + tags).
- `biases toward one complete runnable document for visual/interactive asks` — asserts the
  "visual, interactive, or self-contained" trigger and "prefer ONE complete runnable
  document" bias.
- `states the React default-export, no-import, bare-specifier npm rules` — asserts
  "default export", "Do not import React", "bare specifier", "canvas-confetti".
- `describes the Python Run gesture, scientific packages, and auto-install` — asserts
  "presses Run", "matplotlib", "auto-install".
- `pins the runtime constraints a document must respect` — asserts "exactly ONE file",
  "no network at runtime", "`input()`", "visible output".
- `advertises the runnable-documents guidance on every turn` / ordering tests — pin the
  section is present in `buildTurnSystemPrompt` output, after the base preamble and before
  custom instructions.
- Updated base-only exact-output test — the builder's base-only output is now
  `preamble+date` + `\n\n` + guidance.

All map to T5 acceptance: presence + key constraint phrases pinned.

## Self-gate

- `pnpm exec vitest run src/prompt/` (RED before impl) — 9 failed as expected
  (`RUNNABLE_DOCUMENTS_GUIDANCE` undefined). GREEN after — 24 passed / 24.
- `pnpm test:shared` — pass (full package suite + coverage gate green; 1 turbo task
  successful).
- `turbo typecheck lint --filter=@hushbox/shared` — typecheck pass; lint initially flagged
  one prettier line-wrap in the test, autofixed; `eslint` on all five owned files exits 0
  after the last edit.
- `pnpm exec vitest run language-adapter.test.ts` (api prompt consumer) — 47 passed, 1
  failed: `pins the canonical request shape with the base system prompt (cassette
  baseline)` expects hash `38c94f4a2781f374`, now `db959d833936e56f` (deterministic under
  fixed clock, re-confirmed). That test and its pin live in `apps/api` — outside T5 bounds.

## Acceptance criteria

- Unit tests pin presence + key constraint phrases — **met** (see tests above).
- Existing prompt tests (all call sites) stay green — **met for `packages/shared`**; the
  api consumers that compute against the builder dynamically stay green (46/47 in
  language-adapter, all `buildTurnSystemPrompt`-derived assertions). The one api failure is
  a hardcoded canonical-hash pin, not a builder-output assertion — see Deviations/Concerns.
- Token/char delta noted — **met**: the section adds **1130 chars** (1132 including the
  `\n\n` separator), ≈ **283 tokens** (chars/4 heuristic).
- 95% coverage — **met** via `pnpm test:shared` (the scoped `src/prompt/` coverage error is
  an artifact of running only prompt tests; the full package run passes the gate).

## Deviations with reasons

- Rewrote two existing `system-prompt.test.ts` assertions rather than leaving them: the
  "deferred capability" describe and the "no trailing capability sections" base-only test
  asserted the OLD absent-capability state, which this task inverts. Per `docs/DOCUMENTS.md`
  §"The model side" ("Changing document capabilities means changing that prompt text and
  its pinned tests in the same change"), updating them is correct, not scope creep.
- Touched `prompt-character-count.ts` doc-comment (in bounds) to keep the prompt-parts
  enumeration accurate; no logic change.

## Concerns and limitations

- **Cross-task side effect (out of bounds — apps/api):** adding text to the system prompt
  changes the wire request body, so the canonical request hash changed
  `38c94f4a2781f374` → `db959d833936e56f`. This breaks the pinned baseline test in
  `apps/api/src/slices/models/adapters/language-adapter.test.ts` (~line 1188) and
  invalidates every AI-call cassette that embeds the system prompt (chat routes / language
  adapter). The test's own comment already anticipates this ("every previously recorded
  cassette must be re-recorded (out-of-band founder work)"). The orchestrator must
  sequence: update that hash pin to `db959d833936e56f` and re-record the affected
  cassettes. I did not touch it (BOUNDS: `packages/shared/src/prompt/**` only).
- I did not run the full `pnpm test:api` suite: the cassette/hash drift above would surface
  as expected misses across the DB-backed integration suites, all from the same
  out-of-bounds root cause. The isolated unit consumer (language-adapter) confirms the
  impact is exactly the one hash pin plus cassettes.

## Confidence

High — the shared change is a pure additive prompt section, fully TDD'd, all owned-file
gates green; the single api failure is a known, documented, out-of-bounds hash/cassette
drift, not a defect in this task.
