# Task-33 impl-report-1

## Objective
Repair the in-test redis mock in `apps/api/src/slices/chat/domain/runtime.test.ts` so the
two admission unit tests pass again. Task-32 moved the wallet-snapshot balance read from the
Lua script into TypeScript: `admitRun` → `resolveSnapshot` → `readRedisSnapshot` now calls
`redis.get<StoredSnapshot>(<walletSnapshot key>)`. The test's two redis mocks predate that
change and only stubbed `createScript`, so both admission tests threw
`redis.get is not a function`. This is a test-mock gap, not a logic bug; no production code
was touched.

## Files changed
- `apps/api/src/slices/chat/domain/runtime.test.ts` — added a `.get` method to the two
  admission redis mocks (`rejectingRedis`, `grantingRedis`) so they satisfy the new
  TS-side snapshot read the admission path performs before invoking the Lua script.

## What the mocks now return (and why it preserves each test's original intent)
- `rejectingRedis.get` → `Promise.reject(new Error('redis down'))`. Test "maps Redis-down
  admission failure to ADMISSION_UNAVAILABLE" (runtime.test.ts:474). Intent: Redis is fully
  down and admission fails closed. Previously the script `exec` rejection produced the
  fail-closed error; now the snapshot `get` is reached first, so it must also reject to keep
  the same fail-closed outcome. `readRedisSnapshot` wraps the rejection in `redisFailure`
  (`unavailableError`), the runtime maps it to `ADMISSION_UNAVAILABLE`. Assertion unchanged
  and still exercises the fail-closed path — now at the read seam, which is where the failure
  first surfaces in production too.
- `grantingRedis.get` → `Promise.resolve({ balanceNanoUsd: '1000000000', ledgerSeq: 1,
  type: 'purchased' })`. Test "carries the wallet-hold identity on the admission grant"
  (runtime.test.ts:515). Intent: admission grants and returns the hold readout. Returning a
  non-null `StoredSnapshot` makes `resolveSnapshot` use the advisory snapshot directly and
  skip the Postgres `bootstrapSnapshot` path (the test's `noMemberDb` does not stub
  `readWalletSnapshot`). `type: 'purchased'` yields a paid-tier spendable that is passed as a
  script arg only; the granting `createScript.exec` returns `'admitted'` regardless, so the
  grant outcome and the asserted hold identity (`{ walletId: 'w1', holdId: 'run-1',
  scopeIds: [] }`) are unchanged.

`StoredSnapshot` shape confirmed from `apps/api/src/slices/billing/domain/admission.ts`
(`balanceNanoUsd: string`, `ledgerSeq: number`, `type?: WalletType`); `WalletType =
'purchased' | 'free'` from `apps/api/src/slices/billing/ports/stores.ts:20`.

## Tests
No tests added — the two tests already existed, already failed for the right reason
(`redis.get is not a function`, verified before the edit), and the fix supplies the data the
new code reads without weakening either assertion.

## Self-gate
- `vitest run src/slices/chat/domain/runtime.test.ts` — pass — 45/45 (the 2 previously
  failing now green, none newly broken).
- `vitest run src/slices/chat/domain/runtime.integration.test.ts` (via
  `scripts/with-env.ts`, local stack) — pass — 29/29, no regression. (Run without the env
  wrapper it fails at collection with "DATABASE_URL is required" — an env requirement, not a
  code failure.)
- `eslint src/slices/chat/domain/runtime.test.ts` (from `apps/api`) — pass — exit 0, no
  output, run after the last edit.

## Acceptance criteria
- Two previously-failing admission unit tests pass — met (45/45).
- No production/logic files changed (admission.ts, admission-scripts.ts, runtime.ts
  untouched) — met; only the test file's mocks changed.
- No new test breakage in the file or the integration sibling — met.

## Deviations
None.

## Concerns and limitations
None. The mock now mirrors the real Upstash contract (`get<T>` returns the auto-JSON-parsed
object or null), so it stays faithful to the production read path.

## Confidence
high — the failure and fix are mechanical and directly verified; both suites green and
lint clean.
