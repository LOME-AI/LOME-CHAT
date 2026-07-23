# Where the ~13.9s "redis is down" wait comes from

## Verdict

**Not clampable via the cockatiel backoff factory.** The wait lives entirely inside
the `@upstash/redis` HTTP client's own built-in retry loop, which every redis-touching
code path in `apps/api` calls directly — none of it goes through
`apps/api/src/lib/resilience/policies.ts`. Clamping `ExponentialBackoff` in the
cockatiel factory would have **zero effect** on these tests.

Evidence that cockatiel is architecturally out of this path: `cockatiel` is imported
in exactly two files in the whole `apps/api/src` tree —
`apps/api/src/lib/resilience/policies.ts` and its test
(`apps/api/src/lib/resilience/policies.test.ts`) — confirmed by
`grep -rln "cockatiel" apps/api/src`. It is lint-enforced
(`apps/api/CLAUDE.md`: "`cockatiel` is importable only inside `src/lib/resilience`").
Redis code never imports it.

## 1. The tests

`apps/api/src/slices/identity/routes.integration.test.ts:1024-1186`, inside
`describe('identity routes: Redis unavailability fails closed', …)`:

- `DEAD_ENV` (line 1025-1028) is `testEnv` with
  `UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9'` — port 9 (`discard`), nothing
  listens locally, so TCP connect fails fast (`ECONNREFUSED`), not a hung socket.
- `postDead()` (line 1042) builds a fresh Hono app pointed at `DEAD_ENV` via
  `deadApp()` (line 1035) and posts to it — i.e. Postgres is real/healthy, only
  Redis is unreachable.
- The four tests at issue:
  - `refuses TOTP setup and verify when redis is down` (line 1106, `40_000` ms
    timeout) — 2 `postDead` calls (`/auth/2fa/setup`, `/auth/2fa/verify`).
  - `refuses login-2FA and 2FA disable when redis is down` (line 1112) — 3 calls.
  - `refuses password change and account deletion when redis is down` (line 1127) —
    4 calls.
  - `refuses recovery and verification-resend (public) when redis is down`
    (line 1164) — 4 calls.
- Each call asserts `expectUnavailable` (line 1057): HTTP 503,
  `{ code: ERROR_CODES.UNAVAILABLE }`.

So "redis is down" here means "the Upstash REST URL points at a closed local port,"
not a mocked failure — the real `@upstash/redis` HTTP client runs its real retry
logic against a real (fast-refusing) TCP endpoint.

## 2. The call chain from route to Redis client

`createRequestRedis` (`apps/api/src/lib/context/factories.ts:20-25`):

```ts
export function createRequestRedis(bindings: RequiredBindings): Redis {
  return new Redis({
    url: bindings.UPSTASH_REDIS_REST_URL,
    token: bindings.UPSTASH_REDIS_REST_TOKEN,
  });
}
```

No `retry` option is passed — the Upstash client's defaults apply untouched.

Two independent redis-touching stages run per `session`/`pending-2fa`/`billing-token`
request, both calling the shared low-level wrappers in
`apps/api/src/lib/redis/operations.ts` (`redisGet`, `redisGetDel`, `redisSet`,
`redisSetNx`, `redisIncr`, `redisMGet`, `redisTtl`, `redisDel` — all `fromPromise(redis.<cmd>(...), …)`,
**no cockatiel anywhere in this file**):

1. **Pipeline session stage** — `apps/api/src/middleware/pipeline-session.ts:97-115`.
   For any request with a parseable session cookie on a revocation-guarded route
   class, it calls `options.revocation(redis, claims)` *before* the domain handler
   runs. The injected implementation is `checkSessionRevocation` →
   `checkSessionLiveness` (`apps/api/src/slices/identity/domain/revocation.ts:30-43`),
   which issues **one** `redisMGet` (both liveness keys in one round trip). A
   rejected promise here fails the *whole request* closed with 503
   (`pipeline-session.ts:111-113`) before the domain code is ever reached.
2. **Domain redis call** — e.g. `startTotpSetup` does one `redisSet`
   (`apps/api/src/slices/identity/domain/totp.ts:61-66`); `createTotpVerifySetupFlow`
   does one `redisGetDel` (`totp.ts:98`). Only reached if the session stage's redis
   call succeeded (it can't in these tests — same dead client).
3. **Rate-limit middleware** (`apps/api/src/middleware/rate-limit.ts`) also calls the
   same raw wrappers directly (`redisIncr`/`redisGet`/`redisSet`/`redisTtl`,
   lines 91-133) with no cockatiel — not on the `2fa/setup`/`2fa/verify` routes
   specifically (no `rateLimitByUser` mounted there per
   `apps/api/src/slices/identity/routes.ts:429-477`), but on other routes in this
   describe block it's a 3rd potential cascade site.

Net: a single POST to a session-class route with redis down fails at the **first**
redis command it reaches (typically the pipeline's revocation `redisMGet`), each
`redis.<verb>()` call independently running the full retry-and-backoff sequence
below before rejecting.

## 3. Confirmed: no cockatiel in this path

`packages/config/arch/rules/admin-op-purity.rule.ts:26` also lists `cockatiel` among
banned-in-admin-ops infra imports, consistent with cockatiel being confined to the
resilience seam. `apps/api/src/lib/redis/operations.ts` and
`apps/api/src/middleware/rate-limit.ts` import only `@upstash/redis` types and the
local `Result`/error helpers — never `../resilience/policies.js`.

## 4. The actual retry source: `@upstash/redis`'s `HttpClient`

`node_modules/.pnpm/@upstash+redis@1.38.0/node_modules/@upstash/redis/chunk-2X4SLXT7.mjs`
(lines ~123-190), `HttpClient` constructor:

```js
this.retry = typeof config.retry === "boolean" && !config.retry ? {
  attempts: 1,
  backoff: () => 0
} : {
  attempts: config.retry?.retries ?? 5,
  backoff: config.retry?.backoff ?? ((retryCount) => Math.exp(retryCount) * 50)
};
```

and `request()`:

```js
for (let i = 0; i <= this.retry.attempts; i++) {
  try {
    res = await fetch(requestUrl, requestOptions);
    break;
  } catch (error_) {
    // ... (abort handling)
    error = error_;
    if (i < this.retry.attempts) {
      await new Promise((r) => setTimeout(r, this.retry.backoff(i)));
    }
  }
}
if (!res) throw error ?? new Error("Exhausted all retries");
```

Since `createRequestRedis` passes no `retry` config, defaults apply: **5 retries
(6 total fetch attempts), backoff `Math.exp(i) * 50` ms** between attempts
(no wait after the final attempt).

Backoff schedule (i = 0..4, before attempts 2..6):

| i | `Math.exp(i)*50` ms |
|---|---|
| 0 | 50.0 |
| 1 | 135.9 |
| 2 | 369.5 |
| 3 | 1004.2 |
| 4 | 2729.9 |
| **sum** | **≈ 4289.5 ms (~4.29s)** |

Each fetch attempt itself is near-instant (local `ECONNREFUSED` against an unbound
port, not a hung socket), so per **failed redis command**, wall-clock cost ≈ **4.3s**,
almost entirely from this backoff sequence, not connection time.

## 5. Reconciling with the observed ~13.9s

For `refuses TOTP setup and verify when redis is down` (2 `postDead` calls), each
request hits **at least one** redis command before the domain layer, and for a
session-class route with a valid cookie it hits **two** in sequence before failing
(session-stage `redisMGet`, though this alone triggers the 503 without reaching
`totp.ts`'s own `redisSet`/`redisGetDel` — so in practice it may be **one** cascade
per call, not two, if the session stage's own revocation check is what trips first).
At ~4.3s per cascade:

- 2 calls × 1 cascade ≈ 8.6s
- 2 calls × 2 cascades (if both session-stage and domain-stage each get their own
  failing round trip in some path) ≈ 17.2s

~13.9s sits between these bounds — consistent with a mix (some calls failing at the
session stage alone, others chaining a second call, plus real event-loop/fetch/Zod
overhead per attempt). The exact per-call count wasn't traced command-by-command for
every one of the 4 tests, but the order of magnitude and the per-command ~4.3s unit
match cleanly; there is no other candidate delay source in the traced path (DB is
healthy in these tests, so no Postgres timeout is involved; there is no explicit
"connection timeout" configured anywhere in this path — `fetch` fails fast on the
closed port).

## Bottom line for the planned fix

- The cockatiel `ExponentialBackoff` factory in `apps/api/src/lib/resilience/policies.ts`
  is **not on this call path at all** — clamping it in test mode fixes nothing for
  these tests.
- The actual knob is the `@upstash/redis` client's own `retry` config
  (`retries`/`backoff`), which is currently left at library defaults
  (5 retries, `Math.exp(i)*50` ms backoff) everywhere `createRequestRedis`
  (`apps/api/src/lib/context/factories.ts:20-25`) constructs a client. Passing e.g.
  `retry: { retries: 0 }` or `retry: false` (env-gated to test/dev, matching the
  "Environment Detection" doctrine in CODE-RULES.md) at that single construction
  site would collapse each failing redis command from ~4.3s to near-zero, and is the
  narrowest fix given `createRequestRedis` is the sole `new Redis(...)` construction
  site for request-scoped clients.
