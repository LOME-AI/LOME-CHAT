# T18 — R22 gap-completion — impl report 2

Closes the two acknowledged gaps from `impl-report-1.md` under the plan's §"T18 scope
expansion". Report-1 stands for sub-items (a)-partial, (b), (c)-partial, (d), (e); this
report covers only the two closures. **R22.a is now complete AT RUNTIME** —
default-on-under-dev-server, not merely per-request-overridable.

## GAP (a) — dev-delay auto-default wired at runtime

### Wiring (composition seam)
`isDevServer` (from `createEnvUtilities(env).isDevServer` — G3, never a raw env check) now
threads end-to-end so the 60/3000/1000ms text/media/classifier defaults apply BY DEFAULT
only on a real dev server; E2E/vitest/CI/production stay delay-free; per-request directives
still win:

- `apps/api/src/slices/chat/conversation-runtime.ts` — the composer passes
  `isDevServer: envUtilities.isDevServer` into `createConversationRuntime`.
- `apps/api/src/slices/chat/domain/runtime.ts` — `ConversationRuntimeDeps` gains
  `readonly isDevServer?: boolean`; `providerFor` forwards it to `resolveModelProvider`
  (`...(deps.isDevServer === undefined ? {} : { isDevServer: deps.isDevServer })`). This file
  is the connective seam (its `providerFor` is what actually calls `resolveModelProvider`);
  it is owned by no other task (verified against plan task Files + dependency graph).
- `apps/api/src/slices/models/adapters/resolve-model-provider.ts` — `ResolveModelProviderInput`
  gains `readonly isDevServer?: boolean`; passed as the 3rd arg to `createMockModelProvider`
  (which already applies the isDevServer-gated defaults, from report-1). Omitted ⇒ false.

Full chain: composer envUtils.isDevServer → `ConversationRuntimeDeps.isDevServer` →
`providerFor` → `resolveModelProvider` input → `createMockModelProvider(…, isDevServer)` →
`resolveMockDelays(directives, isDevServer)`.

### Tests (RED→GREEN, both branches)
- `apps/api/src/slices/models/adapters/resolve-model-provider.test.ts` (models-slice seam):
  `applies the default text delay (no directive) ONLY when isDevServer is true` (fake timers:
  echo cannot settle until timers advance) and `streams instantly under the E2E/vitest branch
  (isDevServer false, no advance)`. **RED verified**: temporarily reverted the `input.isDevServer`
  arg → the default-ON test failed (`settled` true immediately, no delay); restored → GREEN.
- `apps/api/src/slices/chat/domain/runtime.test.ts` (runtime seam): `threads deps.isDevServer
  so the mock applies default delays ONLY on a dev server` — `providerFor({…isDevServer:true}, {})`
  parks on the 60ms default; `providerFor({…}, {})` (isDevServer omitted) settles instantly.
  This proves the runtime-side thread; conversation-runtime's one-liner is covered by
  typecheck + every `conversation-runtime.test.ts` build test.

## GAP (c) — fence left every echo consumer green

### Survey (comprehensive, apps/api + e2e)
Searched: assertion lines mentioning `Echo` with `toBe`/`toEqual`/`toStrictEqual`/`toContain`/
`toMatch`/`startsWith`/`includes`/`===`; echo-content helper names (`expectedEcho`, `echoContent`,
`MOCK_ECHO`, `buildEcho`, `echoOf`); literal `'Echo:'`/`` `Echo:` ``/`"Echo:"` strings
(catches variable-built expecteds, since every exact echo begins `Echo:`); e2e exact assertions
(`toBe`/`toHaveText`/`toContainText`/`=== 'Echo`).

Full list checked and disposition:
- `apps/api/.../regenerate.integration.test.ts:383` — `toBe('Echo:\nfirst prompt')` — **the only
  breaker; FIXED** (see below).
- `apps/api/.../resolve-model-provider.test.ts:149,166` — my new seam tests, `toContain('Echo:')`
  — fence-tolerant, SAFE.
- `apps/api/.../mock-provider.test.ts` — updated in report-1 to include the fence (via `echoOf`),
  SAFE.
- `apps/api/.../workflows/engine/interpreter.test.ts:1479,1506,724…852` — `streamingEcho()`,
  an interpreter `modelCall` test double (workflow-engine test helper), UNRELATED to the mock
  provider's `Echo:` content — a different code path; the fence is only in mock-provider's
  `echoStream`. SAFE.
- e2e — `group/realtime.spec.ts:64` (`getByText('Echo:')`), `chat/multi-model.spec.ts:509`
  (`hasText: 'Echo:'`), `pages/chat.page.ts` (`/^Echo:/`), plus comments — all substring/regex-
  prefix, SAFE with the appended fence. (Hits in `e2e/report/**/report.json` are old run
  artifacts, not test code.)

Conclusion: exactly one exact-echo consumer, now fixed.

### Fix
`apps/api/src/slices/chat/domain/regenerate.integration.test.ts:383` — updated to the full
current mock output, preserving the file's `.toBe` strictness (so the whole regenerated content
still round-trips through settlement):
`toBe('Echo:\nfirst prompt\n\n\`\`\`json\n{\n  "ok": true\n}\n\`\`\`')`, with a comment noting the
fence. (Did not import `MOCK_ECHO_JSON_FENCE` — that would cross the models→chat slice boundary;
inlined instead, which is appropriate for a fixture-output assertion.)

## Self-gate (scoped, coverage-free — full-coverage `test:api` OOMs, avoided per plan)
- `resolve-model-provider.test.ts` — pass (9); RED→GREEN of the seam test verified by revert.
- `runtime.test.ts` — pass (46, incl. the providerFor seam test).
- `regenerate.integration.test.ts` — pass (2). (Local stack had been reaped mid-session; restored
  via `pnpm db:up` + `pnpm db:migrate`, then GREEN — the earlier "fetch failed / model_catalog"
  error was infra-down, not the assertion.)
- adapters suite (`.../models/adapters`) — pass (16 files, 280 passed / 3 integration skipped).
- ESLint (from `apps/api`, after last edit) on all 6 touched files — exit 0.
- `pnpm --filter @hushbox/api typecheck` — exit 0.
- Scoped per-file coverage (`resolve-model-provider.ts`, `runtime.ts`, `conversation-runtime.ts`)
  with their full test sets incl. `runtime.integration.test.ts` — 90 passed, **0 threshold
  violations** (all three ≥95%). Note: a run excluding `runtime.integration.test.ts` reported
  runtime.ts at 73.84% — that is the DO/executor paths the integration test covers (lines
  ~590-596, 820-829), NOT my `providerFor` change, which the unit `providerFor` seam test covers
  on both branches.

## Files changed
- `apps/api/src/slices/chat/conversation-runtime.ts` — pass `isDevServer` from envUtils.
- `apps/api/src/slices/chat/domain/runtime.ts` — `ConversationRuntimeDeps.isDevServer` + `providerFor` thread (connective; unowned).
- `apps/api/src/slices/chat/domain/runtime.test.ts` — providerFor seam test (connective; unowned).
- `apps/api/src/slices/models/adapters/resolve-model-provider.ts` — input `isDevServer`, threaded to `createMockModelProvider`.
- `apps/api/src/slices/models/adapters/resolve-model-provider.test.ts` — both-branches seam test.
- `apps/api/src/slices/chat/domain/regenerate.integration.test.ts` — fence-aware assertion.

## Deviations (RAISED)
- Edited `runtime.ts` + `runtime.test.ts` — the connective seam whose `providerFor` calls
  `resolveModelProvider`; named neither in the original T18 list nor the scope-expansion note,
  but structurally required to wire GAP (a) at runtime. Confirmed unowned by any other task.
  Changes are minimal (one optional field + one spread + one isolated test).

## Confidence
High. R22.a is complete at runtime (default-on-under-dev-server, off everywhere automated,
per-request override intact), proven at both the models-slice and runtime composition seams
with RED→GREEN evidence. R22.c: the fence leaves every surveyed echo consumer green; the sole
breaker is fixed and passing. Lint, typecheck, and per-file coverage all pass.
