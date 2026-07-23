# Close-batch fix — impl-report-1

## Objective

Fix two validated completeness-critic findings, comment-only edits:

1. Drop the `(T6)` task-ID reference from a comment in `smart-model-execution.test.ts` (Durable Naming violation).
2. Amend the stale "CI-gated" wording in the `integration-setup.ts` coverage-exclusion comment in `apps/api/vitest.config.ts` (suites now run everywhere: mock locally, real in CI). No config values changed.

## Files changed

- `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts` — comment at ~line 716: `canonical-inline-prefixed value (T6).` → `canonical-inline-prefixed value.` (task-ID removed; rest of comment unchanged).
- `apps/api/vitest.config.ts` — exclusion comment for `src/slices/models/adapters/integration-setup.ts`: "imported solely by CI-gated `*.integration.test.ts` suites" → "imported solely by `*.integration.test.ts` suites (mock provider locally, real in CI; never product code)". Exclusion entry itself untouched.

## Tests added

None — comment-only edits; no behavior changed, so no red test exists to write (TDD does not apply to comment text).

## Self-gate

- `npx eslint src/slices/workflows/nodes/smart-model-execution.test.ts vitest.config.ts` (from `apps/api/`, after final edit) — pass; 0 errors. One warning: `vitest.config.ts` is eslint-ignored by the config's ignore patterns (pre-existing, not caused by this change), so it carries no lint gate.
- `npx prettier --check vitest.config.ts` — pass (run because the eslint-ignore means the Prettier-as-ESLint-rule gate does not reach that file).
- `pnpm test:watch apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts` — pass, 39/39 tests.

## Acceptance criteria

1. `(T6)` removed from the test comment — **met** (comment now reads `canonical-inline-prefixed value.`; no other task IDs present in the edited comment).
2. vitest.config.ts comment no longer claims the suites are CI-gated; wording matches run-everywhere reality; config values unchanged — **met** (only the comment lines changed; the `exclude` array entries and all other keys are byte-identical).

## Deviations

None.

## Concerns and limitations

- `apps/api/vitest.config.ts` is outside the package's eslint file set (ignored pattern), so the brief's "eslint on both files" check is structurally a no-op for that file; Prettier was checked directly instead.

## Confidence

High — comment-only edits, both scoped checks green, no config or code semantics touched.
