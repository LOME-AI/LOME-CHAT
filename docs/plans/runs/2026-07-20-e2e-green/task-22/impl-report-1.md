# Task-22 — impl-report-1

## Objective

Close the MinIO media-bucket race on the `pnpm db:up` path. CI runs
`db:up → db:migrate → db:seed → pnpm e2e`. Task-12's bucket-readiness gate lives in
`ensure-stack-cli.ts`, which fires only inside `pnpm e2e`→ensure-stack AND is a no-op in CI
(`if (process.env['CI']) return`). So in CI there was NO gate at all: `db:up`'s old
`docker compose up -d minio-setup` was fire-and-forget, letting `db:seed` issue a
`storage.put` before `mc mb` created `hushbox-media-dev` → `NoSuchBucket` → UNAVAILABLE →
the media 500 cluster. Gate the db:up path with the SAME readiness mechanism.

## Approach / design decisions

- **Route chosen: AC1 option A (route db:up's minio-setup through Task-12's readiness gate),
  not option B (compose healthcheck).** AC4 mandates reusing Task-12's helper and forbids a
  second readiness implementation; a compose healthcheck would be a parallel bucket-existence
  detector that does not reuse `ensureMediaBucketReady`. Option A reuses the single mechanism.
- `db:up` now calls a new thin CLI (`scripts/db-bucket-ready.ts`) after the containers come
  up, which feeds docker-backed deps into Task-12's pure `ensureMediaBucketReady`
  (probe → setup → re-probe → fail-loud). Task-12's gate files (`ensure-stack-cli.ts`,
  `lib/minio-bucket-ready.ts`) are untouched — reused, not duplicated/changed.
- **The docker IO is injected via a runner seam** (`createDockerBucketReadyDeps(run)`) so the
  only real logic — exit-code interpretation (`test -d /data/<bucket>` exit 0 ⟺ bucket
  present) and fail-loud on non-zero setup — is unit-testable without a live docker daemon.
  The CLI wiring itself is v8-ignored, matching the established `ensure-stack-cli.ts` /
  `wrangler-dev.ts` pattern ("real-IO wiring; logic lives in tested pure helpers").
- **TDD shape (AC2 justification):** the testable unit is the deps factory. RED written first
  (`minio-bucket-ready-docker.test.ts`, 5 cases) — failed on missing module — then GREEN.
  The CLI entry is untested wiring; a smoke test (`db-bucket-ready.test.ts`) imports it so the
  scripts per-file coverage gate (`include: ['*.ts']` merges never-imported files at 0%) sees
  it, and asserts it loads without running `main` (import under Vitest never matches
  `isMainModule`, so no docker command fires). Both mirror how every other scripts entry file
  is pinned.

## Files changed

- `scripts/lib/minio-bucket-ready-docker.ts` (new) — docker-backed `BucketReadyDeps` factory
  with injected runner; interprets the `test -d` probe exit code and fails loud on non-zero
  `minio-setup`. Reuses `MEDIA_BUCKET` from Task-12's helper (single source of the bucket name).
- `scripts/lib/minio-bucket-ready-docker.test.ts` (new) — 5 unit tests for the factory.
- `scripts/db-bucket-ready.ts` (new) — `pnpm db:up` gate CLI; execa runner + `ensureMediaBucketReady`. v8-ignored wiring.
- `scripts/db-bucket-ready.test.ts` (new) — import smoke test (coverage + clean-load pin).
- `package.json` — `db:up` second command changed from
  `... docker compose up -d minio-setup` to `... tsx scripts/db-bucket-ready.ts`
  (both under `tsx scripts/with-env.ts`, mirroring `db:seed`).

## Tests added

- `probeBucket reports the bucket present when the probe command exits 0` — exit 0 ⟹ true — AC1/AC4.
- `probeBucket reports the bucket absent when the probe command exits non-zero` — exit !=0 ⟹ false (drives the setup run) — AC1.
- `probeBucket checks the media bucket directory on the minio container without inheriting stdio` — pins the `compose exec -T minio sh -c test -d /data/${MEDIA_BUCKET}` command + non-inherited stdio — AC1/AC4.
- `runBucketSetup runs the minio-setup service to completion with inherited stdio` — pins `compose run --rm minio-setup` (blocking, unlike the old `up -d`) — AC1.
- `runBucketSetup fails loud when the setup command exits non-zero` — fail-fast, no masking — AC1 / CODE-RULES fail-fast.
- `db-bucket-ready entry imports without executing its CLI main` — entry loads clean, no side effects — coverage/AC2.

## Self-gate

- `npx eslint db-bucket-ready.ts db-bucket-ready.test.ts lib/minio-bucket-ready-docker.ts lib/minio-bucket-ready-docker.test.ts` (from scripts/) — **pass** (exit 0) after the last edit.
- `npx vitest run --config scripts/vitest.config.ts` (both new test files) — **pass** — 6/6.
- Coverage (v8) on `lib/minio-bucket-ready-docker.ts` — **100%** stmts/branch/funcs/lines (6/6, 2/2, 3/3, 6/6). `db-bucket-ready.ts` fully v8-ignored (no coverable lines) + imported by smoke test → no 0% merge.
- `npx jscpd --threshold 2 scripts/db-bucket-ready.ts scripts/lib/minio-bucket-ready-docker.ts scripts/ensure-stack-cli.ts` — **pass** — 0 clones (0%). The runner-seam design diverges the token sequence from ensure-stack-cli's inline execa glue, so no duplication with Task-12's file.
- `npx tsc --noEmit -p scripts/tsconfig.json` — **fail**, but zero errors in my files (grep for `db-bucket-ready`/`minio-bucket-ready-docker` → none). All 3 errors are in `apps/api/src/slices/models/domain/{estimate-run,smart-model-candidates,trial-smart-model-candidates}.ts` (exactOptionalPropertyTypes on a `description` field) — other tasks' in-flight uncommitted code (Task-15 admission-estimate territory), not mine. Cause is outside my ownership. See RAISED.
- Live non-destructive proof: stack up (minio healthy), bucket present; `npx tsx scripts/with-env.ts npx tsx scripts/db-bucket-ready.ts` → **exit 0** via the probe-only path. Did NOT wipe the shared MinIO volume (AC3 honored; the create path is unit-tested + `mc mb -p` is idempotent).
- `package.json` re-parsed as valid JSON; `db:up` value verified.

## Acceptance criteria

1. **Met** — after `pnpm db:up`, the gate CLI blocks on `ensureMediaBucketReady` (probe →
   `compose run --rm minio-setup` which blocks until `mc mb -p` finishes → re-probe →
   fail-loud) before `db:seed` can run. Routed through Task-12's readiness gate, awaited.
2. **Met** — TDD at the factory layer (RED→GREEN), CLI wiring v8-ignored per repo convention;
   shape justified above.
3. **Met (scoped, non-destructive)** — live probe-path run exits 0 against the real stack;
   create path unit-tested; volume not wiped per BOUNDS.
4. **Met** — reuses `ensureMediaBucketReady` + `MEDIA_BUCKET` from Task-12's helper; single
   mechanism, no second readiness implementation; jscpd confirms no duplication of Task-12's glue.

## Deviations

None from the acceptance criteria. Chose AC1 option A over option B (justified: AC4 forbids a
second mechanism, which a compose healthcheck would be).

## Concerns and limitations

- The docker command shapes (`compose exec -T minio ...`, `compose run --rm minio-setup`) now
  exist in two places: my `minio-bucket-ready-docker.ts` factory and ensure-stack-cli.ts's
  inline `buildDeps`. jscpd sees no clone (different structure), but the two are semantically
  the same glue. BOUNDS forbade me from refactoring ensure-stack-cli.ts to consume the shared
  factory. A follow-up could migrate ensure-stack-cli's inline probe/setup onto
  `createDockerBucketReadyDeps` to collapse to one glue impl. Noted for the orchestrator.
- Cold-volume end-to-end proof (`db:up && db:seed` from a wiped volume) was deliberately NOT
  run — shared stack, BOUNDS forbids wiping. The race close rests on the unit-tested logic +
  the live probe run + the awaited blocking setup.

## Confidence

High — the mechanism is Task-12's already-audited helper; my addition is a tested factory + a
one-line db:up rewiring, proven green live and by unit tests, with jscpd/eslint/coverage clean.
