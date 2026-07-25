# Task 04 — Pipeline core — impl report 2 (audit fixes)

## Objective

Fix the three validated findings from the 3-lens audit panel of Task 04, and nothing
else: (1) `lastSeenAt` was never written by any code path; (2) no workerd Intl spike
test existed anywhere in the repo; (3) the `PresenceReader` port was orphaned by this
task's deletion of `sendPushForNewMessage`. The crypto/authz/G1 work was left untouched.

## Files changed

Finding 1 — `lastSeenAt` on registration AND on send:

- `apps/api/src/slices/notifications/ports/device-token-store.ts` — new
  `touchLastSeen(references: readonly PushDeviceRef[])` on the store port (the liveness
  write the retention delete reads).
- `apps/api/src/slices/notifications/adapters/device-token-store-db.ts` — upsert's
  `onConflictDoUpdate` set now bumps `lastSeenAt`; implements `touchLastSeen` as one
  `UPDATE … SET last_seen_at = now WHERE (userId,token) OR (userId,token) …` (pair-matched
  per ref, never two independent IN lists, so a target cannot refresh a row it does not own).
- `apps/api/src/slices/notifications/ports/push-sender.ts` — `PushDelivery` gains
  `deliveredTokens?: readonly PushDeviceRef[]` (the success-ref mirror of `deadTokens`).
- `apps/api/src/slices/notifications/adapters/push-fcm.ts`,
  `.../push-webpush.ts`, `.../push-composite.ts`, `.../push-mock.ts` — each transport now
  reports the targets the push service accepted; the composite folds both partitions'
  lists. The mock reports every recipient, so dev/CI exercises the refresh too.
- `apps/api/src/slices/notifications/domain/notify-event.ts` — the delivery path calls
  `touchLastSeen(delivery.deliveredTokens)` after the dead-token prune.
- `apps/api/src/slices/notifications/adapters/push-composite.ts` — the module-level
  `NOTHING` constant was inlined at its single use so the widened empty-delivery literal
  did not create a new textual clone with `push-webpush.ts` (jscpd; see self-gate).

Finding 2 — workerd Intl pin:

- `apps/api/vitest.workers.config.ts` (new) — a second vitest project on the repo's
  existing `@cloudflare/vitest-pool-workers` harness (the `packages/{db,realtime}`
  pattern), no `main` worker needed; compat date + flags mirror `apps/api/wrangler.toml`.
- `apps/api/src/workers-validation/quiet-hours.workers.test.ts` (new) — runs the real
  `quiet-hours` module inside workerd.
- `apps/api/package.json` — `@cloudflare/vitest-pool-workers` devDep (same version spec
  already in the lockfile for db/realtime) + `test:workers` script, chained into `test`
  exactly as db/realtime do, so CI runs it.
- `knip.jsonc` — `vitest.workers.config.ts` declared as an apps/api entry (the workspace's
  explicit `entry` list suppresses knip's default config-file detection, so without this
  the new devDep reports as unused).

Finding 3 — orphan deletion:

- `apps/api/src/slices/notifications/ports/presence-reader.ts` — deleted.
- `apps/api/src/slices/notifications/ports/index.ts`, `.../notifications/index.ts` —
  re-exports removed.

Test-only edits forced by the above: `device-token-store-db.integration.test.ts`,
`notify-event.test.ts`, `notify-event.integration.test.ts`, `push-fcm.test.ts`,
`push-webpush.test.ts`, `push-composite.test.ts`, `push-mock.test.ts`,
`push-sender-factory.test.ts`, `domain/device-tokens.test.ts`,
`routes.integration.test.ts` (store stubs gain `touchLastSeen`; delivery assertions gain
`deliveredTokens`), and `apps/api/src/adapters/push-notify.test.ts` (its fake DB gains an
`update` chain; the spy now also asserts the last-seen write happens through the
composition root).

## Tests added

Registration path:

- `device-token-store-db.integration.test.ts` › `upsert` › **refreshes lastSeenAt on a
  repeated registration** — backdates the row to 2020-01-01, re-upserts, asserts the
  column advanced. Covers "…touched on successful registration".

Delivery path (store):

- `touchLastSeen` › **refreshes lastSeenAt for the delivered tokens**
- `touchLastSeen` › **leaves a token that was not delivered to untouched**
- `touchLastSeen` › **never refreshes another user's token** (pair-matching, authz)
- `touchLastSeen` › **resolves without a write for an empty ref list**
- `touchLastSeen` › **maps a touch failure to an unavailable error**

Delivery path (domain):

- `notify-event.test.ts` › **touches last-seen for every target the sender delivered to**
- `notify-event.test.ts` › **never touches last-seen for a target the sender failed to
  reach** (a mixed delivered/dead result touches only the delivered ref)

Delivery path (end-to-end over the real stores) — the Task-06 retention guard:

- `notify-event.integration.test.ts` › **refreshes last-seen on the device it delivered
  to, so retention keeps it** — a real `device_tokens` row backdated to 2020, notified
  through the real store + mock sender, asserted refreshed. This is the active-device
  test the audit asked for.
- `notify-event.integration.test.ts` › **leaves last-seen stale on a device the send
  never reached** — the negative half.

Transports:

- `push-fcm.test.ts` / `push-webpush.test.ts` / `push-mock.test.ts` — success cases now
  assert the exact `deliveredTokens` refs (FCM's mixed ok/dead case asserts the delivered
  ref is the surviving token, not the dead one).
- `push-composite.test.ts` › **sums delivery counts and concatenates delivered and dead
  tokens across partitions** (renamed/extended) and › **folds a partition that reports
  neither delivered nor dead targets**.

workerd:

- `src/workers-validation/quiet-hours.workers.test.ts` — 6 tests:
  **runs on workerd, not on the node test runtime** (`navigator.userAgent ===
  'Cloudflare-Workers'`, so a misconfigured project cannot silently pin node's full ICU);
  **resolves whole-hour offsets in both hemispheres** (UTC 12:00, America/New_York 07:00,
  Asia/Tokyo 21:00, Australia/Lord_Howe 23:00 at 2026-01-15T12:00Z); **resolves a
  half-hour offset zone** (Asia/Kolkata 17:30 — the case a degraded ICU build breaks
  first); **shifts a zone across its own DST transition** (New York 07:00 winter → 08:00
  summer); **rejects an unrecognized zone instead of silently falling back to UTC**;
  **evaluates a cross-midnight window in the user's own zone** (22:00–07:00 evaluated
  through `isWithinQuietHours` for Tokyo/Lord Howe/Kolkata).

## TDD record (red verified for each)

- Store: 6 tests red before the adapter change — `store.touchLastSeen is not a function`
  ×5 and `expected 1577836800000 to be greater than 1577836800000` for the registration
  refresh (the column literally held its stale value).
- Domain: 2 tests red — `expected [] to deeply equal [ { userId: 'u1', token: 'tok-1' } ]`.
- Transports: 14 assertions red across the four adapter suites before `deliveredTokens`
  was populated.
- Integration (active-device refresh): red-verified by temporarily short-circuiting
  `touchDeliveredTokens` in `notify-event.ts` → the test failed; restored → green.
- Composite empty-fold test: red-verified by temporarily removing the `?? []` fallbacks
  → `TypeError: a.deliveredTokens is not iterable`; restored → green.
- workerd: red-verified by temporarily pinning `timeZone: 'UTC'` inside `quiet-hours.ts`
  → 5 of 6 tests failed (the runtime-identity test stayed green, as designed); restored
  → 6/6 green.

## Self-gate (all after the last edit)

| Check | Result |
| --- | --- |
| `pnpm run test:workers` (apps/api, real workerd) | **pass** — 1 file, 6/6 |
| notifications slice + `push-notify.test.ts` (vitest, incl. integration) | 371 passed, 7 failed — all 7 are the pre-existing external `template-html.test.ts` snapshot red (below) |
| `chat/routes.integration.test.ts` + `admin/customer-360.integration.test.ts` (the other `notifyEvent`/store consumers) | **pass** — 203/203 |
| `turbo typecheck --filter=@hushbox/api --force` | **pass** |
| `eslint` over owned files (run from `apps/api`, after the last edit) | **pass**, exit 0, clean |
| `prettier --check` on the non-eslint-covered new files (`vitest.workers.config.ts`, `package.json`, `knip.jsonc`) | **pass** |
| `pnpm arch:check` | **pass** — 11 rules over 1932 files |
| `jscpd --threshold 2` on owned files | **pass**, exit 0 — 1.6% lines (was 2.07% before the `NOTHING` inline; the repo-wide gate `pnpm lint:duplication` is 1.05%, exit 0) |
| `pnpm lint:unused` (knip) | back to the **pre-existing** baseline finding only (below) |
| gitleaks `detect --no-git` over the slice + the new workers-validation dir | **pass**, 0 findings |
| Coverage ≥95% per-file on owned files | **pass**, exit 0 — 100% stmts/lines/funcs, 99.18% branches; worst file `push-fcm.ts` 98.07% branches |

Coverage command (isolated report dir, owned files only):

```
npx vitest run --coverage --coverage.reportsDirectory=coverage-scoped \
  --exclude='**/template-html.test.ts' \
  --coverage.include='src/slices/notifications/adapters/device-token-store-db.ts' \
  --coverage.include='src/slices/notifications/adapters/push-{fcm,webpush,composite,mock}.ts' \
  --coverage.include='src/slices/notifications/domain/{notify-event,quiet-hours}.ts' \
  src/slices/notifications src/adapters/push-notify.test.ts
```

workerd command and output:

```
$ cd apps/api && pnpm run test:workers
> tsx ../../scripts/with-env.ts vitest run --config vitest.workers.config.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

### Attributed failures (not mine)

- `src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshot
  mismatches, every one the removal of a single
  `<link href="https://fonts.googleapis.com/css2?family=Merriweather…">` line from the
  shared email layout. `git status` shows `domain/templates/**` and its `__snapshots__`
  are byte-identical to HEAD, so nothing in this task produced the diff; it is the
  concurrent email-builder workstream's, and it was already reported in impl-report-1.
- `pnpm lint:unused` reports `Unused files (1): packages/config/vitest.package.config.ts`.
  Verified pre-existing: reproduced with my `apps/api/package.json` edits temporarily
  reverted, same single finding. My change added an
  `@cloudflare/vitest-pool-workers` unused-devDependency finding, which the `knip.jsonc`
  entry line resolves — knip is now back to exactly the baseline finding.
- `apps/api` full-package `pnpm test` aborted once with the known upstream Vitest
  `coverage/.tmp … ENOENT` crash (recorded in project memory as an unconfirmed Vitest
  bug with no fix). It is a runner crash, not a test failure; the scoped coverage run
  above is the substitute and it exits 0 against the same thresholds.

## Acceptance criteria (re-checked literally)

Only the criteria this fix touches are claimed; the rest stand from impl-report-1.

- **"Web Push 404/410 land in `deadTokens` and prune (integration test through the mock
  seam); `lastSeenAt` touched on successful registration and send."** — **met**, both
  halves, literally. Registration: the upsert conflict set writes `lastSeenAt: new Date()`
  (`device-token-store-db.ts`), pinned by the repeated-registration refresh test. Send:
  `notifyEvent` calls `touchLastSeen` with the sender's `deliveredTokens`, pinned by two
  unit tests, two store tests, and the real-store integration test that proves an active
  device's row is refreshed (and its negative twin). The 404/410 prune half is unchanged
  and still green.
- **"workerd Intl spike test pinning arbitrary IANA zone evaluation."** — **met**. The
  test executes inside workerd (asserted, not assumed) via the repo's existing
  vitest-pool-workers harness, evaluates America/New_York, Asia/Tokyo, Asia/Kolkata,
  Australia/Lord_Howe and UTC through the production `quiet-hours` module, and is wired
  into `apps/api`'s `test` script so CI runs it. impl-report-1's claim that the spike was
  "met" by an out-of-band `workerd test` invocation was wrong — nothing was pinned in CI;
  it is pinned now.

## Deviations (with reasons)

1. **Files outside Task 04's declared file list were edited**, each forced by a finding:
   - `apps/api/package.json` — a devDep + `test:workers` script are the only way to run a
     workerd project in this package; without the script CI does not run the pin, which
     is the whole point of the finding. Required `pnpm install --filter @hushbox/api`,
     which touches `pnpm-lock.yaml` (importer entry only; the package version is already
     in the lockfile for db/realtime — nothing was downloaded).
   - `apps/api/vitest.workers.config.ts` — new package-root config, same as
     `packages/{db,realtime}`.
   - `knip.jsonc` — one entry line; without it the new devDep fails `pnpm lint:unused`.
   - `apps/api/src/adapters/push-notify.test.ts` — its fake DB had no `update`, so the
     new touch threw there. Test-only.
   - `apps/api/src/slices/chat/routes.integration.test.ts` was **not** touched this round.
2. **`PushDelivery.deliveredTokens` is optional**, mirroring `deadTokens`. A sender that
   reports neither still folds correctly (pinned by the composite test); this keeps the
   port backward-compatible for any future transport that cannot enumerate successes.
3. **`push-composite.ts`'s `NOTHING` constant was inlined.** Widening the empty-delivery
   literal in both `push-composite.ts` and `push-webpush.ts` created a new 17-line/96-token
   jscpd clone (import block + constant) that pushed the owned-file duplication to 2.07%,
   over the threshold. Inlining the single use removed the clone (1.6%). No behavior change.

## Concerns and limitations

- **Stale comment outside my ownership.** `apps/api/src/slices/identity/ports/email.ts:6`
  says "mirroring how the notifications slice left PresenceReader/MembershipReader as
  unbound ports". `PresenceReader` no longer exists, so that reference is now dangling.
  It is an identity-slice file; I did not edit it. One-word fix
  (`PresenceReader/MembershipReader` → `MembershipReader`) for whoever owns it.
- **`lastSeenAt` advances only on accepted delivery, never on attempted delivery.** A
  device whose push service is transiently failing (429/500) for the whole retention
  window and that never re-registers will still age out. That is the deliberate reading
  of "successful … send"; a permanently unreachable subscription should age out, and a
  live one re-registers on app launch.
- **The touch is inside the notify Result chain**, so a `touchLastSeen` failure surfaces
  as a degraded-delivery error on an otherwise successful send. Consistent with how the
  dead-token prune already behaves, and the whole call is fire-and-forget (G2), so it
  cannot fail a domain transaction. Worth a second look if the orchestrator prefers the
  touch be fully non-blocking.
- **`apps/api`'s `test` script now runs two vitest invocations** (node project, then the
  workerd project), adding ~5s to the package's CI leg. Same shape as db/realtime.
- **Shared-file coordination:** `apps/api/package.json`, `pnpm-lock.yaml` and `knip.jsonc`
  are repo-level files other concurrent workstreams may touch; all three edits are additive.

## Confidence

**High.** Every finding is fixed at the level the audit named, each with a red-verified
test, and the two claims impl-report-1 got wrong are now literally true rather than
paraphrased: `lastSeenAt` is written by two code paths (proven against real Postgres rows,
including the active-device case Task 06 depends on), and the workerd pin executes in
workerd (proven by a runtime-identity assertion) inside CI. Medium only on the
out-of-ownership `package.json`/`knip.jsonc`/lockfile edits, raised for the orchestrator
to sequence.
