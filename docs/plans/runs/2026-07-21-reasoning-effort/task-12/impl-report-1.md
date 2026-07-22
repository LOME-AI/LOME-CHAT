# T12 — Integration-test local/CI rework + evidence confinement — impl report 1

## Objective

Rework the adapter integration-test harness so the three modality suites (language/image/video) run everywhere with no skips — deterministic mock locally, real + record-on-miss cassettes in CI — with env detection through one `createEnvUtilities()` derivation (`useMock: !envUtils.isCI`), plus a harness-side pin test that the derivation yields the mock outside CI. Evidence stays structurally CI-only. Code-only: the `docs/CI-CASSETTES.md` note is already recorded in plan §Doc-changes (doc-edit hold honored — no `.md` touched).

## Files changed

- `apps/api/src/slices/models/adapters/integration-setup.ts` — replaced module-scope raw `process.env['CI']`/`['E2E']` sniffing with `processEnvContext()` + `deriveIntegrationEnv()` (the one `createEnvUtilities()` derivation, `useMock: !isCI`); added `setupIntegrationProvider(env?)` — mock path (no key/db, no-op teardown) outside CI, `setupRealProvider()` + db-closing teardown inside CI; rewrote the module doc to the new doctrine. `SHOULD_RUN` retained (computed from the same derivation, no raw sniffing) solely for the out-of-ownership `smart-model.integration.test.ts` consumer.
- `apps/api/src/slices/models/adapters/integration-setup.test.ts` — NEW: the harness-side pin (see tests below).
- `apps/api/src/slices/models/adapters/language-adapter.integration.test.ts` — dropped `describe.skipIf(!SHOULD_RUN)`; `setupIntegrationProvider()` + `teardown()` instead of `setupRealProvider()` + `db.$client.end()`; doc comment updated. Assertion bodies unchanged (provider-agnostic per the plan's gating investigation — verified they pass under the mock).
- `apps/api/src/slices/models/adapters/image-adapter.integration.test.ts` — same rework; assertions unchanged.
- `apps/api/src/slices/models/adapters/video-adapter.integration.test.ts` — same rework; assertions unchanged.

`resolve-model-provider.ts` needed no wiring change (its mock path already never records evidence — pinned by the existing "mock path records no evidence" test).

## Tests added

All in `integration-setup.test.ts` (env-injected, so deterministic under both local vitest and CI):

- `deriveIntegrationEnv > yields the mock outside CI (local vitest shell)` — the plan's mandated pin — criterion: derivation yields mock outside CI.
- `deriveIntegrationEnv > yields the mock for an E2E-shaped shell without CI` — closes "today's gap": a CI-shaped/E2E-shaped local shell cannot reach the real evidence-writing path — criterion: evidence structurally CI-only.
- `deriveIntegrationEnv > yields the real path only when CI is set` — criterion: CI = real.
- `setupIntegrationProvider — mock path > resolves the deterministic mock outside CI and its teardown is a no-op` — end-to-end wiring: the resolved provider streams the mock echo; no db/key needed — criterion: local = deterministic mock, no skips.

Plus the three pre-existing suite bodies now RUN locally (previously skipped): 3 tests executed against the mock, all passing unmodified.

TDD: pin test written first; watched fail (4 failed — `deriveIntegrationEnv`/`setupIntegrationProvider` not exported); implemented; watched pass. Suite flips are re-pointing of existing tests; their red was the unresolved import before the harness exports landed.

## Self-gate

- `pnpm test:watch` on the 3 suites + pin test — pass (4 files, 7 tests, 0 skipped) — verified locally the mock path runs with no skips.
- `pnpm test:watch smart-model.integration.test.ts` — pass (skips cleanly locally, 2 skipped, compiles) — the retained `SHOULD_RUN` consumer is unbroken.
- `npx tsc --noEmit` (from `apps/api`) — pass.
- `npx eslint <5 owned files + smart-model.integration.test.ts>` (from `apps/api`, after final edit) — exit 0 (one `unicorn/prevent-abbreviations` error surfaced and fixed: `envUtils` → `envUtilities`).
- `pnpm test:api` (full scoped gate, with coverage) — TESTS PASS, COVERAGE GATE FAILS on a foreign file: 430 files passed | 3 skipped, 5885 tests passed | 4 skipped, 0 failures; exit 1 solely from `ERROR: Coverage for branches (94.73%) does not meet global threshold (95%) for src/slices/workflows/nodes/smart-model-execution.ts`. Attribution: NOT this task — that file and its test carry another workstream's uncommitted diff (`git diff --stat`: smart-model-execution.ts +47/−9, its test +106), it is outside my ownership (workflows slice), none of my changed files appear in its import graph, and my newly-running suites execute only the adapter/mock path (integration-setup.ts is coverage-excluded), so they cannot lower its branch coverage. Raised to the orchestrator; not fixed here (out of ownership).

## Acceptance criteria

- Three suites drop `describe.skipIf(!SHOULD_RUN)` — MET (plain `describe` in all three; 3 tests execute locally).
- Harness replaces module-scope raw `process.env['CI']`/`['E2E']` sniffing with one `createEnvUtilities()` derivation, `useMock: !envUtils.isCI` — MET (`deriveIntegrationEnv` at integration-setup.ts; no raw CI/E2E reads remain — `OPENROUTER_API_KEY`/`DATABASE_URL` reads remain, which are config-value reads for the real path's fail-fast and the retained smart-model gate, not env-mode branching).
- Locally the SAME test bodies run against the deterministic mock — MET (verified pass under mock, zero assertion edits).
- CI: `useMock:false` → real calls with record-on-miss cassettes — MET structurally (`setupIntegrationProvider` real branch delegates to `setupRealProvider`, unchanged factory path: cassette fetch + evidence-once wrapper). Request bodies/models/prompts unchanged, so existing cassette hashes are stable — no re-record needed. Not executable locally; first CI run confirms.
- Evidence confinement pin — MET (`resolve-model-provider.test.ts` "mock path records no evidence" pre-existing + new harness-side derivation pin).
- `docs/CI-CASSETTES.md` doctrine note — NOT DONE BY DESIGN: superseded by the founder ruling in plan §Approval-record (doc-edit hold; note already recorded in §Doc-changes).

## Deviations

- **Retained `SHOULD_RUN` + `setupRealProvider` exports.** `apps/api/src/slices/workflows/engine/smart-model.integration.test.ts` (workflows slice — outside my ownership) imports both; removing them breaks typecheck repo-wide. `SHOULD_RUN` is now computed from the shared `createEnvUtilities` classification (no raw CI/E2E sniffing anywhere), and that suite keeps its previous CI-only skip semantics unchanged. Migrating it to the no-skip doctrine is a separate-ownership follow-up (raised).
- `setupIntegrationProvider` takes an optional injectable `EnvContext` (defaults to the ambient process env) — needed so the pin test can exercise the mock branch deterministically under CI as well.

## Concerns and limitations

- The real branch of `setupIntegrationProvider` is exercised only in CI (integration-setup.ts is already coverage-excluded as test scaffolding — vitest.config.ts exclusion retained; its comment still says "CI-gated `*.integration.test.ts` suites", now slightly stale — vitest.config.ts is outside my ownership, flagged for whoever owns config).
- The module now calls `createEnvUtilities` at module scope (for the smart-model `SHOULD_RUN` gate), which throws if `NODE_ENV` is unset at import; vitest always sets it, and these modules only load under vitest.
- Sibling raw-env harnesses (`gateway-metadata.integration.test.ts`, `linear-real`, `realtime-room-bindings`, `smoke/harness.ts`) untouched per plan's explicit out-of-scope escalation.

## Confidence

High for the local/mock path and the derivation pin (all verified by execution). Medium-high overall: the CI real path is structurally unchanged (same factory, same request bodies) but only a CI run proves the no-skip real execution end-to-end.
