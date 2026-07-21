# Task-29 — MinIO bucket-ready as e2e global-setup precondition — impl-report-1

## Objective

Add `ensureMediaBucketReady` (Task-12's helper) to the e2e global-setup as a hard run
precondition so every `pnpm e2e` invocation guarantees the MinIO media bucket exists before
any test runs, closing the "6 UNAVAILABLE image tests" hypothesis. Also verify the
storage-r2 UNAVAILABLE mapping isn't triggered by a CI `service_evidence` write path in local
e2e.

## Files changed

- `e2e/global-setup.ts` — added a hard media-bucket precondition. New `ensureMediaBucket()`
  composes Task-12's `ensureMediaBucketReady` with `createDockerBucketReadyDeps` (the same
  docker-runner factory `scripts/db-bucket-ready.ts` uses), wired to an `execa('docker', …)`
  runner (`reject:false`, `cwd = repoRoot`). Called first in `globalSetup`, before any
  browser launch, so a missing bucket aborts the run fast rather than surfacing later as a
  mid-run UNAVAILABLE. Reuses the single readiness mechanism — no duplicate implementation.
  Header comment updated to describe the gate.

## Tests added

None. The e2e global-setup is real-IO wiring (same pattern as `scripts/db-bucket-ready.ts`,
which carries `/* v8 ignore */` and is covered by no unit test); the pure logic
(`ensureMediaBucketReady`, `createDockerBucketReadyDeps` exit-code interpretation) is already
unit-tested by Task-12 (`scripts/lib/minio-bucket-ready*.test.ts`). Task-29's scoped checks
are e2e eslint/typecheck + the targeted e2e re-run — not a vitest coverage gate. Verification
is the e2e run itself (criterion 3).

## Self-gate

- `npx eslint global-setup.ts` (from `e2e/`) — pass (exit 0).
- `pnpm typecheck` (from `e2e/`, tsgo --noEmit) — pass (exit 0).
- Targeted e2e re-run under the lock on the up stack:
  `flock … pnpm e2e:fast e2e/chat/image-generation.spec.ts` — **10 failed / 16 passed**.
  The 10 failures are NOT the bucket-readiness defect this task targets (see below).

## Acceptance criteria

1. **Gate added as hard precondition — MET.** `globalSetup` now calls `ensureMediaBucket()`
   first; it throws (aborting the run) if the bucket cannot be readied. Reuses Task-12's
   single mechanism.
2. **Endpoint/credentials/bucket correct; CI service_evidence path ruled out — MET (by
   investigation).**
   - Bucket present and reachable: `docker compose exec minio test -d /data/hushbox-media-dev`
     → exists; a direct `aws4fetch` PUT to `http://localhost:9000/hushbox-media-dev/…` with
     `minioadmin/minioadmin` → **HTTP 200**.
   - Env is correct for e2e: `env.config.ts` sets `R2_S3_ENDPOINT=http://localhost:9000`,
     `R2_ACCESS_KEY_ID/SECRET=minioadmin`, `R2_BUCKET_MEDIA=hushbox-media-dev` for E2E mode;
     `docker compose port minio 9000` → `0.0.0.0:9000` (this worktree does not remap it).
   - CI service_evidence path does NOT fire locally: `recordServiceEvidence` (packages/db/
     src/evidence.ts:31) returns early when `!isCI`; local e2e is `!isCI`
     (`isCI = Boolean(env.CI)`, env.ts:43). So the `unavailableError('service-evidence write
     failed', …)` branch at storage-r2.ts:210 cannot fire in local e2e. **No app change was
     needed or made.**
   - storage-r2 integration suite (`storage-r2.integration.test.ts`, 16 tests) passes green
     against the real MinIO, confirming the adapter + MinIO + creds are healthy.
3. **Re-run image tests green — NOT MET.** The bucket gate is correct and now in place, but
   the image tests are still red for a *different* root cause (below), which is outside
   Task-29's ownership.

## Key finding: the plan's UNAVAILABLE hypothesis is only partly right

The plan attributes the 6 UNAVAILABLE image failures to a not-ready bucket. That is
disproven by evidence: the bucket IS ready, direct MinIO PUT is 200, and the storage adapter
passes its full integration suite against MinIO. Yet the e2e run still fails every media
storage write with UNAVAILABLE, via two independent paths:

- **Live image run:** UI generates → `/chat` admission passes (no 402) → stream fails mid-run
  with console `Stream failed: ChatRunFailedError: UNAVAILABLE`; the message renders "This
  turn failed before anything was saved — you were not billed." (28 such occurrences across
  the failing specs).
- **Dev seed:** `POST /dev/media-conversation` (`seedMediaConversation`, fixtures.ts:807)
  returns **503** — `createDevMediaConversation` → `storage.put` → UNAVAILABLE. This path
  touches no model provider and no workflow engine, so the 503 isolates the fault to the
  media `storage.put` executed inside the **e2e worker (wrangler dev / workerd)**.

The adapter works in node (vitest integration) but the same `storage.put` yields UNAVAILABLE
inside the e2e wrangler-dev worker. The failure is specific to the media-storage path in the
workerd runtime for this e2e invocation — NOT bucket readiness, NOT adapter logic, NOT the
CI service_evidence branch. It is outside Task-29's file ownership (the e2e global-setup).

These residuals are 503/UNAVAILABLE, not 402, so they are NOT attributable to Task-21's
wallet/admission work.

### Diagnosis gap (actionable)

`playwright.config.ts` webServer for the API worker sets `stdout: 'ignore'`, so the worker's
UNAVAILABLE cause is never captured; `e2e/report/…/server-api.log` holds only broken-pipe
noise. Whoever owns the fix will need worker stdout to see the real S3/fetch error
(SignatureDoesNotMatch vs connection-refused vs a workerd outbound-fetch issue). I did not
start a competing worker to capture it because Task-21 may now be running e2e under the lock
and a second API worker on the same port would corrupt its run.

## Deviations with reasons

- No failing unit test written first: the change is real-IO infra wiring composing
  already-tested pure helpers, matching the established `scripts/db-bucket-ready.ts` pattern;
  Task-29's scoped checks do not include a vitest coverage gate for e2e infra.

## Concerns and limitations

- Criterion 3 cannot pass on the storage fix alone: a separate defect (media `storage.put`
  → UNAVAILABLE inside the e2e wrangler-dev worker) keeps the image specs red. This needs a
  task with app/worker ownership; it is not Task-29's and not Task-21's.
- The bucket gate I added is still correct and worth keeping — it makes bucket-readiness a
  guaranteed precondition regardless of how the stack was brought up, which is defense the
  run previously lacked at the e2e boundary.

## Confidence

Medium — high confidence the gate is correct and that the residual failure is NOT bucket
readiness (multiple converging proofs); medium on the precise worker-side cause because
worker stdout was suppressed and I deliberately did not spin up a competing worker to capture
it under the shared lock.
