# Media INTERNAL / NOT_FOUND — deep dive (finalizing RC A + RC B)

Run under diagnosis: `e2e/report/2026-07-20T05-25-42/` (iphone-15).
Method: this pass could NOT read that run's api-worker logs (they are not captured — the
core gap). Instead it (a) verified the live stack, (b) reproduced the two suspect code
paths in isolation against **real local MinIO**, and (c) traced the exact error-code chain
in committed source. No source/test/config was edited; no git writes.

## What the environment shows NOW (2026-07-20)
- Stack up: postgres/redis/neon-proxy/minio all healthy (`docker ps`).
- MinIO healthy: `GET http://localhost:9000/minio/health/live` → 200.
- Bucket present: `hushbox-media-dev` exists in the MinIO volume; `minio-setup` exited 0
  ("Bucket created successfully `local/hushbox-media-dev`").
- Config is aligned, no drift: `apps/api/.dev.vars` R2_S3_ENDPOINT=http://localhost:9000,
  R2_BUCKET_MEDIA=hushbox-media-dev, creds minioadmin/minioadmin; the compose `minio-setup`
  creates exactly `hushbox-media-dev` (docker-compose.yml:96-97). Bucket name, endpoint,
  and credentials all match. **No credential/port/bucket-name drift.**

## Isolation reproduction — the committed code is GREEN
Ran the two integration tests that exercise the exact RC A and RC B paths end-to-end
through real MinIO (`pnpm test:watch <file>`):
- `apps/api/src/slices/chat/domain/media-turn.integration.test.ts` → **1 passed**.
  Drives engine → media node → `mapFilePart` → `storage.put` → download round-trip.
- `apps/api/src/platform/dev/factories.integration.test.ts` → **7 passed**.
  Drives `createDevMediaConversation` (the `/dev/media-conversation` handler body).

Consequence: the prior RC A hypothesis "media node's `mapFilePart` is unwired →
`AdapterDefect`" is **DISPROVEN for committed code** — the wiring
(`runtime.ts:280` → `media-persist.ts:243` `mapFilePartFor`, keyed by `node.id` and minted
before `executor.start`) resolves and the mapper is supplied. The RC B hypothesis
"createDevMediaConversation defect" is likewise **disproven** — it seeds green. The defect
is not in the media code; it is in the **storage.put seam being unavailable at run time**.

## The exact error-code chain (traced in source) — RC A and RC B are ONE cause
When `storage.put` fails (bucket missing → S3 `NoSuchBucket`/404, or MinIO unreachable):
1. `storage-r2.ts` `assertOk` throws `PUT returned 404: …NoSuchBucket…` (line 204/112).
2. The resilience runner maps any thrown op to `unavailableError('operation failed')`
   (`lib/resilience/policies.ts:48`) → Result err code **`UNAVAILABLE`**.
3. RC A (real send): `media-persist.ts` records the failure (`trackPut`, async) and the
   mapper/`flushPuts` barrier re-throws it as a **plain `Error`**
   (`media-persist.ts:186-187` / `:248`: `chat media persist: storage put failed for
   "<key>" (UNAVAILABLE)`). A non-DomainError out of the media node ⇒ the engine settles
   the run **`outcome:'failed', code:'INTERNAL'`** ⇒ client
   `ChatRunFailedError: INTERNAL` (use-chat-stream.ts:378).
4. RC B (dev seed): `createDevMediaConversation` calls `storage.put` **synchronously**
   under `unwrapSeed(..., 'media upload')` (factories.ts:542-545). The err throws a
   `DevSeedError`, which `liftDevWork` maps to `notFoundError` → HTTP **404
   `{"code":"NOT_FOUND"}`** (routes.ts:98-104).

So a single failing `storage.put` produces `INTERNAL` on the send path and `NOT_FOUND` on
the dev-seed path. **RC A and RC B share one root cause: the media-bytes → R2 put seam.**

## "minio down" is a red herring
The string `minio down` exists ONLY in a unit mock
(`media-persist.test.ts:33` returns `errAsync({ code:'INTERNAL', message:'minio down' })`).
Production never emits it — the real messages are `storage put failed … (UNAVAILABLE)` and
the wire codes `INTERNAL` / `NOT_FOUND`. Sharing RC2's "minio down" was that fixture string
conflated with the symptom; treat it as "storage put failed", not literal MinIO state.

## Deterministic vs intermittent
- **Deterministic within a run** whose storage is unavailable/unready: every media op in
  that window fails, which is exactly the 05-25-42 cluster (15 INTERNAL + 7 NOT_FOUND).
- **Intermittent across runs.** The `hushbox-media-dev` bucket lives in the MinIO Docker
  volume and is NOT wiped by `e2e-clean.ts` (that script only clears `test-results/`).
  On a warm stack the fast path (`ensure-stack-cli.ts:165` `allContainersHealthy → return`)
  even skips `minio-setup`. So once the bucket exists, media is green — matching sharing
  RC2's partial 200s and today's passing integration tests.

## The concrete trigger (highest-likelihood, unprovable without the run's server log)
`ensure-stack-cli.ts:171-176` starts bucket creation fire-and-forget:
`docker compose up -d minio-setup` **without `--wait`** and without awaiting `mc mb`
completion. On a cold volume (fresh clone, `compose down -v`, or a pruned volume) the api
worker can serve the first media put **before the bucket exists** → `NoSuchBucket` for the
early part of the run → the INTERNAL/NOT_FOUND cluster, recovering once `mc mb` lands. The
alternative trigger (transient MinIO unreachability) maps to the identical codes. These two
cannot be split from the artifacts because the api-worker error is never captured — the gap.

## Long-term fix (not a skip/timeout)
1. **Bucket readiness gate (kills the race deterministically):** make `ensureContainersHealthy`
   await bucket existence, not just container start — run `minio-setup` with `--wait` on a
   real healthcheck, or follow it with a poll/`mc ls local/hushbox-media-dev` (or a
   HEAD-bucket via the same aws4fetch client) that blocks until the bucket responds, before
   `db:seed`/e2e proceed. Fail loud if it never appears.
2. **Diagnosable dev-seed failures:** have `liftDevWork` preserve the `DevSeedError`
   message in the 404 body, or map storage-availability failures to a distinct
   `UNAVAILABLE`/503 rather than opaque `NOT_FOUND`, so a seed failure names the storage
   cause in the report.
3. (Optional hardening) Consider surfacing a media `storage.put` `UNAVAILABLE` as a typed
   run failure code distinct from defect-class `INTERNAL`, so storage-edge outages are
   distinguishable from real code defects at the wire.

## Enforcement rung (and server-log capture feasibility)
- **Rung 3 (already partially present):** the two integration tests above prove the media
  path against real MinIO. Add an explicit "put to a not-yet-created bucket surfaces
  UNAVAILABLE" case so the error-code contract is pinned.
- **Rung 4 (harness pre-flight):** an e2e fixture that pings `/dev/media-conversation` once
  during setup and hard-fails the whole run with the server error if storage is
  down/unready — distinguishes host-flake from app defect (Pillar 2.10) and turns this
  class from a silent 31-test cluster into one loud setup failure.
- **Rung 5 — capture api-worker logs into `e2e/report/<run>/` (FEASIBLE):** `apps/api`'s
  dev entry is `scripts/wrangler-dev.ts` (a tsx wrapper around `wrangler dev` on
  `HB_API_PORT`), launched by Playwright's `webServer`. Its stdout/stderr is a normal child
  stream — tee it to `e2e/report/<run>/server-api.log` (or attach the failing run's server
  error via the auto-fail fixture). This is the single change that would have let this
  investigation read the literal `NoSuchBucket`/`UNAVAILABLE` stack instead of inferring it.

## Confidence
Seam is **pinned with live proof** (isolation green + full source trace). RC A ≡ RC B ≡
one storage.put failure. The precise trigger (cold-bucket readiness race vs transient MinIO)
is named but not decidable from artifacts — which is itself the enforcement finding.
