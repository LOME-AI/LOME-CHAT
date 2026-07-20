# Task-04 — Env-registry "never in production" proof — impl-report-1

## Objective
Pin, via pure additive tests, that `VITE_E2E` carries no value in production (the config-impossibility leg of the threefold proof) and that a production env context yields `isE2E === false` / `isProduction === true` (the named impossibility test). No production code changes.

## Files changed
- `packages/shared/src/env.config.test.ts` — added a `VITE_E2E` describe block (mirrors the existing `VITE_CI` block), placed before `R2_S3_ENDPOINT`.
- `packages/shared/src/env.test.ts` — added one impossibility test inside the existing `isE2E` describe block.

## Tests added
- `VITE_E2E > goes to Frontend only` — asserts `envConfig.VITE_E2E.to` equals `[Destination.Frontend]`. Criterion: mirror VITE_CI shape.
- `VITE_E2E > is only set in e2e environments (never production)` — asserts:
  - `resolveRaw(envConfig.VITE_E2E, Mode.Development)` → `toBeUndefined()`
  - `resolveRaw(envConfig.VITE_E2E, Mode.CiVitest)` → `toBeUndefined()`
  - `resolveRaw(envConfig.VITE_E2E, Mode.E2E)` → `'true'`
  - `resolveRaw(envConfig.VITE_E2E, Mode.CiE2E)` → `'true'`
  - `resolveRaw(envConfig.VITE_E2E, Mode.Production)` → `toBeUndefined()`
  Criterion 1. The `Mode.Production` → undefined assertion is the config-impossibility fact.
- `isE2E > is impossible in production: no E2E key yields isE2E false while isProduction stays true` — `createEnvUtilities({ NODE_ENV: 'production' })` (no E2E key) → `env.isE2E === false` and `env.isProduction === true`. Criterion 2, the named impossibility test. Matches the file's existing `createEnvUtilities({ NODE_ENV: 'production' })` construction pattern.

Registry confirmed at `env.config.ts:511` — `VITE_E2E` declares only `Mode.E2E: 'true'` and `Mode.CiE2E: ref(Mode.E2E)`; no Development/CiVitest/Production keys, so `resolveRaw` returns `undefined` for those. Assertions passed for the intended reason (registry already omits the production key) — no registry change needed or made.

## Self-gate
- `npx tsx ../../scripts/with-env.ts vitest run src/env.config.test.ts src/env.test.ts` (from packages/shared) — pass — 2 files, 139 tests passed.
- `npx eslint src/env.config.test.ts src/env.test.ts` (from packages/shared, after last edit) — pass — exit 0.
- `turbo typecheck --filter=@hushbox/shared` — pass — 1 successful.

## Acceptance criteria
1. VITE_E2E block mirroring VITE_CI with the five resolveRaw assertions — met (evidence above).
2. Production env context impossibility test (isE2E false, isProduction true) — met.
3. Pure test additions; no production code changed; all pre-existing tests still pass — met (139 passed; only additive edits, no existing test case altered).

## Deviations
None.

## Concerns and limitations
None. These are additive registry-fact assertions; they passed on first run because the fact already holds.

## Confidence
high — small, isolated, additive test edits; all three scoped gates green.
