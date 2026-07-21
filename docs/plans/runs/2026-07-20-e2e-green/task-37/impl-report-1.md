# Task-37 — mock payment webhook lifetime-safe delivery — impl-report-1

## Objective

In local/E2E, an approved mock charge returns `awaiting_webhook`; the wallet is credited
only by the mock's self-delivered confirming `cardTransaction` webhook. The mock scheduled
that delivery as a DETACHED floating promise (`scheduleWebhook` → `setTimeout` → `fetch`,
added to an in-memory `pendingDeliveries` Set), never registered with `executionCtx.waitUntil`.
In workerd/wrangler the request context ends when `/billing/payments` returns, so the delayed
delivery is abandoned → webhook never fires → balance never credited → frontend polls forever
("Processing payment…"). Make the delivery lifetime-safe without changing the production path.

## Diagnosis confirmed

- `payment-mock.ts` `scheduleWebhook` (was ~:109-119) built `delivery` and only added it to
  `pendingDeliveries` (a `flushWebhooks` test hook) — never registered on any execution context.
- The `/payments` handler (`routes.ts`) constructs the provider inline via
  `deps.paymentProvider(c.env, c.var.db)` and already uses `c.executionCtx.waitUntil` at the
  wake-dispatcher line, so `executionCtx` is reachable on that path.
- `c.executionCtx` THROWS in vitest's `app.request` (documented in `middleware/pipeline-bindings.ts`);
  the fix must NOT read it eagerly.

## Chosen plumbing + why

Thread a narrow lifetime handle to the mock so it registers its OWN delivery (the plan's
preferred option; the criterion-5 test asserts "mock charge REGISTERS its confirming delivery
via executionCtx.waitUntil").

- New port type `WebhookDeliveryLifetime { waitUntil(promise: Promise<unknown>): void }`
  (`ports/payment-provider.ts`) — the structural slice of `ExecutionContext`, mirroring the
  existing `CronContext` pattern in `scheduled.ts`. Re-exported through `ports/index.ts` and the
  `domain/index.ts` route-seam barrel (routes.ts may import only the domain barrel).
- Mock: optional `executionCtx?: WebhookDeliveryLifetime` in config; `scheduleWebhook` calls
  `config.executionCtx?.waitUntil(delivery)` in addition to keeping `pendingDeliveries`
  (`flushWebhooks` remains the test-determinism hook).
- Factory: optional `executionCtx` in `PaymentProviderFactoryOptions`, threaded ONLY into the
  local mock branch; the real Helcim branch never receives it.
- Route `/payments` handler: passes `{ waitUntil: (promise) => { c.executionCtx.waitUntil(promise); } }`
  as the 3rd arg. Constructing this object does NOT read `c.executionCtx` — the read is deferred to
  when the mock actually fires (real workerd runtime), so vitest `app.request` (no execution context)
  never throws.
- `app.ts`: forwards the handle into `createPaymentProviderFromEnv(env, db, { executionCtx })`.

Why not handler-side `c.executionCtx.waitUntil(provider.flushWebhooks())`: it would require an
`isMock` branch in the route and eager `c.executionCtx` access; threading keeps the environment
branch inside the envUtils-gated factory and the route provider-agnostic.

## Files changed

- `apps/api/src/slices/billing/ports/payment-provider.ts` — new `WebhookDeliveryLifetime` type.
- `apps/api/src/slices/billing/ports/index.ts` — re-export the type.
- `apps/api/src/slices/billing/domain/index.ts` — route-seam re-export of the type.
- `apps/api/src/slices/billing/adapters/payment-mock.ts` — `executionCtx` config field; register
  delivery via `waitUntil` in `scheduleWebhook`.
- `apps/api/src/slices/billing/adapters/payment-provider-factory.ts` — `executionCtx` factory
  option, threaded into the mock branch only (Helcim branch untouched).
- `apps/api/src/slices/billing/routes.ts` — `paymentProvider` dep signature gains optional 3rd
  arg; `/payments` handler passes a deferred `waitUntil` wrapper. Only the `/payments` region
  touched (Task-38's `/balance`/`/transactions` regions untouched).
- `apps/api/src/app.ts` — forward `executionCtx` into `createPaymentProviderFromEnv`.
- `apps/api/src/slices/billing/adapters/payment-mock.test.ts` — RED driver + declined guard.
- `apps/api/src/slices/billing/routes.integration.test.ts` — `buildDeps` gains optional
  `executionCtx`; two new tests (credit-via-executionCtx, route-threads-lifetime-handle).

## TDD red → green evidence

RED (mock unit test, before impl), failed for the right reason — delivery never registered:

```
FAIL > mock webhook delivery > registers its confirming delivery on the execution context …
AssertionError: expected [] to have a length of 1 but got +0
  217| expect(registered).toHaveLength(1);
```

GREEN after implementing the mock registration: `payment-mock.test.ts` 24/24 passed.

Integration RED reasoning (verified by construction): before the route edit,
`deps.paymentProvider(c.env, c.var.db)` passed 2 args, so the route-threading test's captured
`lifetime` is `undefined` → `expect(capturedLifetime).toBeDefined()` fails; the credit test's
`registered` stays empty (mock ignored `executionCtx`) → `expect(registered.length).toBeGreaterThan(0)`
fails. Both GREEN after impl.

## Self-gate

- `pnpm test:watch src/slices/billing/adapters/payment-mock.test.ts` — pass — 24/24.
- `pnpm test:watch src/slices/billing/routes.integration.test.ts` — pass — 34/34 (incl. 2 new).
- `pnpm test:watch` factory + parity + payment-webhook.integration + payments.integration — pass — 79/79.
- `npx turbo typecheck --filter=@hushbox/api --force` — pass — exit 0 (forced, not cached).
- `npx turbo typecheck lint --filter=@hushbox/api --force` — pass — exit 0. NOTE: turbo lint
  reported 0 but a direct `eslint` on owned files caught a `no-confusing-void-expression` in the
  route arrow; fixed by adding braces. Direct `eslint <owned files>` (from apps/api) after the
  final edit — exit 0.

## Acceptance criteria

1. Delivery lifetime-safe via `executionCtx.waitUntil` — MET. Mock registers `delivery` on the
   request lifetime; route supplies the handle deferred (no eager `c.executionCtx` read).
2. Post-response timing preserved — MET. The delivery still runs `setTimeout(delayMs)` then
   `fetch`; `waitUntil` keeps the context alive without awaiting before the response returns, so
   the credit lands AFTER `/billing/payments` responds. Proven by the integration test that
   returns 200, then drives only the `executionCtx`-registered promises to observe the credit.
3. No production-path change — MET. `executionCtx` is threaded only into the mock branch of the
   factory; the real Helcim branch (`createHelcimPaymentProvider`) is byte-for-byte unchanged and
   never receives the handle. Branch lives in the envUtils-gated factory, not a raw flag.
4. (Secondary) per-worker singleton mock for the `payment.verify.v1` fallback — SKIPPED as
   permitted; criterion 1 delivers reliably, so the fallback is not needed to green the 3 tests.
5. TDD closest layer — MET (evidence above).

## Deviations

None.

## Concerns and limitations

- Browser e2e proof (the 3 billing tests) is deferred to the orchestrator's consolidated run per
  Global Constraints; not run here.
- `routes.ts` is shared with Task-38 — only the `/payments` handler region (dep type + call site)
  was touched; `/balance` and `/transactions` regions untouched.

## Post-review gate correction (orchestrator finding)

`turbo lint` under-reported (known repo gotcha): the authoritative `pnpm lint` runs prettier as
an eslint rule and failed on `app.ts:387-388` — my multi-line `createPaymentProviderFromEnv` call
should be a single line. Fixed via `prettier --write` (only `app.ts` changed; all other edited
files were already prettier-clean). Whitespace-only reformat, no logic change. Re-verified with
the authoritative gates (from `apps/api`):

- `npx prettier --check` on all 9 edited files — pass — exit 0 ("All matched files use Prettier code style!").
- `npx eslint` on all 9 edited files — pass — exit 0.
- `pnpm test:watch payment-mock.test.ts routes.integration.test.ts` — pass — 58/58.

No files outside Task-37 ownership were touched (`/balance` and `/transactions` in routes.ts left
for Task-38).

## Post-review coverage-regression correction (orchestrator finding)

The `paymentProvider` factory edit added a ternary branch in `app.ts`
(`executionCtx === undefined ? {} : { executionCtx }`), only one side of which was exercised →
`src/app.ts` branches dropped to 93.75% (< 95% gate). Took Option A (simplify away the branch),
after verifying equivalence: the mock reads `config.executionCtx?.waitUntil(...)` (undefined ≡
absent) and the real Helcim branch never touches `executionCtx`, so `{ executionCtx: undefined }`
behaves identically to `{}`.

- `app.ts`: `createPaymentProviderFromEnv(env, db, { executionCtx })` — ternary removed.
- `payment-provider-factory.ts`: option type widened to `WebhookDeliveryLifetime | undefined`
  (exactOptionalPropertyTypes), conditional spread replaced with `executionCtx: options.executionCtx`
  — factory branch also removed.
- `payment-mock.ts`: config field widened to `WebhookDeliveryLifetime | undefined` so the direct
  pass typechecks; the mock's `?.` optional-chain (both branches already covered by existing
  charge tests + the new registration test) is the only remaining branch, and it is fully covered.

No production behavior change; timing/lifetime semantics unchanged. Verified with the FULL,
serial api coverage gate:

- `pnpm test:api` (from repo root) — pass — exit 0, no coverage error on `src/app.ts`.
- `src/app.ts` coverage now: 98.66% stmts / 100% branch / 96.55% func / 98.61% lines
  (branch restored from 93.75% → 100%).
- `npx prettier --check` + `npx eslint` on `app.ts`, `payment-provider-factory.ts`, `payment-mock.ts`
  — pass — exit 0.

## Confidence

High — RED→GREEN observed at the mock layer, integration tests prove the executionCtx-registered
delivery credits the wallet post-response, all scoped gates green, and the real provider path is
provably untouched.
