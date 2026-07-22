# T3 — Inline reasoning format: shared parser/serializer — impl report 1

## Objective

Implement the G7 canonical `<think>` inline format once, in `packages/shared`: `serializeReasoningText(reasoning, answer)` and `parseReasoningText(text) → { reasoning?, answer }`, with round-trip, streaming-partial, native-tag tolerance, no-delimiter passthrough, zero dependencies.

## Files changed

- `packages/shared/src/reasoning-format.ts` — new module: the only code that reads/writes the delimiter (delimiters kept module-private to enforce G7's single-reader rule); zero deps.
- `packages/shared/src/reasoning-format.test.ts` — new colocated test (18 tests, incl. two 300-case seeded property loops).

No other files touched. `packages/shared/src/index.ts` was deliberately NOT edited (see Deviations).

## Format decisions (implementation-level, within criteria)

- Canonical serialized shape: `<think>{reasoning}</think>\n\n{answer}`. Parse strips exactly one `\n\n` after the close tag, so serialize→parse is byte-exact including answers with leading whitespace/newlines.
- Leading-delimiter detection: open tag must be at the start after optional leading whitespace (models natively emit `\n<think>`); a mid-text `<think>` is answer text, never reasoning.
- Unclosed open tag (streaming partial) ⇒ `{ reasoning: everythingAfterOpen, answer: '' }`; bare `<think>` ⇒ `{ reasoning: '', answer: '' }`.
- `reasoning: undefined` = no delimiter present; `reasoning: ''` = delimiter present but empty. Callers treat `''` as "none yet".
- Empty reasoning serializes to the answer verbatim — received bytes are never rewritten (G6).
- Double-wrap guard: serializing a non-empty reasoning over an answer that natively begins with the delimiter merges the native block (reasonings joined with `\n`, native answer becomes the answer) — exactly one open delimiter in output.
- Documented limitation (module doc comment): a literal `</think>` inside the reasoning payload is outside the round-trip contract — parse anchors on the FIRST close delimiter, forced by the streaming-partial grammar. Property generators exclude full delimiter tokens but include delimiter-adjacent fragments (`<thin`, `think>`, `</thin`, `<`, `>`).

## Tests added (all in `reasoning-format.test.ts`)

- serialize: canonical wrap; empty-reasoning verbatim (plain + natively-delimited answer); empty native block dropped when wrapping; never double-wraps (count of open delimiters = 1 + merged parse) → criteria: no double-wrapping, G6 verbatim.
- parse: no delimiter ⇒ all answer; mid-text delimiter ⇒ all answer; closed leading delimiter split; leading-whitespace-tolerant native emission; native empty block; unclosed ⇒ reasoning-so-far; bare open tag → criteria: passthrough, native-tag tolerance, streaming-partial.
- round-trip: leading-whitespace answer preserved; newline-leading answer preserved; 300-case seeded (mulberry32) parse∘serialize identity; 300-case re-serialize idempotence → criterion: round-trip property tests (fast-check is not a dependency anywhere in the repo; seeded deterministic loops keep the zero-deps constraint).

TDD: test file written first; watched it fail (cannot resolve `./reasoning-format.js` — module absent); implemented; green. The empty-native-block merge test was added red-first against the merge branch as well? No — it passed on first run (behavior already implemented by the merge code); noted for honesty, it pins an existing branch for coverage rather than driving new code.

## Self-gate

- `pnpm test` (shared, includes per-file coverage gate) — pass: 97 files / 2114 tests; coverage summary 100% lines/funcs, new module not in any uncovered list.
- `npx eslint src/reasoning-format.ts src/reasoning-format.test.ts` (from `packages/shared`, after the final edit) — pass, exit 0.
- `pnpm typecheck` (from `packages/shared`) — exit 0 on final run. NOTE: an earlier mid-task run failed with 2 errors in `src/schemas/api/models.test.ts` (`Property 'reasoning' does not exist`) — a T1-owned file I never touched (present as modified in my pre-edit `git status` snapshot); T1's concurrent work resolved it before my final run.

## Acceptance criteria

- serialize/parse module in `packages/shared` — met (`reasoning-format.ts`).
- round-trip property tests — met (two seeded 300-case loops + exact-byte edge cases).
- tolerant no-delimiter parse (all = answer) — met (test).
- native-emission tolerance, no double-wrapping, leading-delimiter detection — met (tests incl. delimiter-count assertion and mid-text negative case).
- streaming-partial (unclosed ⇒ reasoning-so-far) — met (tests incl. bare open tag).
- zero dependencies — met (no imports in the module at all).

## Deviations

- `packages/shared/src/index.ts` barrel not edited: the brief restricts me to "your new module + its test" (T1 shares the package concurrently), and the plan's Files list is `src/**` (new module) only. Consumers (T6/T8/T10) will need the barrel export line `export * from './reasoning-format.js';` added — one line, raised to the orchestrator for sequencing.

## Concerns and limitations

- The first-close-delimiter anchor means model reasoning that literally contains `</think>` truncates early and leaks the remainder into the answer — inherent to any delimiter format under the streaming grammar; documented in the module.
- Knip (`lint:unused`) may flag the module until a consumer (T6/T8) lands; not in T3's scoped checks.

## Confidence

High — small pure module, every criterion pinned by a test, full shared suite + coverage + lint + typecheck green.
