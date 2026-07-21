# workerd storage.put UNAVAILABLE — root cause

## Verdict
NOT a workerd/aws4fetch/endpoint defect. It is a **MinIO bucket-readiness race**:
the e2e API worker served media `storage.put` while the `hushbox-media-dev`
bucket did not yet exist → MinIO `NoSuchBucket` (404) → `assertOk` throws →
retry/timeout policy maps it to `UNAVAILABLE` → route returns 503 /
`ChatRunFailedError`.

## Proof it is not a runtime defect
Started a fresh `wrangler dev` (workerd) on the e2e port 8788 using the exact
committed `apps/api/.dev.vars` (endpoint `http://localhost:9000`, bucket
`hushbox-media-dev`, creds `minioadmin`) and hit the real path:
`POST /dev/media-conversation {ownerEmail: test-alice-chromium@test.hushbox.ai,
userContent, mediaType: image}` → **HTTP 201** (`storage.put` succeeded, object
written to `/data/hushbox-media-dev/media/...`). Same workerd, same .dev.vars,
same MinIO → success once the bucket exists. Endpoint reachable on IPv4, `::1`,
and `localhost` (all curl → 403 auth challenge), so it is not a localhost/IPv6
resolution issue either.

## Error path (file:line)
- `apps/api/src/slices/media/adapters/storage-r2.ts:196-205` — `put()` runs
  `aws.fetch(PUT)` then `assertOk`.
- `storage-r2.ts:103-113` — `assertOk` throws `PUT returned 404: <NoSuchBucket>`
  on any non-2xx.
- `retryWithTimeoutPolicy` (runner) maps the throw to `unavailableError`
  (UNAVAILABLE); route → 503.
- NOTE: this error is caught into a DomainError, so it is NOT printed to worker
  stderr — capturing wrangler stdout/stderr never reveals it. It only surfaces
  in the 503 response body. (Task-12's server-api.log capture would not have
  shown it, and neither does `.wrangler-8788.log`, which held only benign
  `Broken pipe` client-disconnect noise.)

## Timeline evidence (container UTC = host EDT+4)
- MinIO cold-started (fresh `.minio.sys`): 11:37 UTC = **07:37 EDT**
- bucket `hushbox-media-dev` created: 12:19 UTC = **08:19 EDT**
- Task-21 e2e worker (`.wrangler-8788.log`) last active: **08:11 EDT**
→ the worker served storage.put ~8 min BEFORE the bucket existed. A 42-min
window (07:37→08:19) where MinIO was up but had no media bucket.

## Regression? YES — but the landed change is the FIX, not the break
- `apps/api/src/slices/media/adapters/storage-r2.ts`, `storage-factory.ts`,
  `.dev.vars`, `wrangler.toml`: all clean (unmodified this run).
- `scripts/lib/minio-bucket-ready.ts`: **untracked (new)**;
  `scripts/ensure-stack-cli.ts`: **modified (+35/-11)**. These add
  `ensureMediaBucketReady` (ensure-stack-cli.ts:180), a gate that probes
  `test -d /data/hushbox-media-dev` on EVERY ensure-stack path and runs
  `docker compose run --rm minio-setup` (`mc mb -p`, idempotent) when missing.
  Its own comment names this exact bug: the "old fire-and-forget
  `up -d minio-setup` … let the API serve storage.put before the bucket
  existed" and the residual hazard "volume wiped under warm containers"
  (minio-bucket-ready.ts:5-9).

## Why it still failed this run
The gate runs in `pnpm ensure-stack` (e2e:prepare), BEFORE playwright's
webServer starts the worker — so it closes the cold-start case. The remaining
failure window is a **concurrent `minio_data` volume wipe under an
already-running worker** (`docker compose down -v` / `docker volume prune` /
`cleanupOrphanedProjects`) fired by a sibling e2e task while Task-21's worker
was live. The gate cannot protect a worker that was already serving when the
volume vanished. The stale, EMPTY `e2e-run.lock` (from 02:15) indicates the
exclusive lock was not actually held, so stack-lifecycle ops were not
serialized across tasks.

## Owning layer + fix
- Layer: **e2e stack lifecycle / docker volume** — NOT the storage adapter,
  NOT workerd.
- Fix: (1) hold the `e2e-run.lock` for the whole run and never
  `down -v`/volume-prune the shared MinIO while an e2e worker is live;
  (2) the freshly-landed `ensureMediaBucketReady` gate is correct — keep it;
  (3) hardening option: have the API webServer readiness (or a first-touch
  self-heal in `storage.put`) re-probe/recreate the bucket, or give each
  concurrent e2e run an isolated MinIO volume, so a mid-run wipe cannot strand
  a live worker.

## Reproduce note
Task-21 was idle (no workerd/wrangler/playwright/vitest processes; port 8788
dead; empty stale lock), so starting a worker on 8788 was safe. Worker was
stopped and the port freed after the repro.
