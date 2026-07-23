# Task-sat impl-report-2

## Objective
Two DEV/CI-only saturation-hardening changes, no production behavior change:
1. Widen the non-prod storage PUT retry window (extend the report-1 change: maxRetries 6 → 8).
2. Harden the local Helcim DEV-MOCK webhook self-delivery with a bounded cockatiel retry and
   make final-delivery failure loud instead of silently swallowed.

## Files changed
- `apps/api/src/slices/media/adapters/storage-factory.ts` — `NON_PROD_STORAGE_NETWORK.maxRetries`
  6 → 8 (initialDelayMs:100, maxDelayMs:5000 unchanged); doc comment updated to the ~16s window
  rationale. Production still resolves to `undefined` → storage-r2 `DEFAULT_NETWORK` (unchanged).
- `apps/api/src/slices/media/adapters/storage-factory.test.ts` — assertion updated to
  `maxRetries === 8`; production `undefined` case already covered, left intact.
- `apps/api/src/slices/billing/adapters/payment-mock.ts` — self-`fetch` sign+POST now runs
  through `retryPolicy(...)` from `lib/resilience` (the cockatiel policy factory, not a
  hand-rolled loop or wall-clock sleep). On a persistent failure the mock emits a typed
  `telemetry.error('mock payment webhook self-delivery failed after retries', { errorCode })`
  and records the failure for test determinism; the prior silent-swallow `try/catch` +
  `eslint-disable catch-swallow/no-silent-catch` is removed (the runner surfaces failure as an
  Err handled inline, so `deliverWebhook` never rejects). New optional config: `webhookRetry`
  (retry window override) and `telemetry` (default `createConsoleTelemetry()`).
- `apps/api/src/slices/billing/adapters/payment-mock.test.ts` — added `spyTelemetry()` (vi.fn
  based) + `FAST_RETRY` (instant retries for suite speed); `makeProvider` now injects both;
  two new tests (below).

## Retry values (exact)
- Storage non-prod: `maxRetries: 8, initialDelayMs: 100, maxDelayMs: 5000` (ExponentialBackoff
  100→200→400→800→1600→3200→5000→5000 ≈ 16s window, under the client's ~30s render deadline).
  timeoutMs untouched (60s via DEFAULT_NETWORK spread).
- Billing mock default: `DEFAULT_WEBHOOK_RETRY = { maxRetries: 5, initialDelayMs: 200,
  maxDelayMs: 2000 }` (~5s window). Tests use `FAST_RETRY = { maxRetries: 2, initialDelayMs: 0,
  maxDelayMs: 0 }`. `maxRetries` = retries after the initial attempt (cockatiel maxAttempts),
  so total attempts = maxRetries + 1.

## Billing mock retry/log change (detail)
- Retry wraps ONLY the sign+POST closure; the initial `setTimeout(delayMs)` delay stays outside
  the retry. Retries on any thrown/rejected fetch (`handleAll`) — the diagnosed transient
  broken-pipe/reset. Delivery is idempotent at the receiver (byEventId), so re-posting is safe.
- Loud log: typed `SafeLogFields` (`errorCode` only — no PII, no bodies), compile-time-literal
  `msg`. Fires exactly once, only after retries are exhausted.
- Mock-only: production selects the real Helcim adapter in `payment-provider-factory.ts`
  (untouched); no real-provider path touched.

## Self-gate
- `vitest run storage-factory.test.ts payment-mock.test.ts` — pass (2 files, 35 tests).
- `turbo typecheck lint --filter=@hushbox/api` — pass (2/2 tasks). Two transient lint failures
  during iteration, both fixed at the cause: (a) `@typescript-eslint/only-throw-error` on
  `throw delivery.error` (DomainError is not an Error) → restructured to handle the Err inline,
  no throw; (b) `unicorn/no-useless-undefined` on `() => undefined` spy stubs → switched to
  `vi.fn()`. Final run clean.
- Did NOT run full `pnpm test:api` (DB-heavy; brief directs targeted only). Did NOT run `pnpm e2e`.

## TDD proof
- Storage: updated the assertion to `maxRetries === 8` first, ran RED (`expected 6 to be 8`),
  then changed the constant, ran GREEN (9/9).
- Billing: wrote two tests first — (A) "retries a transient self-delivery failure and delivers
  on a later attempt" (enqueue network-error then 200 → expects 2 requests, 0 failures, 0 logs)
  and (B) "emits a loud log line and records the failure when delivery fails after all retries"
  (no queued responses → expects the loud msg, 1 recorded failure, 3 attempts). Ran RED (A: 1
  request not 2; B: empty errors — both for the expected reason: no retry/log wired). Implemented
  retry + loud log, ran GREEN (26/26). The 24 pre-existing tests stayed green throughout.

## Acceptance criteria
- Storage non-prod window widened to maxRetries:8, prod still `undefined` — MET (unit-pinned).
- Billing mock self-delivery bounded-retried via the policy factory (no hand loop, no sleep) —
  MET (`retryPolicy` from `lib/resilience`, RED→GREEN test A).
- Delivery failure LOUD, not swallowed; typed literal-msg `SafeLogFields`, no PII/bodies — MET
  (test B; the silent-catch + eslint-disable removed).
- Mock-only, idempotent, no production behavior change — MET (real-provider factory path
  untouched; storage prod branch untouched).

## Deviations
- `payment-mock.ts` gained two optional config fields (`webhookRetry`, `telemetry`) — the
  idiomatic in-repo pattern (mirrors the existing `webhookDelayMs`/`fetchImpl`/`executionCtx`
  injection for the same dev/test-determinism reason). Composition-root wiring
  (`payment-provider-factory.ts`) was NOT changed: both fields default sensibly
  (`DEFAULT_WEBHOOK_RETRY`, `createConsoleTelemetry()`), so the local mock hardens with no
  wiring edit and no production surface change. Flagged, not silent.

## Concerns and limitations
- Both changes are validated at the unit layer. End-to-end proof that a real saturation burst is
  ridden out needs the e2e suite under contention (out of scope here; brief forbids `pnpm e2e`).
- The pre-existing `apps/web` `ExecutionContext` tsc error (flagged in the brief) is not mine and
  was not touched; the `@hushbox/api` typecheck is clean.

## Confidence
High — both are minimal, env/mock-scoped, prod-safe changes on idempotent operations, each
proven RED→GREEN with typecheck + lint clean.
