# impl-report-1 — Task REDIS-CLASS2

## Objective
Replace the real-dead-Redis-client (`DEAD_ENV` dead-URL) approach in the 9 "Redis
unavailability fails closed" tests (`identity/routes.integration.test.ts:1024`) with a
reject-all fake redis injected at the existing `c.var.redis` seam, so each handler's own
fail-closed path is exercised without paying the Upstash retry/backoff (~4.3s each; four
tests carried 40_000ms timeouts). TEST-ONLY, no production change.

## Files changed
- `apps/api/src/slices/identity/routes.integration.test.ts` — reworked the
  `identity routes: Redis unavailability fails closed` describe block: replaced `DEAD_ENV`
  with a `DEAD_REDIS` Proxy whose every property access returns a call that rejects; inject
  it via `app.use('*', c=>c.set('redis', DEAD_REDIS))` after `applyPipeline` in `deadApp()`;
  `postDead` now passes `testEnv` (real infra) instead of the dead-URL `DEAD_ENV`; removed
  the four `40_000` per-test timeout args (backoff is gone). `DEAD_ENV` removed as dead code.

## Design (as built)
- `DEAD_REDIS = new Proxy({}, { get: () => (): Promise<never> => Promise.reject(...) }) as unknown as Redis`.
  Total by construction: any op a handler reaches (get/getdel/mget/set/setnx/incr/expire/
  ttl/eval/del, or anything else) resolves to a rejecting function, so no un-stubbed op can
  slip past the 503 path. The redis-op wrappers (`apps/api/src/lib/redis/operations.ts:14`)
  translate the rejected client promise into `errAsync(unavailableError())` → routes map to
  503 `{code: UNAVAILABLE}`.
- The override middleware is registered after `applyPipeline` (so it runs after the pipeline
  stages) and before `app.route` (so it runs before handlers). The pipeline's session stage
  is composed WITHOUT a revocation option here, so it never touches redis; the first redis
  touch is the handler's own — matching the pre-existing intent documented in the block.
- Pattern mirrors `apps/api/src/middleware/rate-limit.test.ts:93` (`c.set('redis', … as unknown as Redis)`).
  No new pattern, no production surface.

## Tests added
None — this is a refactor of 9 existing tests; names and terminal assertions
(503 + `{code: UNAVAILABLE}`) are unchanged.

## Self-gate
- `vitest run … -t "Redis unavailability fails closed"` — **pass**, 9 passed / 149 skipped.
  Block test time **88.38s → 10.45s** (wall 91.36s → 13.35s); the ~4.3s×N backoff and the
  four 40s timeouts are gone. Remaining ~10s is OPAQUE/argon2id setup, not redis.
- `turbo typecheck --filter=@hushbox/api` — **pass**.
- `eslint src/slices/identity/routes.integration.test.ts` — **pass** (one initial
  prettier/prettier formatting error on the arrow chain, fixed by collapsing to one line;
  no rule disabled).
- Full file `vitest run … routes.integration.test.ts` — **158 passed (158)** after clearing
  one pre-existing orphan `users.email = ''` row (see Concerns).

## Correctness verification (the key audit hazard: passing for the wrong reason)
Flipped `DEAD_REDIS` to RESOLVE-all (`Promise.resolve(undefined as never)`) and re-ran the
block: **all 9 tests FAILED** (e.g. got 429 instead of 503 at `expectUnavailable`). This
proves every one of the 9 asserts 503 *because* redis rejected — each handler actually
reaches redis; when redis stops rejecting, the 503 disappears. Reverted to the rejecting
form (final state).

## Acceptance criteria
- 9 tests stay GREEN asserting 503 + `{code: UNAVAILABLE}` — **met** (9 passed).
- For the RIGHT reason (every op rejects; no route skips redis) — **met** (resolve-all
  adversarial run breaks all 9; Proxy is total over property access).
- Other tests in the file unaffected — **met** (full file 158/158 after clearing a
  pre-existing orphan row unrelated to this change; see Concerns).
- The 9 tests run fast (no backoff / 40s) — **met** (88.4s → 10.5s).
- typecheck + lint clean — **met**.
- Doc-comment noting the Upstash transport is intentionally not exercised — **met** (added
  to the `DEAD_REDIS` doc-comment).
- File ownership respected (only `identity/routes.integration.test.ts`) — **met**.

## Deviations
None.

## Concerns and limitations (out of scope — RAISED)
- Pre-existing test-isolation defect, independent of this change: two tests write
  `users.email = ''` — `:1380` ("disables TOTP … when the account has no email", restores in
  a `finally`) and `:3263` ("does not gate an account with no email (guest-origin)", NO
  restore). `email = ''` is globally unique (`users_email_unique`); a run that ends with the
  slot occupied (3263 leaves it set) poisons the next run, and there is no per-test cleanup
  (only a file-level `afterAll` deleting `username LIKE PREFIX%`). On the full-file run this
  surfaced as 2 failures (23505 at `:3263`). **Attribution: reproduced by running ONLY those
  two tests (`-t "account has no email|does not gate an account with no email"`) with none of
  my touched code executing — same 23505 collision.** I cleared one orphan `email=''` row via
  the Dockerized Postgres to get a clean 158/158 full-file run; I did NOT modify those tests
  (outside my ownership). This is the flaky-red class the plan already tracks; flagging for
  the orchestrator.

## Confidence
high — 9 tests green and ~8× faster; adversarial resolve-all run proves right-reason;
typecheck + lint clean; full file 158/158; the only failures are a proven pre-existing,
out-of-ownership DB-isolation issue.
