# Task-41 — close the per-request Neon pool at end of request

## Objective

The hot request path creates a per-request Neon pool (`pipeline-bindings.ts` via
`createRequestDb`) but never closes it, unlike every DO path which calls
`await db.$client.end()`. Each query-bearing request leaks a wsproxy WebSocket until
idle GC, making the single Neon wsproxy a chokepoint at 12 workers. Close the pool at
end of request, parity with the DO paths, without ever closing mid-use.

## Files changed

- `apps/api/src/middleware/pipeline-bindings.ts` — capture the created `db` in a local,
  wrap `await next()` in `try/finally`, and in the finally register the pool close:
  `c.executionCtx.waitUntil(db.$client.end())` when an ExecutionContext exists, else
  `await db.$client.end()` inline (vitest `app.request` has no ExecutionContext — its
  getter throws, so it is read defensively in a try/catch). One teardown per request →
  closed exactly once.
- `apps/api/src/middleware/pipeline-bindings.test.ts` — added a `request-db teardown`
  describe with 3 tests; updated the existing Sentry-flush-seam test's waitUntil count
  from 1 to 2 (the pool close is now also registered on waitUntil alongside the flush).

## Tests added

- `registers the per-request Neon pool close on executionCtx.waitUntil after the
  response` — with a spy `end` and a fake ExecutionContext, asserts response is 200 with
  intact body (not closed mid-use), `end` called exactly once, and exactly one waitUntil
  task registered (non-blocking). Covers criterion 1 (waitUntil registration, close once)
  and criterion 2 (response intact / no premature close).
- `closes the per-request Neon pool inline when no ExecutionContext exists` — the vitest
  `app.request` path (no ctx): asserts 200, intact body, `end` called once. Covers the
  fallback branch + criterion 4 (normal request still succeeds).
- `closes the per-request Neon pool even when a downstream handler throws` — handler
  throws, `onError` returns 500; asserts `end` still called once. Proves the `finally`
  teardown (no leak on the error path).

## Self-gate

- `npx eslint src/middleware/pipeline-bindings.ts src/middleware/pipeline-bindings.test.ts`
  (from apps/api) — pass, exit 0.
- `npx prettier --check` on both edited files (from apps/api) — pass, "All matched files
  use Prettier code style!".
- `pnpm typecheck` (apps/api, tsgo --noEmit) — pass, exit 0.
- `pnpm test:watch src/middleware/pipeline-bindings.test.ts` — 10/10 pass.
- `pnpm test:watch src/middleware/` (full middleware suite, coverage-free) — 18 files,
  228 tests pass.
- `pnpm test:api` / `npx turbo test --filter=@hushbox/api --force` (the coverage gate) —
  did NOT complete: every attempt (3x) died on an `Unhandled Rejection` from the V8
  coverage provider: `Something removed the coverage directory ".../coverage/.tmp" ...
  Make sure you are not running multiple Vitests with the same coverage.reportsDirectory
  at the same time.` No test assertion failed — the listed test files all show ✓; the
  process exits non-zero on the coverage-infra race, not on a test. This is the documented
  concurrent-Vitest / coverage-timing flake (another agent is running Vitest against the
  same shared `coverage.reportsDirectory` in this checkout). It is environmental, outside
  my file ownership, and unrelated to this change (the collision surfaces in unrelated
  slices' coverage tmp files, e.g. `coverage-0.json`, `coverage-102.json`).

## RED → GREEN evidence

- RED: with the 3 new tests and no implementation, `end` was called 0 times —
  `expected "end" to be called 1 times, but got 0 times` (3 failures), and the waitUntil
  test failed on `tasks` length. Confirmed no close is registered today.
- GREEN: after implementing the finally-teardown, 10/10 in the file pass; full middleware
  suite 228/228.

## Acceptance criteria

1. **Pool closed after response, once, mirroring DO paths** — MET. `finally` registers
   `executionCtx.waitUntil(db.$client.end())` (or inline await when no ctx). Single
   teardown per request → exactly once; the throw-path test proves close-once even on
   error, no double-close.
2. **CORRECTNESS: close only after the response/stream is done, never mid-use** — MET.
   Verified all request-path handlers return buffered `c.json(...)` — `grep` for
   `streamSSE`/`stream(`/`ReadableStream`/`c.body(` across all `routes.ts` found none;
   chat's `routes.ts` returns `c.json` everywhere and its own comment states the DO "owns
   the referee claim, deadline, streaming" (streaming runs in the ConversationRoom DO on
   its OWN db, not the request pool). So after `await next()` nothing in flight uses the
   request pool. `waitUntil` also holds the isolate alive so the close cannot be torn down
   early. Test asserts the response body is fully readable after teardown.
3. **No behavior change beyond cleanup; DO paths & createRequestDb untouched** — MET. Only
   `pipeline-bindings.ts` changed; `createRequestDb` semantics unchanged (same call, now
   captured in a local); no DO binding files touched.
4. **TDD, watch-fail-first** — MET. See RED→GREEN above.

## Deviations

- Updated one pre-existing test in my owned test file (Sentry flush seam: waitUntil count
  1 → 2). The pool close is now legitimately a second waitUntil task in that scenario;
  the assertion was strengthened with a comment explaining a probe WITHOUT captureError
  registers only the pool close (1 task), so the extra task still proves the defect rode
  onto waitUntil. Test intent preserved.

## Concerns and limitations

- The authoritative coverage gate (`pnpm test:api`) could not be observed green due to a
  concurrent-Vitest coverage-dir collision in this shared checkout (another agent running
  Vitest). No test assertion failed; correctness is proven by the coverage-free middleware
  suite (228/228) + typecheck/eslint/prettier clean. Re-run `pnpm test:api` when no other
  Vitest is running against this checkout to observe the coverage gate green.

## Confidence

High — the change is a minimal, DO-parity teardown; streaming-safety verified by source
inspection (no request-path streaming from the request pool); RED→GREEN clean; lint,
prettier, typecheck, and the full middleware suite green. The only unobserved gate is
blocked by an environmental coverage-dir race, not by this code.
