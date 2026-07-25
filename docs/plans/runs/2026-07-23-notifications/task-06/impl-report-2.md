# Task 06 — audit-fix pass — implementation report 2

## Objective

Two validated audit findings:

1. **[Important]** The daily cron's committed, unscoped `DELETE FROM device_tokens
   WHERE last_seen_at < now() - 180 days` runs against the shared local Postgres from
   `scheduled.integration.test.ts`, while four integration files hold committed rows
   inside that delete window and assert on them. Vitest runs those files in parallel
   forks against one database, so the collision is real.
2. **[Minor]** `push-mock.ts` returned `{successCount, failureCount, deliveredTokens}`
   while both real transports also return `deadTokens: []` — the criterion "mock records
   the same shape the real one returns" did not hold literally at the transport seam.

No assertion weakened; no parallelism disabled; no retries added.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/notifications/adapters/push-mock.ts` | Returns `deadTokens: []`, so dev/CI sees the same delivery shape production returns. |
| `apps/api/src/slices/notifications/adapters/push-mock.test.ts` | Shape assertion extended to require `deadTokens: []` (written first, watched fail). |
| `apps/api/src/slices/notifications/adapters/device-token-retention.integration.test.ts` | The two cases that do not need the committed delivery path now seed their aged fixtures inside the rolled-back transaction, so no row past the retention window is ever committed by this file. |
| `apps/api/src/slices/notifications/adapters/device-token-store-db.integration.test.ts` | **Task 04 file, cross-file portion of finding 1 explicitly routed to this task.** Fixture date only: `STALE_LAST_SEEN` moved inside the retention window. |
| `apps/api/src/slices/notifications/domain/notify-event.integration.test.ts` | **Task 04 file.** Same fixture-date change, plus one `deadTokens: []` expectation forced by the finding-2 mock change (see Deviations). |

## Finding 1 — evidence

### (a) Task-04 fixture dates, with assertions proven unchanged

Both files carried the identical construct. Change is the constant's **value** plus a
comment recording the durable constraint; every use site is byte-identical.

`device-token-store-db.integration.test.ts`

```
before (:55)  const STALE_LAST_SEEN = new Date('2020-01-01T00:00:00Z');
after  (:61)  const STALE_LAST_SEEN = new Date(Date.now() - 60 * 60 * 1000);
```

`notify-event.integration.test.ts`

```
before (:54)  const STALE_LAST_SEEN = new Date('2020-01-01T00:00:00Z');
after  (:60)  const STALE_LAST_SEEN = new Date(Date.now() - 60 * 60 * 1000);
```

Each gained a comment above it stating why the value must stay inside the retention
window — without it a future reader restores a fixed epoch date and reopens the hazard.

**Assertion lines — before / after (text identical, offset by the 6 comment lines):**

`device-token-store-db.integration.test.ts`

| before | after | line |
| --- | --- | --- |
| `expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());` | *(unchanged)* | 126 → 132 |
| `expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());` | *(unchanged)* | 151 → 157 |
| `expect(await lastSeenAt(untouched)).toEqual(STALE_LAST_SEEN);` | *(unchanged)* | 166 → 172 |
| `expect(await lastSeenAt(token)).toEqual(STALE_LAST_SEEN);` | *(unchanged)* | 179 → 185 |

`notify-event.integration.test.ts`

| before | after | line |
| --- | --- | --- |
| `expect(refreshed.getTime()).toBeGreaterThan(STALE_LAST_SEEN.getTime());` | *(unchanged)* | 273 → 279 |
| `expect(await lastSeenAt(unreachedToken)).toEqual(STALE_LAST_SEEN);` | *(unchanged)* | 300 → 306 |

What each still proves is unchanged: `toBeGreaterThan` still proves an actively-delivered
(or re-registered) device's `lastSeenAt` was refreshed — `now()` is strictly greater than
a value minted an hour before module load, exactly as it was strictly greater than 2020;
`toEqual` still proves an unreached device's `lastSeenAt` was **not** touched, byte-equal
to the seeded value. Nothing about "older than now" was relaxed; only the row's distance
from the delete's `now() - 180 days` boundary changed, moving it from inside the delete's
reach to far outside it.

### (b) This task's retention test — aged fixtures moved into the rollback

New helper, and `age()` refactored onto a shared `agedAt()` so the date math lives once:

```ts
/**
 * Seeds an aged device inside the caller's transaction, so it never reaches a
 * commit. The daily cron runs this same delete committed against the shared
 * local database, and a committed row past the retention window is deletable
 * from under whichever test is holding it.
 */
async function seedAgedToken(tx: DbTransaction, token: string, days: number): Promise<void> {
  const [row] = await tx.insert(users).values(newUserValues()).returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  await tx
    .insert(deviceTokensTable)
    .values({ userId: row.id, token, platform: 'ios', lastSeenAt: agedAt(days) });
}
```

`deletes a device whose last-seen predates the retention window` — was: commit user +
token via `createUserWithToken`, commit `age(token, STALE_DAYS + 1)`, then purge inside
the rollback. Now the seed happens inside the same rollback as the purge; the assertion
`expect(stillThere).toBe(false)` is untouched.

`deletes no more than the batch size in one pass` — same move for both fixtures; the
assertion `expect(deleted).toBe(1)` is untouched.

Not moved, deliberately:
- `keeps a device the delivery path refreshed` — needs the real committed delivery path
  (`notifyEvent` over the real store and the factory-built dev composite). Its committed
  window past the retention boundary is now milliseconds wide, between `age()` and the
  `touchLastSeen` the delivery drives.
- `keeps a device seen inside the retention window` — its row is aged `STALE_DAYS - 1`,
  i.e. already inside the window and outside the delete's reach; committing it is safe.

**Mutation probe** (temporarily seeded at `STALE_DAYS - 1` instead of `+ 1`): the test
failed with `expected true to be false` at the `expect(stillThere).toBe(false)` line —
proving the in-transaction fixture, not some incidental row, is what the delete is
catching, and that the window boundary is genuinely exercised. Reverted immediately.

## Finding 2 — evidence

RED first: `push-mock.test.ts` shape assertion gained `deadTokens: []`, then failed with

```
- Expected
+ Received
@@ -1,7 +1,6 @@
  {
-   "deadTokens": [],
    "deliveredTokens": [ …
```

GREEN: `push-mock.ts` now returns `deadTokens: []`, with a comment recording why the
empty array must be present rather than omitted.

The composite's `deadTokens ?? []` undefined arm is still exercised — by the explicit
bare-partition stub in `push-composite.test.ts` ("folds a partition that reports neither
delivered nor dead targets").

## Self-gate

Run from `apps/api` unless noted, all after the final edit.

| Command | Result |
| --- | --- |
| `npx eslint <the 5 changed files>` | pass — exit 0 |
| `npx eslint .` (package-wide) | pass — exit 0 |
| `npx tsgo --noEmit` | pass — exit 0, no output |
| `pnpm test:api` (repo root, full scoped suite + coverage gate) | 462 files passed / 1 failed / 1 skipped (464); 6323 tests passed / 7 failed / 2 skipped. The 7 are `template-html.test.ts` — see Attribution. No coverage-threshold breach reported. |
| `pnpm arch:check` | pass — "OK — 11 rule(s) over 1959 file(s)" |
| `pnpm gitleaks dir` over the 5 changed files | pass — "no leaks found" |
| The four affected integration files + `push-mock.test.ts`, run together | pass — 5 files, 39 tests |

### Repeated-run collision probe

`device-token-retention.integration.test.ts`, `device-token-store-db.integration.test.ts`,
`notify-event.integration.test.ts` and `scheduled.integration.test.ts` run together in one
vitest invocation at `--retry=0`, eight consecutive times:

```
run 1..8:  Test Files  4 passed (4)   Tests  35 passed (35)
```

8/8 clean, zero collisions. This is the hazard configuration: neither the api vitest
config nor the shared config sets `fileParallelism: false` or pins workers, so the four
files execute in parallel forks against the one local database — the same arrangement the
finding described.

### Attribution

- The only red is `template-html.test.ts` (7 email-template snapshot mismatches, plus 9
  obsolete snapshots). Reproduced in isolation; every diff is the single removed
  `<link href="https://fonts.googleapis.com/css2?family=Merriweather…">` line in the
  shared email template head. No file I touched is in that path; the identical failure is
  recorded in `impl-report-1` and in the run ledger as the email workstream's.
- The **first** `pnpm test:api` invocation aborted before its summary with
  `Error: Something removed the coverage directory "apps/api/coverage/.tmp"` →
  `ENOENT coverage-101.json`. Vitest's own message names the cause: two vitest runs
  sharing one `coverage.reportsDirectory`. Concurrent agents are active in this
  checkout. It did not reproduce on the re-run, which completed with the counts above.
  Not attributable to any change in this pass — no changed file participates in coverage
  reporting.

## Acceptance criteria

Criteria 1 and 2 were met in report 1 and are unaffected here; both files' tests still
pass in the runs above. Restating the third literally:

3. **"Mock webpush sender records the same shape real one returns" — MET.**
   Previously met only in the loose sense (`deadTokens` is optional on `PushDelivery`, so
   omitting it typechecked). It now holds literally at the transport seam:
   `push-mock.ts` returns `{successCount, failureCount, deliveredTokens, deadTokens}`,
   the same four keys `push-webpush.ts` and `push-fcm.ts` return, pinned by
   `push-mock.test.ts` > "reports every token as delivered".

## Deviations with reasons

1. **I edited `notify-event.integration.test.ts` beyond the fixture date** — one added
   `deadTokens: []` line in the expectation at `:133`. That file `toEqual`s the mock
   sender's full delivery result, so finding 2's mock change made it fail. This is
   finding 2's cross-file fallout; the brief authorized Task-04 edits for finding 1 only,
   so I am flagging it explicitly. It strengthens rather than weakens the assertion (the
   expected object now requires one more key), and it was the minimum needed to keep the
   file green. **Raised.**
2. **I added a comment above each moved constant** in the two Task-04 files. Strictly the
   brief said fixture date only. Without it, the value reads as arbitrary and the next
   reader restores a fixed date, reopening exactly the hazard being closed — the
   hidden-coupling case CODE-RULES names as comment-worthy. One comment per file, no
   other text touched.
3. **`newUserValues()` / `agedAt()` extracted** in this task's own retention test. Purely
   to avoid a second copy of the user-insert literal and the day-math when the new
   in-transaction seeder landed beside the existing committed one.

## Concerns and limitations

- **One committed exposure remains, by design.** `keeps a device the delivery path
  refreshed` must commit a row aged past the window because the criterion demands the
  real delivery path refresh it. The window is now milliseconds rather than the whole
  test file's lifetime. Closing it entirely would mean running `notifyEvent` and its
  stores inside a transaction, which the port surface does not accept — that would be a
  port change, outside this task.
- **`push-mock.ts` coverage was not separately re-measured.** The targeted
  `--coverage.include` invocations I tried returned an empty table under the multi-project
  config, and I did not want to spend a second full-suite run on it. The change is one
  property inside an already-covered `return`, adding no branch and no function, and the
  full `pnpm test:api` run (which carries the per-file gate) reported no threshold breach.
- The two Task-04 files now depend on the retention window being much larger than one
  hour. If `DEVICE_TOKEN_STALE_DAYS` were ever reduced to under an hour the fixtures would
  re-enter the delete's reach — not a realistic value for a device-liveness window, and
  the comments state the constraint.

## Confidence

**High** — the mock change followed red-green with the failure watched and quoted; the
fixture moves are proven by an 8/8 repeated parallel-fork probe plus a mutation probe
showing the relocated fixture still drives the outcome; every assertion is quoted
before/after as unchanged; lint, typecheck, arch:check and gitleaks are all green after
the last edit, with the one remaining suite red reproduced in isolation and attributed to
the email workstream.
