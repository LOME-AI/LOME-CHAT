# impl-report-3 — Close batch: docs, disclosure label, wire-params deletion

## Objective

Founder-approved close batch: (1) five doc integrations (cassette doctrine, reserve
clause, store-raw doctrine, web render rule, two ARCHITECTURE clauses); (2) disclosure
label "Thoughts" → "Reasoning" (token count kept); (3) delete dead `compileWireParams`
artifacts.

## Files changed

- `docs/CI-CASSETTES.md` — CI-only cassette doctrine added to intro; Recording section's
  "and locally (with a real OPENROUTER_API_KEY)" replaced with CI-only + no-local-path
  language (the dedupe). Prettier also re-padded the single-seam table (formatting only).
- `docs/BILLING.md` — admission step 2 gains the effort-aware output ceiling
  (thinking budget + answer cap through the existing output line item) + classifier
  reserve condition (Smart Model ∨ effort=auto).
- `apps/api/CLAUDE.md` — new "Store raw, parse on demand" section (canonical inline
  format owned by `packages/shared/src/reasoning-format.ts`; history replay strips both
  sources at `prepareStartRequest`; node values carry serialized form, consumers parse
  `.answer`).
- `apps/web/CLAUDE.md` — one UI-conventions bullet: always render assistant text via the
  shared parser; never literal think-delimiters or raw unparsed text.
- `docs/ARCHITECTURE.md` — §Models & capabilities: reasoning metadata rides the catalog
  snapshot, effort control derives positionally. §Data model essentials: assistant text
  verbatim, reasoning inline parsed on demand, counts on `llm_completions.reasoningTokens`.
  NOTE: `prettier --write` (needed to pass the doc gate) also normalized one
  pre-existing non-conformant line I did not author (the cost-circuit bullet's
  "step cost`" continuation indent) — content unchanged, whitespace only.
- `apps/web/src/components/chat/message/thinking-disclosure.tsx` — label word
  "Thoughts" → "Reasoning" in both the settled-no-count and settled-with-count branches;
  "Thinking…" streaming label and "Reasoned privately" line untouched (neither used
  "Thoughts").
- `apps/web/src/components/chat/message/thinking-disclosure.test.tsx` — three label
  expectations updated (TDD red first).
- `apps/api/src/slices/models/domain/wire-params.ts` — DELETED (dead: no consumer
  outside barrels + own test).
- `apps/api/src/slices/models/domain/wire-params.test.ts` — DELETED.
- `apps/api/src/slices/models/domain/index.ts` — removed `compileWireParams`,
  `resolveMediaInputs`, `WireParams` exports.
- `apps/api/src/slices/models/index.ts` — removed the same three re-exports.

## Tests added

No new tests. Three existing tests updated (label change is a copy change on pinned
behavior): "labels the button \"Reasoning\" once the answer starts streaming" /
"…when settled without a token count" / "derives the settled label from the reasoning
token count when known" — each covers the Part-2 criterion (word change, count shape
kept). TDD: expectations changed first, watched 3/23 fail with
`Expected: Reasoning… Received: Thoughts…`, then the two-line component edit → 23/23.

## Deletion evidence (Part 3)

Repo-wide grep for `compileWireParams`, `resolveMediaInputs`, `WireParams`,
`wire-params` before deletion: only `wire-params.ts`, its test, and the two models-slice
barrels (plus stale `apps/api/dist/` build output). Zero live consumers → deleted whole
file (`resolveMediaInputs`/`WireParams` were equally dead — only reachable via the same
file). `compileParamSpec` (ParamSpec machinery, stays per brief) retains a live
consumer: `apps/api/src/slices/workflows/nodes/model-call-execution.ts`. Post-deletion
grep: zero references in `src/`. `apps/api` tsc clean confirms no type-level consumer.

## Self-gate

- `npx vitest run src/components/chat/message/thinking-disclosure.test.tsx --sequence.concurrent=false` (apps/web) — pass, 23/23.
- `npx eslint` + `npx prettier --check` on both touched web files (from apps/web, after final edit) — pass.
- `npx eslint` + `npx prettier --check` on both api barrels (from apps/api, after final edit) — pass.
- `npx prettier` on all five doc files — pass after `--write` on CI-CASSETTES.md +
  ARCHITECTURE.md (both had pre-existing non-conformant regions prettier normalized).
- `npx tsc --noEmit` (apps/api) — pass, 0 errors.
- `npx tsc --noEmit` (apps/web) — 2 errors, BOTH the recorded foreign failures from
  plan §Known-foreign-failures: `../api/src/middleware/pipeline-bindings.ts(59,29)`
  ExecutionContext, and `src/components/chat/model-selector/model-list-body.test.tsx(41,5)`.
  Neither file touched by this task (git status confirms). Attributed foreign, not fixed.
- Scoped api tests for wire-params consumers: none exist — the only referencing test
  was the deleted `wire-params.test.ts`; nothing to run.

## Acceptance criteria

- CI-CASSETTES doctrine + local-language dedupe — met (diff above; "local" now appears
  only inside the doctrine/no-local-path sentences).
- BILLING reserve clause — met (integrated into admission step 2, adjacent to the
  existing reserve≥charge material).
- api CLAUDE.md store-raw entry — met (compact 3-bullet section).
- web CLAUDE.md render rule — met (one bullet).
- ARCHITECTURE two clauses — met (one clause each section, dense).
- Label "Reasoning (N tokens)" shape kept; streaming + private-state lines unchanged — met (test-pinned).
- wire-params deleted, barrels cleaned, nothing live imported it — met (grep + tsc evidence).

## Deviations

- Prettier `--write` introduced a whitespace-only normalization of one pre-existing
  ARCHITECTURE.md line and the CI-CASSETTES.md table padding — unavoidable to pass the
  mandated prettier gate on those files; no content change.

## Concerns and limitations

- `resolveMediaInputs` + `WireParams` went down with the file; if any planned future
  consumer expected them, they're in git history. Grep proved them currently dead.
- Doc claims (reasoning-format ownership, prepareStartRequest seam, reasoningTokens
  column) are transcribed from the founder-approved brief text, not re-verified against
  every source file; `parseReasoningText`/`serializeReasoningText` usage in the
  disclosure component/test corroborates the shared-module claim.

## Confidence

high — all checks green or attributed-foreign; deletion proven dead by grep + clean
api typecheck; label change TDD'd.
