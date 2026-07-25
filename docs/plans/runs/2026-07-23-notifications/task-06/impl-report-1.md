# Task 06 — Dev push viewer + stale-device-token retention — implementation report 1

## Objective

A `/dev/push` capture viewer mirroring the existing `/dev/mailbox` + `withMailboxCapture`
email pattern, and a stale-`lastSeenAt` `device_tokens` retention delete on the daily cron
schedule. No delivery mechanism, no jobs rows.

## Files changed

| File | Why |
| --- | --- |
| `apps/api/src/slices/notifications/adapters/push-sender-factory.ts` | Capture layer (`CapturedPush`, module-level log, `withPushCapture`, `listCapturedPushes`) mirroring the email factory's mailbox capture; the dev/CI branch now wraps the mock transports the composite dispatches to. |
| `apps/api/src/slices/notifications/adapters/push-sender-factory.test.ts` | Capture unit tests (alias-stamped capture, per-partition capture, real transports never captured). |
| `apps/api/src/slices/notifications/adapters/device-token-retention.ts` | New: `DEVICE_TOKEN_STALE_DAYS` + `purgeStaleDeviceTokens` — the batched retention delete, in the owning slice's adapter (drizzle operators are adapter-only). |
| `apps/api/src/slices/notifications/adapters/device-token-retention.integration.test.ts` | New: retention behaviour against real Postgres. |
| `apps/api/src/slices/notifications/index.ts` | Barrel: `listCapturedPushes`, `purgeStaleDeviceTokens` (the slice barrel is the only public surface). |
| `apps/api/src/platform/dev/routes.ts` | `GET /dev/push`, `dev-only`-classed, next to the mailbox routes. |
| `apps/api/src/platform/dev/routes.integration.test.ts` | `/dev/push` integration tests. |
| `apps/api/src/scheduled.ts` | `stale-device-token-purge` entry on the daily retention cron. |
| `apps/api/src/scheduled.test.ts` | Daily-entry name list extended. |

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `createPushSenderFromEnv > captures every mock-delivered send with the composite-derived collapse alias` | A dev-mode send is recorded, and the recorded `collapseKey` equals the alias the collapse-alias deriver produces for that conversation id. | mock records the shape; alias tag available to the viewer |
| `createPushSenderFromEnv > captures each platform partition of a mixed send separately` | An ios+web send records two entries, one per platform partition. | recipient platform in the viewer |
| `createPushSenderFromEnv > captures nothing when the real transports are selected` | Production wiring never captures. | capture is a dev/CI-only path |
| `dev push routes > lists captured mock pushes with platform, category, alias tag and payload` | `GET /dev/push` returns the captured send with platform, owner, category, payload and a tag that is not the raw conversation id. | `/dev/push` lists captured sends |
| `dev push routes > never exposes a device token or subscription endpoint` | The response carries the conversation id but never the device token. | credential hygiene on a read route |
| `dev push routes > reports a conversation-less send as having no category, tag or payload` | A send with no data reports nulls rather than inventing values. | viewer shape completeness |
| `dev push routes > 404s in production (dev-only route class)` | The route is invisible in production. | dev-only classification |
| `purgeStaleDeviceTokens > deletes a device whose last-seen predates the retention window` | Stale rows go. | stale deleted |
| `purgeStaleDeviceTokens > keeps a device the delivery path refreshed` | A device aged past the window, then notified through `notifyEvent` over the real device-token store and the factory-built dev composite sender, has a refreshed `lastSeenAt` and survives the pass. | fresh kept, via the real delivery path |
| `purgeStaleDeviceTokens > keeps a device seen inside the retention window` | Rows inside the window stay. | fresh kept |
| `purgeStaleDeviceTokens > deletes no more than the batch size in one pass` | The pass is bounded. | batched retention delete |
| `cronEntriesFor > routes the daily schedule …` (extended) | `stale-device-token-purge` is wired into the daily retention cron in order. | retention entry wired into `scheduled.ts` |

Every test was watched fail first: the capture tests failed with `listCapturedPushes is not
a function`; the `/dev/push` tests failed with 404 (no route); the retention tests failed
with `Cannot find module './device-token-retention.js'`; the cron test failed on the
missing entry name in the ordered list.

## Self-gate

All values below are the FINAL runs, after the last edit.

| Command | Result |
| --- | --- |
| `eslint` over the 9 owned files (from `apps/api`) | pass — exit 0 |
| `npx eslint .` (apps/api, package-wide) | pass — exit 0 |
| `npx tsgo --noEmit` (apps/api) | pass — no output |
| `pnpm test` (apps/api, full) | fail — 7 failures, all `template-html.test.ts` snapshots (email workstream, known external red); 462 of 464 files pass, 6323 tests pass |
| `pnpm arch:check` | pass — "OK — 11 rule(s) over 1958 file(s)" |
| targeted per-file coverage (owned files) | `scheduled.ts` 100/100/100; `device-token-retention.ts` 100/100/100; `push-sender-factory.ts` 100/100/100; `platform/dev/routes.ts` L 98.59 / B 97.36 / F 98.96 |
| `gitleaks dir` over all 9 owned files with the repo config | pass — "no leaks found" (0 findings; the two dev collapse-alias secret strings do not fire) |

### Attribution

- The only remaining red is `template-html.test.ts`: 7 email-template snapshot mismatches
  (a removed Google-fonts `<link>` in the shared template head). No template file is touched
  by this task, and the run ledger already records this as the email workstream's.
- Earlier in this task, typecheck and package-wide lint were red with 3–12 errors in
  `src/adapters/push-notify.integration.test.ts` and `src/slices/conversations/**` — Task 05's
  event sources mid-edit (missing `createMembershipPushNotify` /
  `createRunCompletionPushNotify` / `ConversationEventNotification`). Those cleared on their
  own as that task landed its code; both gates are green in the final runs above. Recorded
  because an auditor sampling mid-run may see the same churn.
- `pnpm test` for this package chains `test:workers` after the node run; the node run's
  non-zero exit (the email snapshots) short-circuits it. No workerd-scoped file is touched
  by this task.

## Acceptance criteria

1. **`/dev/push` lists captured sends (recipient platform, category, alias tag, payload),
   dev-only-classed; integration tests incl. the existing dev-routes conventions — MET.**
   `GET /dev/push` sits beside `/dev/mailbox` in the same manifest, first handler
   `routeClass('dev-only')`, and returns `{sends:[{id, category, tag, title, body, payload,
   recipients:[{platform, userId}]}]}`. Tests assert the listed content, the alias tag ≠ the
   raw conversation id, and the production 404. Device tokens and subscription endpoints are
   deliberately omitted from the projection (they are credentials); a test pins that.
2. **Retention entry wired into `scheduled.ts` with tests (stale deleted, fresh kept) — MET.**
   `createRetentionEntry('stale-device-token-purge', …)` runs in the daily retention cron,
   between the deletion-events purge and the admin digest. `purgeStaleDeviceTokens` deletes
   `device_tokens` rows whose `lastSeenAt` is older than `DEVICE_TOKEN_STALE_DAYS` (180),
   in bounded batches, drained by the existing `drainRetentionBatches` cap. The "fresh kept"
   test ages a real row past the window, then drives `notifyEvent` over the real
   `createDeviceTokenStore` and the factory-built dev composite sender, asserts the
   resulting `lastSeenAt` is back inside the window, and shows the row surviving the pass.
   The pre-existing `scheduled.integration.test.ts` daily pass also runs the new entry
   against live Postgres without an entry failure.
3. **Mock webpush sender records the same shape the real one returns — MET (unchanged
   behaviour, now asserted through the composite).** The mock is the same
   `createMockPushSender` both partitions already used; it returns `PushDelivery`
   (`successCount` / `failureCount` / `deliveredTokens`) exactly as the real transports do,
   which is why the retention "fresh kept" case works end to end (delivery → `touchLastSeen`).
   No change was needed to the mock; the capture wrapper returns the mock's delivery
   untouched.

## Deviations with reasons

1. **The capture wraps the mock transports *inside* the composite, not the composite's
   outer entry.** The brief says the capture must wrap the mock composite sender so captures
   are alias-stamped and representative of production. The composite derives and stamps the
   collapse alias *inside* its own `send`, on the way down to the partitions
   (`push-composite.ts`: `deriveCollapseKey(conversationId)` → `fanOut(deps, {...message,
   collapseKey})`), so a wrapper on the composite's entry would only ever see unstamped
   messages and could not show the alias tag the criterion requires — and re-deriving the
   alias in the capture layer is forbidden (alias derivation is composite-only). Wiring:

   ```ts
   return createCompositePushSender({
     fcm: withPushCapture(createMockPushSender()),
     webPush: withPushCapture(createMockPushSender()),
     deriveCollapseKey,
   });
   ```

   Every captured send has therefore passed through `createCompositePushSender`; no raw
   `createWebPushSender` / `createFcmPushSender` transport is constructed or called anywhere
   in this task, and the composite remains the only construction site and the only alias
   stamper. A consequence worth knowing: one mixed-platform send produces one capture entry
   per platform partition (the composite dispatches per partition), which is also what makes
   "recipient platform" meaningful in the viewer.

2. **The retention delete lives in the notifications slice's adapters, not in
   `jobs/retention-entries.ts`.** `device_tokens` is notifications-owned (single writer;
   the arch registry agrees), and only adapters may import drizzle operators. `scheduled.ts`
   binds it inline through the shared `createRetentionEntry` helper, so the shared
   `createRetentionSteps` (outside this task's ownership) is untouched. The slice barrel
   gained one export line for it, and one for `listCapturedPushes` — the barrel is the only
   public surface, so those exports are unavoidable.

3. **`DEVICE_TOKEN_STALE_DAYS = 180`.** Rationale is stated at the constant: `lastSeenAt`
   advances on registration (each app launch) and on every successful delivery, so it stops
   advancing only once the app is gone or the subscription is revoked; half a year is far
   longer than any plausible gap between two of those signals for a live device, which keeps
   the delete off live rows, while the reactive dead-target prune remains the fast path.

## Concerns and limitations

- **Cross-test interaction (raised).** The pre-existing daily-pass integration tests in
  `scheduled.integration.test.ts` now *commit* a device-token retention delete against the
  shared local database. Task 04's `notify-event.integration.test.ts` backdates rows to 2020
  and then asserts on them, so a sufficiently unlucky interleaving could delete a row that
  test is mid-way through using. My own retention tests avoid this entirely by running the
  delete inside a rolled-back transaction, but I cannot apply the same treatment to another
  task's file. Both full-suite runs in this task were green on those tests; the risk is a
  low-probability flake, not an observed failure.
- **No index on `device_tokens.lastSeenAt`.** The daily pass does a filtered scan. Adding
  an index is a schema change (migration + founder approval) and is outside this task's
  ownership; the table is small and the pass is off any hot path, so this is a note, not a
  defect.
- Task 05 consumed `listCapturedPushes()` from the barrel while this task was in flight
  (its `push-notify.integration.test.ts` imports it as its delivery assertion). That export
  is now a cross-task dependency: changing its shape breaks that file. `PushMessage.data`
  stays optional as the port defines it; I did not widen it for that consumer.

## Confidence

**High** — every criterion is pinned by a test that was watched fail first; lint, typecheck,
arch:check, gitleaks and per-file coverage are all green after the last edit, and the one
remaining test red is reproducibly the email workstream's. The one judgement call is the placement of
the capture wrapper (deviation 1), which is documented above with the wiring quoted.
