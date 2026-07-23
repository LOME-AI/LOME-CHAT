# How apps/api/src/lib code learns the current env MODE — and whether the resilience policy factory can

## 1. `createEnvUtilities` / `envUtils` — definition and full API surface

Defined in `packages/shared/src/env.ts:1-91`. This is the sole source of truth for
dev/prod/CI/E2E detection (docstring line 20: "THE source of truth for all dev/prod/CI
detection").

```ts
export interface EnvContext {
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
  VITEST?: string; // forwarded from process.env.VITEST by whoever builds the context
}

export function createEnvUtilities(env: EnvContext): EnvUtilities
```

Throws (`env.ts:39-41`) if `env.NODE_ENV === undefined` — no fallback default.

Returned `EnvUtilities` (`env.ts:71-90`), **exactly these fields, nothing else**:

| field | meaning |
|---|---|
| `isDev: boolean` | `NODE_ENV === 'development'` |
| `isLocalDev: boolean` | `isDev && !isCI` |
| `isDevServer: boolean` | `isLocalDev && !isE2E && !isVitest` — the strict "real interactive dev server" subset |
| `isProduction: boolean` | `NODE_ENV === 'production'` |
| `isCI: boolean` | `Boolean(env.CI)` |
| `isE2E: boolean` | `Boolean(env.E2E)` |
| `requiresRealServices: boolean` | `isProduction \|\| isCI` |

**`isVitest` is computed internally (`env.ts:49`, `Boolean(env.VITEST)`) but is NOT
exposed on `EnvUtilities`.** The comment at `env.ts:45-48` is explicit: "Kept private —
its only purpose is to make `isDevServer` honest (no direct consumers)." There is no
`isTest`, `isCiVitest`, or `mode` accessor anywhere on the public type.

A derivable (but currently unused anywhere in the codebase — Verified via grep, no
call site combines these fields this way) predicate for "this is a vitest run, local or
CI" using only public fields:

```
isVitestRun = !isDevServer && !isE2E && !isProduction
```

Verified by enumerating all 5 modes against the `EnvUtilities` outputs (see §4) — it
resolves correctly for every mode, but only if `VITEST` actually reached the
`EnvContext` that was passed to `createEnvUtilities`, which §4 shows is not guaranteed
on the request-pipeline path.

## 2. Declared env MODES

Defined in `packages/shared/src/env-types.ts:10-16`:

```ts
export enum Mode {
  Development = 'development',
  CiVitest = 'ciVitest',
  E2E = 'e2e',
  CiE2E = 'ciE2E',
  Production = 'production',
}
```

Five modes, not four — `E2E` (local e2e) and `CiE2E` (e2e in CI) are distinct from each
other, in addition to `Development`/`CiVitest`/`Production`. Each `VariableConfig`
(`env-types.ts:40-47`) declares a per-mode value; `packages/shared/src/env.config.ts` is
the registry of every variable × mode.

Confirmed concretely from `env.config.ts`:
- `NODE_ENV` (`env.config.ts:43-46`): `CiVitest` refs `Development` → **CI-vitest runs
  with `NODE_ENV=development`**, same as local dev.
- `CI` (`env.config.ts:106-111`): `'true'` for `CiVitest` and `CiE2E` only — not set for
  local `Development` or local `E2E`.
- `E2E` (`env.config.ts:113-115` area): `'true'` for `E2E`, and `CiE2E` refs `E2E` → both
  e2e modes carry `E2E=true`.
- `VITEST` is **not an `env.config.ts` registry entry at all** — it is not part of the
  generate-env/verify-env mode system. It is an ambient signal Vitest itself sets on
  `process.env.VITEST` at runtime, which individual call sites must manually forward
  into whatever `EnvContext` object they build (see §4).

Resulting `EnvUtilities` per mode (derived, cross-checked against `env.config.ts` +
`env.ts` logic):

| Mode | NODE_ENV | CI | E2E | VITEST (if forwarded) | isCI | isLocalDev | isDevServer | isE2E |
|---|---|---|---|---|---|---|---|---|
| Development (dev server) | development | — | — | — | false | true | **true** | false |
| Development (local vitest) | development | — | — | true | false | true | **false** | false |
| E2E (local e2e) | development | — | true | — | false | true | false | **true** |
| CiVitest | development | true | — | true | **true** | false | false | false |
| CiE2E | development | true | true | — | **true** | false | false | **true** |
| Production | production | — | — | — | false | false | false | false |

## 3. How a service factory/adapter in apps/api obtains `envUtils` today

Two sanctioned entry points, both funneling through `createEnvUtilities`:

**a) Request pipeline (`c.get('envUtils')`)** — `apps/api/src/middleware/pipeline-env.ts:12-23`
is pipeline stage 1: it calls `createEnvUtilities(c.env)` once per request and
`c.set('envUtils', ...)`. Every later middleware/route/handler reads
`c.get('envUtils')`; nothing after this stage may call `createEnvUtilities` directly
(comment at `pipeline-env.ts:8-10`: "CODE-RULES: middleware ahead of the env stage calls
`createEnvUtilities(c.env)` directly — this IS that stage; everything after reads
`c.get('envUtils')`").

**b) Composition-root factories (`createEnvUtilities(env)` directly)** — service
factories that build an adapter from raw bindings call it once at construction time and
thread the *result* (never the full `EnvUtilities` object) into the adapter's config as
plain fields. Three real examples:

- `apps/api/src/slices/billing/adapters/payment-provider-factory.ts:47` —
  `const { isLocalDev, isCI } = createEnvUtilities(env);` then branches
  mock-vs-`createHelcimPaymentProvider({ apiToken, ...(db && { db, isCI }) })`
  (line 70-73).
- `apps/api/src/slices/media/adapters/storage-factory.ts:37` —
  `const { isCI } = createEnvUtilities(env);` then
  `createR2Storage({ ..., db, isCI })` (line 38-47).
- `apps/api/src/slices/notifications/adapters/email-sender-factory.ts:73` —
  `const { isLocalDev, isCI } = createEnvUtilities(env);` then branches
  mock-vs-`createResendEmailSender({ apiKey, db, isCI })` (line 75-83).

In every case the *adapter itself* (`payment-helcim.ts`, `storage-r2.ts`,
`email-resend.ts`) never imports `createEnvUtilities` and never sees `EnvContext` —
it only receives the single already-decided boolean (`isCI`) as a plain config field,
used solely to gate `recordServiceEvidence(...)` (CI cassette/evidence bookkeeping), not
retry behavior.

## 4. Can `apps/api/src/lib/resilience/policies.ts` learn "is this test mode"? (the load-bearing finding)

**`retryPolicy`, `timeoutPolicy`, `retryWithTimeoutPolicy`
(`apps/api/src/lib/resilience/policies.ts:85-101`) take only `RetryOptions`/
`TimeoutOptions` — no `env`, `EnvContext`, or `EnvUtilities` parameter anywhere in the
factory's signature or its call chain.** Confirmed by reading the full file
(102 lines) — nothing there threads an env object in.

Its three real callers all take the same shape: a fixed `DEFAULT_NETWORK` constant
spread with an optional `config.network` override, passed straight to
`retryWithTimeoutPolicy`/`timeoutPolicy`:

- `apps/api/src/slices/billing/adapters/payment-helcim.ts:34-39` (`DEFAULT_NETWORK`),
  `:139` (`retryWithTimeoutPolicy({ ...DEFAULT_NETWORK, ...config.network })`).
- `apps/api/src/slices/media/adapters/storage-r2.ts:61-66`, `:152` (same pattern).
- `apps/api/src/slices/notifications/adapters/email-resend.ts:66`
  (`timeoutPolicy({ timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS })`).

None of these three adapter files import `createEnvUtilities` or accept `EnvContext` —
they accept only `isCI: boolean` (already-decided, threaded from the factory as in §3)
plus an optional `network`/`timeoutMs` override object. **They have no `EnvUtilities` to
pass to the resilience factory even if they wanted to** — env detection already happened
one layer up, in `*-provider-factory.ts`/`*-factory.ts`, and only `isCI` survived the
handoff.

`apps/api/src/slices/chat/domain/settlement.ts` was also checked per the prompt: it has
**zero** references to `retryPolicy`/`timeoutPolicy`/`createEnvUtilities`/`resilience` —
it does not call the resilience factory at all (Verified by grep, no matches).

**The existing, actually-used mechanism for "fast retries in tests" is manual, not
env-detected**: every unit test that exercises a real adapter constructs it directly and
passes an explicit fast `network` override, bypassing envUtils entirely:

- `apps/api/src/slices/billing/adapters/payment-helcim.test.ts:19` —
  `const FAST_NETWORK = { maxRetries: 2, initialDelayMs: 0, maxDelayMs: 0, timeoutMs: 1000 };`
  passed as `network: FAST_NETWORK` at `:25`, `:348`, and a stricter zero-retry variant
  at `:437`.
- `apps/api/src/slices/media/adapters/storage-r2.test.ts:38` —
  `network: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, timeoutMs: 1000 }`.
- `apps/api/src/slices/notifications/adapters/email-resend.integration.test.ts:322` —
  `timeoutMs: 20`.

This works because the real adapters (`createHelcimPaymentProvider`,
`createR2Storage`, `createResendEmailSender`) are only reached two ways: (1) directly
by their own test files, which already know they're tests and pass the override by
hand; or (2) via the `*FromEnv` factories, which route to the **mock** implementation
in `isLocalDev` (and `isCI`, for email) — meaning the real network-retry path is
essentially never live during the test suite today except inside the adapters' own
test files, which self-clamp.

**Whether the request pipeline itself even sees `VITEST` is inconsistent.** Checked a
concrete integration test that drives the full app through `pipelineEnv()`:
`apps/api/src/slices/billing/routes.integration.test.ts:47-53` builds its `testEnv`
literally as
`{ NODE_ENV: 'development', DATABASE_URL, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, IRON_SESSION_SECRET, TELEMETRY_SINKS }`
— **no `VITEST` field**. Run through `pipelineEnv()` → `createEnvUtilities(testEnv)`,
this produces `isDevServer: true` (since `isVitest` reads `Boolean(undefined) = false`),
i.e. `c.get('envUtils')` inside this integration test is **indistinguishable from a real
interactive dev server**. By contrast, other files do forward it explicitly:
`apps/api/src/smoke/harness.ts:70`, `apps/api/src/slices/models/adapters/integration-setup.ts:42`,
and `apps/api/src/slices/models/domain/gateway-metadata.integration.test.ts:57` all spread
`...(process.env['VITEST'] !== undefined && { VITEST: process.env['VITEST'] })` into their
env objects. So forwarding is opt-in per test file, not systematic — a route reached
through `routes.integration.test.ts`-style tests cannot rely on `c.get('envUtils')`
reporting "test mode" today even indirectly via the derived `!isDevServer && !isE2E &&
!isProduction` predicate from §1, because the underlying `VITEST` signal was never put
into that particular `testEnv`.

### Bottom line

- **No public envUtils accessor says "is this vitest."** `isVitest` exists in
  `packages/shared/src/env.ts` but is explicitly private/unexported from
  `EnvUtilities`, by design ("no direct consumers").
- **`policies.ts`'s factory functions are pure and receive no env parameter anywhere in
  their current call chain** — none of their three real call sites (`payment-helcim.ts`,
  `storage-r2.ts`, `email-resend.ts`) have `EnvUtilities` in scope; env detection already
  happened and was collapsed to a bare `isCI` boolean one layer up, in the `*-factory.ts`
  composition-root files.
- The codebase's actual, working answer to "fast retries under test" is **not**
  env-mode detection inside `policies.ts` — it is each adapter test constructing the
  adapter with an explicit `network` override (`FAST_NETWORK`-style objects), a pattern
  already established in three places (§4 above).
- If a future implementer wants `policies.ts` (or its callers) to auto-clamp under
  vitest without a manual per-call override, the clean, precedent-following path is:
  (1) surface `isVitest` (or a derived `isTest`) as a **public** field on `EnvUtilities`
  in `packages/shared/src/env.ts` — a one-line change reversing the current "no direct
  consumers" design choice — and (2) thread it through the same handoff shape already
  used for `isCI`: the `*-factory.ts` files already call `createEnvUtilities(env)` and
  could pass a `network` override into `createHelcimPaymentProvider`/`createR2Storage`/
  `createResendEmailSender` exactly the way they already pass `isCI`, requiring **no**
  signature change to `policies.ts` itself. This also requires making `VITEST`
  forwarding into `EnvContext` systematic rather than opt-in-per-test-file (see the
  `routes.integration.test.ts` gap above) for the pipeline path to see it consistently.
  There is no shortcut that avoids touching `packages/shared/src/env.ts`'s public
  surface — that is the load-bearing gap.
