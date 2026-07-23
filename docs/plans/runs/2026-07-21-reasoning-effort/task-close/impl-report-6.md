# Close item — envUtils conversion of the remaining raw-env integration harnesses

## Objective

Founder-ordered close item: apply the T12 treatment to every remaining raw-env integration harness — replace module-scope raw `process.env['CI']`/`['E2E']` classification sniffing with one `createEnvUtilities()` derivation per harness. Full no-skip conversion only where a deterministic mock exists; envUtils-derived skip where the real dependency has no mock; report structural mismatches instead of forcing the pattern.

## Files changed

- `apps/api/src/slices/models/adapters/integration-setup.ts` — extracted the injectable `deriveCiVitestGate(env, {hasRealKey, hasDatabase})` (one `createEnvUtilities` derivation) and redefined `SHOULD_RUN` through it; updated its comment (consumer is now gateway-metadata, no longer smart-model); demoted `setupRealProvider` + `RealProviderSetup` to module-private (orphaned by the smart-model migration — only `setupIntegrationProvider` uses them now). Bounds note: this file was READ-reference, not a named bounds target — edits are the enabling seam for the required pin test, comment-truth maintenance, and orphan cleanup caused by my own change; recorded as a deviation below.
- `apps/api/src/slices/models/adapters/integration-setup.test.ts` — new `deriveCiVitestGate` pin describe (4 tests).
- `apps/api/src/slices/models/domain/gateway-metadata.integration.test.ts` — deleted the raw `IS_CI`/`IS_E2E`/`HAS_REAL_KEY`/`HAS_DATABASE`/local-`SHOULD_RUN` block (it was a byte-level duplicate of integration-setup's formula — One Implementation, Shared); now imports `SHOULD_RUN` + `processEnvContext` from the harness; `beforeAll` builds `envUtilities` via `processEnvContext()`; docstring rewritten (no longer claims raw-env gating is required). Skip semantics preserved: real-only suite (live catalog has no mock), runs only in CI-vitest with key+db.
- `apps/api/src/platform/roadmap/linear-real.integration.test.ts` — gate was key-*presence*-only (banned env-existence branching, no CI classification at all). Now: one module-scope `AMBIENT_ENV = createEnvUtilities(readEnv())`; `shouldRun = deriveLinearGate(AMBIENT_ENV, HAS_KEY)` where the gate is `isCI && !isE2E && hasKey`; always-run pin describe (4 tests) in the same file; evidence write uses `AMBIENT_ENV.isCI` (the beforeAll re-derivation removed — one derivation per harness). No mock exists for Linear, so the skip stays.
- `apps/api/src/slices/workflows/engine/smart-model.integration.test.ts` — full T12 treatment: migrated off `SHOULD_RUN`/`setupRealProvider` onto `setupIntegrationProvider()`; `describe.skipIf` dropped entirely; teardown via the harness's `teardown()`; docstring rewritten.

## Not changed (structural mismatch with the brief's assumption — reported, not forced)

- `apps/api/src/slices/conversations/adapters/realtime-room-bindings.integration.test.ts` — has NO skip gating and NO raw-env classification branching. Its single `process.env['CI']` hit is a pass-through spread into the `Bindings` env (the app's own envUtils classify inside the pipeline) — the same compliant construction pattern as T12's `processEnvContext()`. Nothing to convert.
- `apps/api/src/smoke/harness.ts` — same situation: fail-fast required-var reads (CODE-RULES-endorsed) + CI/E2E/VITEST pass-through into `Bindings`; no classification branching, no skip. Nothing to convert.

## Judgment on smart-model's no-skip conversion (brief asked for a documented choice)

Dropped the skip. Evidence: the mock provider explicitly supports the classifier call-shape (marker recognition, deterministic resolution to the cheapest candidate) and emits the same billable finish contract as the real adapters (`providerCostUsd` non-zero → settlement bills authoritative `isEstimated:false`, `generationId`, usage tokens ≥ 1) — `mock-provider.ts` documents this as its purpose. Verified by execution: the suite's 2 tests, previously skipped locally, now run against the mock and pass unmodified (both settlement-shape assertions — two charges `answer` + `answer#classifier`, positive base costs, markup math, non-estimated, generation ids — are provider-agnostic). Mock path needs no key/db and structurally writes no evidence (`resolveModelProvider` mock-first early return, already pinned).

## Semantics changes (deliberate, evidence-confinement doctrine)

- linear-real: a LOCAL shell holding `LINEAR_API_KEY_READ` no longer makes a real Linear call (previously it did). Pinned by "refuses a local vitest shell even with the key present".
- linear-real + gateway-metadata: CI-E2E shells refuse via `isE2E` (unchanged for gateway, new-but-moot for linear — the api vitest suite doesn't run in the e2e job).
- smart-model: in CI a missing key/db now FAILS fast (T12's "in CI there is no skip") instead of skipping; previously `SHOULD_RUN` skipped. Identical to the adapter suites' T12 semantics. CI-E2E: would take the real path if the api suite ever ran there (same as adapter suites) — moot today.

## Tests added

- `integration-setup.test.ts` › `deriveCiVitestGate` — 4 behaviors: refuses local shell with key+db; refuses CI-E2E; refuses CI-vitest missing key or db; admits CI-vitest with both. (Criterion: derivation pin per converted harness — covers gateway-metadata's imported gate.)
- `linear-real.integration.test.ts` › `deriveLinearGate` — 4 behaviors: refuses local-with-key; refuses CI-E2E; refuses CI-no-key (skip; `verify:evidence` is the loud guard); admits CI-vitest-with-key. Always-run (outside the skipped describe).
- smart-model's 2 existing tests now execute locally against the mock (were dead-skipped locally before) — the migration's own proof.

## TDD

- `deriveCiVitestGate`: pin tests written first, watched fail (undefined import, 4 failed), then implemented, watched pass.
- `deriveLinearGate`: pin tests written first, watched fail (module-scope ReferenceError), then defined, watched pass.
- smart-model: baseline run showed 2 skipped locally; post-migration run shows 2 passed (bodies unmodified).

## Self-gate (scoped per §Gate-policy-amendment; commands from `apps/api/`)

- `npx vitest run` on all 5 touched files + consumers (3 adapter integration suites, `resolve-model-provider.test.ts`) — **pass**: 7 files passed, 1 skipped (gateway-metadata, correct: real-only), 29 tests passed / 2 skipped (gateway's 1 + linear's real 1). Re-run after the final edit — same result.
- `npx eslint <5 touched files>` — **pass** (exit 0) after the final edit (one prettier wrap auto-fixed mid-stream, then re-verified clean).
- `npx tsc --noEmit -p tsconfig.json` — **pass** (exit 0) after the final edit.
- Coverage: `integration-setup.ts` is coverage-excluded (`apps/api/vitest.config.ts:81`); all other touched files are test files. No coverage surface changed.

## Acceptance criteria

- Every remaining raw-env classification harness converted to one `createEnvUtilities()` derivation — **met** (gateway-metadata via shared `SHOULD_RUN`/`deriveCiVitestGate`; linear-real via `AMBIENT_ENV`; smart-model consumes `setupIntegrationProvider`'s pinned `deriveIntegrationEnv`).
- No mocks invented for mock-less dependencies; skips kept — **met** (gateway-metadata, linear-real keep `describe.skipIf`).
- smart-model migrated off `SHOULD_RUN`, choice documented — **met** (skip dropped; judgment section above).
- Derivation pin test per converted harness — **met** (deriveCiVitestGate pins; deriveLinearGate pins; smart-model rides `deriveIntegrationEnv`'s existing T12 pins).
- Structural mismatches reported, not forced — **met** (realtime-room-bindings, smoke harness).

## Deviations

- Edited `integration-setup.ts` (READ-reference, not a listed bounds target): required to extract the pinnable gate, keep `SHOULD_RUN`'s comment true after smart-model migrated off it, and clean the orphaned `setupRealProvider` export my change created. No behavior change to the adapter suites (verified by their runs).
- No new pin test file for gateway-metadata itself: its gate is the imported `SHOULD_RUN`, whose derivation is pinned in `integration-setup.test.ts` — a second pin would duplicate it.

## Concerns and limitations

- The real-path (CI) branches of all three skipping/real suites cannot be exercised locally by construction; CI-vitest is where they prove out. The gates' refuse-directions are pinned locally.
- Out-of-bounds observations (not touched): `playwright.config.ts` (`!!process.env['CI']`), `e2e/fixtures.ts` (`skipHar = !!process.env['CI']`), `scripts/ensure-stack-cli.ts` (`if (process.env['CI'])`) carry raw-env branching; `scripts/lib/vitest-setup.ts` documents its raw read as deliberate (cannot import `@hushbox/shared`). If the founder's "fix all of them" was meant to reach dev-tooling/e2e configs too, that is a separate pass.

## Confidence

High — every conversion verified by execution locally (RED→GREEN for both new derivations; smart-model's previously-dead bodies now run green under the mock); scoped tests, eslint, and tsc all exit 0 after the final edit; CI-only branches are structurally identical to the already-CI-proven T12 path.
