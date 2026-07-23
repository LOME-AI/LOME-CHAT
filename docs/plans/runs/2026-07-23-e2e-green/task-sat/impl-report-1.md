# Task-sat impl-report-1

## Objective
Harden the local/CI storage seam so the committed 12 Playwright workers survive host CPU
contention: widen the R2/MinIO PUT retry window for NON-production modes only, keeping
production fail-fast unchanged. No worker-count change, no production behavior change.

## Files changed
- `apps/api/src/slices/media/adapters/storage-factory.ts` — Added exported
  `NON_PROD_STORAGE_NETWORK` (`{ maxRetries: 6, initialDelayMs: 100, maxDelayMs: 5000 }`)
  and pure `storageNetworkForEnv(env)`; the factory now passes the resolved window as
  `network` (conditionally spread — omitted in production so `DEFAULT_NETWORK` applies).
- `apps/api/src/slices/media/adapters/storage-factory.test.ts` — Added a
  `storageNetworkForEnv` describe block (4 cases) proving the non-prod window and the
  production `undefined`.

## Env-mode branch (exact)
`createEnvUtilities(env).isProduction ? undefined : NON_PROD_STORAGE_NETWORK`. Decision is
made through `createEnvUtilities` (the single env source), never a bare var-existence or
`NODE_ENV`/`CI` check. `isProduction` is true only when `NODE_ENV === 'production'`, so
every non-production mode — development, ciVitest, ciE2E, test — gets the wider window;
production alone keeps `storage-r2`'s `DEFAULT_NETWORK` (maxRetries:2, maxDelayMs:1000).

## Retry values
Non-prod: `maxRetries: 6`, `initialDelayMs: 100`, `maxDelayMs: 5000` (timeoutMs untouched,
stays 60s from DEFAULT_NETWORK via the `{ ...DEFAULT_NETWORK, ...config.network }` spread in
`storage-r2.ts:152`). ExponentialBackoff (100→200→400→800→1600→3200, capped 5000) sums to
~6.3s of retry coverage across 6 retries — enough to ride out a multi-second MinIO
unavailability burst. PUT is idempotent (last-write-wins, `storage-r2.ts:30-33`), so
retrying is correct recovery.

## Change B (MinIO resource floor) — SKIPPED (documented)
Skipped per the brief's escape hatch. `docker-compose.yml` is the modern Compose Spec
(no `version:` key, uses `name:`) and the stack is brought up via non-swarm
`docker compose up` (`package.json` `db:up`, verified). `deploy.resources.reservations`
(the primary primitive the brief named) is a **swarm-only** guarantee — non-swarm
`docker compose up` silently ignores it, so the block would be a misleading no-op implying a
floor that does not exist. Furthermore the diagnosed contention is between **host-level**
Playwright/Node processes and the MinIO **container**; container-level CPU knobs
(`cpu_shares`/`cpus`) arbitrate only between containers/cgroups and cannot reliably win CPU
for MinIO against host processes. Adding either would be forcing a knob that does not target
the diagnosed resource — so B is skipped and Change A (host-topology-independent retry
widening) carries the fix.

## Self-gate
- `vitest run storage-factory.test.ts storage-r2.test.ts` — pass (2 files, 34 tests).
- `turbo typecheck lint --filter=@hushbox/api` — pass (2/2 tasks). One transient failure
  during iteration: `exactOptionalPropertyTypes` rejected an explicit `network: undefined`;
  fixed by conditionally spreading `network` (omit in production). Final run clean.
- Did NOT run full `pnpm test:api` (DB-heavy; brief directs targeted only). Did NOT run
  `pnpm e2e`.

## TDD proof
Wrote the `storageNetworkForEnv` tests first; ran them RED with the exact expected reason
(`TypeError: storageNetworkForEnv is not a function`, 4 failed / 5 passed). Implemented the
function + constant, re-ran GREEN (34 passed). Watched the fail before writing production
code.

## Acceptance criteria
- Non-prod modes inject the wider window; production keeps DEFAULT_NETWORK — MET
  (`storageNetworkForEnv`, unit-tested for development, CI-dev, and production).
- Env detection strictly via `envUtils`/MODE, never bare var-existence — MET
  (`createEnvUtilities(env).isProduction`).
- No production behavior change; storage failures still surface (no `|| true`, no swallow) —
  MET (production branch returns undefined ⇒ unchanged DEFAULT_NETWORK; all error paths in
  `storage-r2.ts` untouched).
- No worker-count reduction, no wall-clock waits — MET (only the media/estimate/identity
  files and worker config were out of bounds and untouched).

## Deviations
Change B skipped (see above) — a permitted skip, not an omission.

## Concerns and limitations
- Change A is validated at the unit/decision layer (the pure function). Full end-to-end
  proof that a real MinIO burst is now ridden out requires the e2e media suite under
  contention, which this task does not run. The retry-budget math and idempotent-PUT
  invariant give high confidence it holds.
- The MinIO container itself remains without an enforced resource floor; if the diagnosed
  contention proves to bind on MinIO container CPU specifically (rather than host
  oversubscription), a swarm-context or `cpu_shares` follow-up may be revisited — flagged
  for the orchestrator, not silently absorbed.

## Confidence
High — root-cause fix is a minimal, env-scoped, prod-safe retry widening on an idempotent
op, proven RED→GREEN with typecheck+lint clean; B skip is justified against the actual
non-swarm runtime.
