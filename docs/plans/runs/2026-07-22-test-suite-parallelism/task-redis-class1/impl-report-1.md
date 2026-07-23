# impl-report-1 — Task REDIS-CLASS1

## Objective
Add `retry: false` to the 5 test-local dead-Redis `new Redis(...)` constructors that omit
it, so they stop paying the default ~5-retry (~4.3s) backoff. Test-infra change matching an
existing repo convention (`new Redis({ url, token, retry: false })`). No production code, no
TDD-RED step; verification = affected tests stay GREEN and run faster.

## Files changed (path — why)
- `apps/api/src/slices/billing/domain/trial-spend.integration.test.ts` (:26) — dead client gains `retry: false`.
- `apps/api/src/slices/billing/domain/auditors.integration.test.ts` (:202 and :296) — both dead clients gain `retry: false`.
- `apps/api/src/slices/billing/domain/admission.integration.test.ts` (:25) — dead client gains `retry: false`.
- `apps/api/src/slices/chat/domain/trial-settlement.integration.test.ts` (:46) — dead client gains `retry: false`.

Live clients (`new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })`)
in all 4 files were left untouched.

## Diff per site (identical edit, 5 occurrences)
Before: `const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });`
After:  `const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token', retry: false });`

Style matches the convention site `apps/api/src/lib/redis/operations.integration.test.ts:28`:
`new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });`

## Tests added
None. Test-infra change to existing tests; no new behavior. TDD-RED not applicable (brief-scoped).

## Self-gate
- Grep confirm: all 5 `http://localhost:1` dead-Redis constructors across the 4 files now carry `retry: false`; a `grep -v "retry: false"` over dead constructors returns no lines. — pass
- `vitest run` (4 target files, no coverage, via `with-env`): 4 files passed, 54 tests passed — pass (before AND after).
- `turbo typecheck lint --filter=@hushbox/api`: 2 tasks successful (typecheck + lint clean) — pass. The noted pre-existing `apps/api/src/middleware/pipeline-bindings.ts` ExecutionContext error did NOT surface in this run.

## Timing (before vs after)
Same command / same machine / stack warm:
- Before: Duration 9.64s wall (tests 27.57s cumulative across workers).
- After:  Duration 2.90s wall (tests 1.69s cumulative across workers).
- Reclaim: ~6.7s wall; ~25.9s of cumulative in-test retry-backoff eliminated (the dead-Redis
  assertions now fail instantly instead of walking the default ~5-retry backoff).

## Acceptance criteria
- Each of the 5 dead-Redis constructors gains `retry: false` matching convention — MET (grep evidence above).
- Affected test files stay GREEN — MET (54/54 pass, before and after).
- Measure wall-time before/after; redis-down tests much faster — MET (9.64s → 2.90s wall; 27.57s → 1.69s cumulative).
- No other change; no live/real Redis client touched — MET (only the 5 dead constructors changed).

## Deviations
- The brief's exact command `pnpm exec vitest run …` from `apps/api` fails at import (env vars
  DATABASE_URL / UPSTASH_* unset) because it bypasses the env wrapper. Ran the equivalent through
  `pnpm exec tsx scripts/with-env.ts vitest run --root apps/api …` (the project's `test:watch`
  path) after `pnpm ensure-stack`. Same single-file, no-coverage run; behavior unchanged.

## Concerns and limitations
- Timing numbers are single-run wall clock; absolute values vary with machine load, but the
  ~10x cumulative-test-time drop is well outside noise and is the expected backoff removal.

## Confidence
high — trivial, convention-matching one-token edit per site; tests green before and after,
typecheck+lint clean, live clients provably untouched.
