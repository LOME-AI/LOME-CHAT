# Close item 20 — hard-off wire shape in the language integration suite

## Objective

Add one exchange to `language-adapter.integration.test.ts` sending `reasoning: { enabled: false }` (built via `planReasoningOff`, G1) on a reasoning-capable model, asserting provider-agnostic shape: stream completes with a finish event, non-empty answer text, NO reasoning deltas, `reasoningTokens` 0/absent. Mock satisfies locally; CI records a real cassette on first run.

## Files changed

- `apps/api/src/slices/models/adapters/integration-setup.ts` — added `reasoningOffRequest()` fixture: builds the off wire via `planReasoningOff(reasoningPlanModelFrom(reasoningEffortDescriptor()), REASONING_ANSWER_HEADROOM_TOKENS)` (G1 — no hand-built wire), same stable `REASONING_PROMPT` and `REASONING_MODEL_IDS.effortNative` (`openai/gpt-oss-20b`) for cassette-hash stability; imported `planReasoningOff` from `@hushbox/shared`.
- `apps/api/src/slices/models/adapters/language-adapter.integration.test.ts` — new test `suppresses reasoning under the explicit hard-off wire on a reasoning-capable model`, matching the existing test shape (same describe, `REASONING_TIMEOUT_MS`, `consume`/`finishMetadata` helpers, no skips).

## Tests added

- `suppresses reasoning under the explicit hard-off wire on a reasoning-capable model` — behavior: explicit `{ enabled: false }` wire produces answer + finish with zero reasoning deltas and zero/absent `reasoningTokens` — covers close item 20's criteria. Assertions: `reasoningTextOf(events) === ''`, `answerTextOf(events).length > 0`, `finishMetadata(events)` (asserts terminal finish), `metadata.usage.reasoningTokens ?? 0 === 0`. No `providerCostUsd` assertion — under the local mock cost is present, but the item's criteria are the reasoning-suppression shape.

## RED verification

The mock already implements T16's suppression (`mockReasoningTextFor` returns no thoughts for the off wire), so a naive first run would pass immediately. RED was proven by mutation: fixture temporarily sent the ACTIVE effort wire → the test failed exactly on `expect(reasoningTextOf(events)).toBe('')` with the mock's reasoning text received (1 failed). Reverted to the off wire → green. The assertions demonstrably bite on reasoning leakage.

## Self-gate

- `pnpm vitest run src/slices/models/adapters/language-adapter.integration.test.ts` (from `apps/api`) — pass, 4/4.
- `pnpm vitest run src/slices/models/adapters/integration-setup.test.ts` (harness pin consumer) — pass, 4/4.
- `npx eslint <both touched files>` from `apps/api`, after the final edit — pass, 0 problems (one prettier line-wrap was flagged and fixed, then re-linted clean).
- `pnpm typecheck` (apps/api) — pass.

## Acceptance criteria

- Off wire built via `planReasoningOff` (G1) — met: fixture calls it; infeasible result throws (never hand-assembles `{enabled:false}`).
- Reasoning-capable model, existing `REASONING_MODEL_IDS` — met: effort-native `openai/gpt-oss-20b` via `reasoningEffortDescriptor()` (non-mandatory, so off is feasible).
- Stream completes + finish event — met: `finishMetadata` throws unless the last event is `finish`.
- Non-empty text — met: `answerTextOf(...).length > 0`.
- No reasoning deltas + reasoningTokens 0/absent — met: `reasoningTextOf === ''`, `reasoningTokens ?? 0 === 0`.
- Prompt stable for hash stability — met: reuses the shared `REASONING_PROMPT` constant and headroom constant; only the reasoning wire differs from the active exchanges, so it hashes to its own new cassette.
- Existing test shape, no skips — met: same describe/beforeAll provider, no `skipIf`.

## Deviations

None.

## Concerns and limitations

- The CI record run is the first place the real `gpt-oss-20b` + `{enabled:false}` exchange is exercised (founder-notes item 12's named-watcher applies to this cassette too). If the real model still emits reasoning under the off wire (upstream ignoring `enabled:false`), the test fails loudly in CI — the correct fail direction per G3.
- `integration-setup.ts` and the suite were already Modified pre-task (prior T4/T12/T16 uncommitted work); my diff is only the fixture + import + one test.

## Confidence

High — mutation-verified assertions, full-file green, lint + typecheck clean, fixture is G1-compliant by construction.
