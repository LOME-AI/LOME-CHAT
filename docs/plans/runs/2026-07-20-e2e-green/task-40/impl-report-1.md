# Task-40 — set SRH backend connection cap on serverless-redis-http

## Objective

Raise the `serverless-redis-http` (SRH) backend Redis connection pool above the
image default (~3) so 12 Playwright workers don't saturate it and trip fail-closed
503s on authenticated requests (`/auth/me` etc.). Config-only; no app code.

## Env var verification (critical acceptance criterion)

- **Correct var: `SRH_MAX_CONNECTIONS`.** Verified against the image's own README
  (`hiett/serverless-redis-http`, https://github.com/hiett/serverless-redis-http).
  Documented behavior: connection-pool size, **default `3`**, and it is **only used
  when `SRH_MODE=env`** — which is exactly our configuration (`SRH_MODE: env`). In
  file mode the equivalent is the JSON `max_connections` field, not applicable here.
- The plan's suggested name (`SRH_MAX_CONNECTIONS`) is the real one for env mode; no
  alternate-name substitution was needed. Evidence is the image README, not memory.

## Files changed

- `docker-compose.yml` (SRH service `environment:` block) — added
  `SRH_MAX_CONNECTIONS: 100` with a comment explaining the pool-saturation → 503
  failure mode and the sizing rationale.

## Value chosen

`100` — comfortably above 12 workers × the handful of per-request Redis HTTP ops,
matching the plan's example. Well above the default 3 that caused saturation.

## Diff

```yaml
       SRH_MODE: env
       SRH_TOKEN: local_dev_token
       SRH_CONNECTION_STRING: 'redis://redis:6379'
+      # Backend Redis pool size. Image default is 3; 12 Playwright workers each
+      # funnel several Redis HTTP ops per request, saturating that tiny pool and
+      # tripping fail-closed 503s. Sized well above 12 workers x per-request ops.
+      SRH_MAX_CONNECTIONS: 100
```

## CI safety (single-source local + CI)

`docker-compose.yml` is the single source of infra for both local and CI
(`pnpm db:up`). The change is purely additive to one service's environment: it only
enlarges SRH's backend pool. It changes no ports, no other service, no CI-consumed
values. Larger pool = strictly more headroom; CI's SRH usage (lower concurrency than
12-worker e2e locally, or same in the e2e job) can only benefit. Reversible.

## Self-gate

- `docker compose config` — pass. Parses cleanly; resolved value confirmed
  `SRH_MAX_CONNECTIONS: "100"` in the rendered config. Exit 0.
- `npx prettier --check docker-compose.yml` — pass ("All matched files use Prettier
  code style").

## Acceptance criteria

1. Set correct env var on SRH service, value above worker-concurrency × per-request
   ops, with a WHY comment — **met** (`SRH_MAX_CONNECTIONS: 100`, verified var name,
   comment added).
2. Single-source local+CI change, no other service touched, CI unaffected — **met**
   (see CI safety; only the SRH environment block changed).
3. No app code change — **met** (only `docker-compose.yml`).

## Deviations

None.

## Concerns and limitations

- Behavioral proof (503s gone under a full 12-worker e2e run) is deferred to the
  user's e2e run per the brief; not run here.

## Confidence

High — env var name verified against the image README (default 3, env-mode only,
matching our `SRH_MODE=env`), compose parses, formatting clean, change is additive
and reversible.
