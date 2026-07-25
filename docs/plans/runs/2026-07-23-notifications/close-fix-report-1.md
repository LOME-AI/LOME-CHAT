# Close-fix report 1 — Phase 4 close batch (4 findings)

## Objective

Fix the four validated Phase-4 findings for the notifications run: category-scoped actor
exclusion (F1), hoist the duplicated per-category copy into `packages/shared` (F2), surface
device permission state in the Notifications settings card (F3), and repoint a run-artifact
reference in a shipped source comment (F4). The two reserved design decisions (Android
clearing / SW focused-client posting) were not touched: `apps/web/src/sw/handlers.ts`'s
focused-client logic, the Android notification tag, and `push-fcm.ts`'s tag/collapse fields
are byte-unchanged apart from `handlers.ts`'s import line.

## Files changed

| Path                                                              | Why                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/api/src/slices/notifications/domain/notify-decision.ts`     | F1: actor exclusion becomes a per-category table; `runCompletion` no longer drops actor |
| `apps/api/src/slices/notifications/domain/notify-decision.test.ts`| F1: split actor tests per category; solo-conversation + still-present cases             |
| `apps/api/src/adapters/push-notify.integration.test.ts`           | F1: solo-conversation integration proof over real stores                                |
| `apps/api/src/adapters/push-notify.test.ts`                       | F1: suppression test now suppresses the requester by PRESENCE, not by being actor; F2 import drop |
| `packages/shared/src/notifications/index.ts`                      | F2: the one copy table + `notificationCopyForCategory`                                  |
| `packages/shared/src/notifications/index.test.ts`                 | F2: copy tests, incl. the literal string pin and barrel re-export                       |
| `apps/api/src/slices/notifications/domain/notify-event.ts`        | F2: deletes `CATEGORY_COPY`, resolves copy from the shared table                        |
| `apps/api/src/slices/notifications/domain/notify-event.test.ts`   | F2: asserts the send carries the shared copy (title AND body)                           |
| `apps/api/src/slices/notifications/domain/index.ts`               | F2: drop the `CATEGORY_COPY` export                                                     |
| `apps/api/src/slices/notifications/index.ts`                      | F2: drop the `CATEGORY_COPY` barrel export                                              |
| `apps/web/src/sw/notification-copy.ts` (DELETED)                  | F2: the second copy table                                                               |
| `apps/web/src/sw/notification-copy.test.ts` (DELETED)             | F2: its tests, carried into the shared package's test                                   |
| `apps/web/src/sw/handlers.ts`                                     | F2: import line only — `notificationCopyForCategory` now from `@hushbox/shared`         |
| `apps/web/src/sw/handlers.test.ts`                                | F2: import line only                                                                    |
| `apps/web/src/components/settings/notifications-card.tsx`         | F3: device permission state, ask affordance, honest denied/unsupported messages         |
| `apps/web/src/components/settings/notifications-card.test.tsx`    | F3: 10 tests over `default` / `granted` / `denied` / `unsupported` / unknown            |
| `apps/web/ios/App/App/GoogleService-Info.plist`                   | F4: comment repointed at `docs/NOTIFICATIONS.md`                                        |
| `docs/NOTIFICATIONS.md`                                           | F1: the Actor row said the opposite of the fixed behavior (doc-lifecycle rule)          |

## Tests added

| Test                                                                                    | Behavior                                                    | Criterion |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------- |
| `notify-decision` — excludes the actor from a message they sent                          | actor exclusion still holds for `message`                    | F1        |
| `notify-decision` — excludes the actor from a membership change they made                | actor exclusion still holds for `membership`                 | F1        |
| `notify-decision` — notifies the actor when the run they started completes                | requester survives alongside other members                   | F1        |
| `notify-decision` — notifies the sole member of a solo conversation when their run completes | the case the whole feature exists for                    | F1        |
| `notify-decision` — still suppresses the actor of a completed run while they are watching it | presence still wins; no spam at the screen                | F1        |
| `push-notify.integration` — notifies the requester in a solo conversation                 | end-to-end over real stores, actor is the only member        | F1        |
| `shared/notifications` — resolves the fixed copy for every category                       | lookup function                                              | F2        |
| `shared/notifications` — gives every category a non-empty title and body                  | no blank notification                                        | F2        |
| `shared/notifications` — defines exactly one entry per known category                     | table is total over the closed set                           | F2        |
| `shared/notifications` — states the words a delivered notification carries                | literal pin of all six strings                               | F2        |
| `shared/notifications` — package barrel re-exports the notification copy                  | both call sites import the same object                       | F2        |
| `notify-event` — sends per-category copy (title AND body assert)                          | the worker sends the shared copy                             | F2        |
| `notifications-card` — confirms the device is allowed to show notifications               | `granted`                                                    | F3        |
| `notifications-card` — offers to ask a device that has not been asked yet                 | `default` shows the button                                   | F3        |
| `notifications-card` — asks the device for permission from the card                       | the route back through the facade                            | F3        |
| `notifications-card` — drops the offer once the device grants permission                  | state refreshes after the grant                              | F3        |
| `notifications-card` — says a blocked device will not be asked again                      | `denied`, no false affordance                                | F3        |
| `notifications-card` — says a device with no push path cannot show notifications          | `unsupported`                                                | F3        |
| `notifications-card` — admits the device still blocks delivery after the account switch goes on | the "switch reports success over a denied device" bug   | F3        |
| `notifications-card` — says nothing while the device state is still unknown               | `null` renders nothing, never a guess                        | F3        |
| `notifications-card` — keeps the last known state when the platform cannot be read        | unreadable facade is not an answer                           | F3        |
| `notifications-card` — re-reads the device when a permission request throws               | grant-lands-registration-fails is re-read, not assumed       | F3        |

Every one was watched RED first. The two integration-level RED verifications used a
temporary inversion of `EXCLUDES_ACTOR.runCompletion` (restored immediately; see
Self-gate). No test was weakened; no `eslint-disable`, `any`, or `@ts-ignore` was added.

## Self-gate

| Command                                                                                     | Result | Notes |
| --------------------------------------------------------------------------------------------- | -------- | ------- |
| `npx turbo lint --filter=@hushbox/web --filter=@hushbox/api --filter=@hushbox/shared --force` | **exit 0 at 00:11**, then **exit 1 at 00:28** | The 00:11 run was green on all three packages with every change of this batch in place except a 2-line edit to `push-notify.test.ts`. The 00:28 re-run's 9 errors are ALL in documents-workstream files a concurrent agent edited between the two runs: `markdown-renderer.test.tsx`, `document-panel.streaming-preview.test.tsx`, `document-sandbox.tsx` — none in this batch's change set. Scoped confirmation from `apps/web/`: `npx eslint src/components/settings/notifications-card.tsx src/components/settings/notifications-card.test.tsx src/sw/handlers.ts src/sw/handlers.test.ts` → exit 0. api + shared green in both runs. |
| `npx turbo typecheck --filter=@hushbox/web --filter=@hushbox/api --filter=@hushbox/shared --force` | pass — exit 0, 3/3 tasks (re-run after the LAST edit) | |
| `pnpm test:shared`                                                                          | pass — exit 0, 107 files / 2399 tests, coverage gate green | `src/notifications/index.test.ts` 16 tests |
| `pnpm test:api`                                                                             | 7 failed / 6327 passed — all 7 pre-declared external | Every failure is `template-html.test.ts` snapshot drift (billing workstream via `@hushbox/shared` money.ts), pre-declared in the brief. All notification suites green: `push-notify.integration` 7, `notify-event.integration` 8, `notify-event` 10, `notify-decision` 19, `push-notify` 6. |
| `pnpm test:web`                                                                             | 72 failed / 6354 passed — all 72 external | 4 files, all documents workstream: `document-parser.test.ts`, `document-card.test.tsx`, `document-panel.test.tsx`, `markdown-renderer.test.tsx`. Root cause is `TypeError: endsInsideOpenFence is not a function` — `apps/web/src/lib/document-parser.ts` does not define it (verified by grep); a concurrent agent is mid-TDD. All notification suites green: `notifications-card` 39, `handlers` 16, `web-adapter` 23, `native-adapter` 15, `channel` 2, `use-enable-prompt` 14, `enable-prompt` 7, `register-listeners` 3. |
| Per-file coverage on owned files                                                            | pass | `notifications-card.tsx` 68/68 stmts, 28/28 fns, 18/18 branches · `sw/handlers.ts` 38/38, 6/6, 18/18 · `notify-decision.ts` 21/21, 4/4, 20/20 · `notify-event.ts` 33/33, 18/18, 16/16 · `adapters/push-notify.ts` 13/13, 9/9, 2/2 — 100% on all five |
| `npx prettier --check docs/NOTIFICATIONS.md`                                                | pass | table realigned after the Actor-row edit |

### First `pnpm test:api` run — 27 failures, stale Vite cache (not a code defect)

The first full API run after the F2 hoist failed 27 tests with
`TypeError: notificationCopyForCategory is not a function` at `notify-event.ts:114`. Cause:
vitest's SSR dep-optimizer had `@hushbox/shared` prebundled at
`apps/api/node_modules/.vite/vitest/*/deps_ssr/@hushbox_shared.js`, and that prebundle
predated the new export (grep for the symbol in those files: no hits). Vite hashes a linked
workspace dep's `package.json`/lockfile, not its source, so adding an export does not
invalidate the cache. Removing `apps/{api,web}/node_modules/.vite` and
`packages/shared/node_modules/.vite` cleared it and every one of the 27 passed. CI starts
cold and is unaffected — but any local agent adding an export to `packages/shared` will hit
this, which is worth knowing.

## Acceptance criteria

**F1 — category-scoped actor exclusion — MET.**

```diff
+const EXCLUDES_ACTOR: Readonly<Record<NotificationCategory, boolean>> = {
+  message: true,
+  runCompletion: false,
+  membership: true,
+};
...
-      if (member.userId === params.actorUserId) return false;
+      if (excludesActor && member.userId === params.actorUserId) return false;
```

A `Record<NotificationCategory, boolean>` rather than a set, so adding a fourth category
forces a compile-time decision about the actor rather than defaulting silently.

Evidence the requester IS notified in a solo conversation (integration, real stores):
`push-notify.integration.test.ts` — the actor is the sole member, holds the only device
token, and `pushesFor(conversationId)` returns
`[{ category: 'runCompletion', tokens: [<actor token>] }]`. Verified RED before the fix
(`expected [] to deeply equal [{…}]`) by temporarily inverting the table.

Evidence actor exclusion still holds: `notify-decision.test.ts` "excludes the actor from a
message they sent" and "excludes the actor from a membership change they made" both return
only the non-actor; `push-notify.integration.test.ts`'s membership cases still exclude the
actor and were unchanged. Presence still wins over the new rule: "still suppresses the actor
of a completed run while they are watching it" returns `[]`.

One existing test's premise died with the finding:
`push-notify.test.ts > never looks up tokens when every member is suppressed` seated
`sender-1` as an unsuppressed member and relied on actor-suppression to reach zero
survivors. It now suppresses `sender-1` by PRESENCE instead (`presentUserIds:
['present-member', 'sender-1']`), which keeps the behavior under test — no survivors means
no token lookup — without asserting the behavior the finding reverses.

**F2 — one copy table — MET.** The shared table is at
`packages/shared/src/notifications/index.ts` (`NOTIFICATION_COPY` +
`notificationCopyForCategory` + the `NotificationCopy` type), re-exported by the package
barrel.

- API call site: `notify-event.ts` lost its `CATEGORY_COPY` const entirely and now does
  `const copy = notificationCopyForCategory(input.category);`. The slice's `domain/index.ts`
  and `index.ts` barrels dropped the `CATEGORY_COPY` export. `grep -rn "CATEGORY_COPY"` over
  `apps/api/src apps/web/src packages e2e` → no hits.
- Web call site: `apps/web/src/sw/notification-copy.ts` and its test are DELETED;
  `handlers.ts` imports `notificationCopyForCategory` from `@hushbox/shared` alongside the
  schemas it already imported from there (so no new bundle surface for the SW — it already
  pulls runtime values from that specifier).
- Strings chosen: the web-side wording for all three, because the API set repeated "in a
  conversation" three times (filler) while the web set is direct and reads as one voice.
  Titles were already identical in both tables; only bodies differed.
- E2E oracle: `e2e/notifications/push-harness.ts` keeps its independent copy (deliberately —
  importing the shared table would make its assertion tautological). Its expected values
  needed NO change: they already carried the web wording, so they now match the single table
  exactly. Verified mechanically — all three categories report MATCH against the shared
  table's literals.

**F3 — device permission surfaced — MET.** `notifications-card.tsx` gains
`useDevicePermission()` (reads `notificationChannel.getPermissionState()` on mount, exposes
`ask()` over `requestPermissionAndRegister()` and a `refresh()`), and a `DevicePermission`
block rendered in the card. `PERMISSION_MESSAGE` covers all four `PushPermissionState`
values; the "Allow notifications" button renders only for `default`, so a denied device is
never given a control that cannot work. `denied` reads: "This device is blocking
notifications and will not ask again. Turn them on in your notification settings for
HushBox." The block is `aria-live="polite"` (deliberately NOT `role="status"` — the app
shell already has two such regions and the run's standing amendment warns about selecting
them).

The "global switch reports success over a dead device" hole is closed in `handleSave`: the
device call's `finally` calls `refreshPermission()`, so saving `globalEnabled: true` against
a denied browser immediately renders the blocked message instead of a silent success. Pinned
by "admits the device still blocks delivery after the account switch goes on". No permission
logic was re-implemented — everything goes through the existing facade (G3).

**F4 — plist comment — MET.**

```diff
-  replace this file on the release build. See the notifications doctrine and the
-  Task report's production checklist.
+  replace this file on the release build. See docs/NOTIFICATIONS.md.
```

`grep -rn "Task report\|task report"` over the plist → no hits. No plan/task-ID labels were
introduced anywhere in this batch (G11).

## Deviations

- **`docs/NOTIFICATIONS.md` edited (one table row).** Not named in the brief, but F1 makes
  its Actor row ("You are never notified of your own action") a wrong statement about
  current behavior, and both the doc-lifecycle rule and G10 (which lists this file as
  writable in this run) point the same way. New text: "Dropped for `message` and
  `membership`; a `runCompletion` notifies its requester". No other doc line touched.
- **One existing test's setup changed** (`push-notify.test.ts`, described under F1). Its
  assertion is unchanged; only the mechanism by which its members are suppressed moved from
  actor-suppression to presence.
- **A test deleted from `push-notify.test.ts`**: "uses fixed, content-free copy for the
  run-completion category" asserted the two literal strings of the now-moved table and
  exercised no `push-notify.ts` code. Its literal pin is carried, strengthened to all six
  strings, in the shared package's test; the api side now asserts something stronger instead
  (`notify-event.test.ts` checks the SEND carries the shared title AND body).

## Concerns and limitations

- **The `runCompletion` body reads possessively.** "Your response is ready to view." is the
  better-reading half of that pair and is correct for the requester — who, after F1, is the
  primary recipient. It is slightly off for a co-member of a shared conversation who did not
  start the run. Choosing it also left the E2E oracle unchanged, which is the lower-risk
  path. If the founder prefers strict neutrality, the fix is one string in
  `packages/shared/src/notifications/index.ts` plus the two literal expectations (shared test
  + E2E harness) — but note "A response is ready in a conversation." was the other option and
  is clunkier.
- **`test:api` and `test:web` are not fully green**, entirely because of two other
  workstreams (see Self-gate). `test:web`'s reds are a mid-TDD state in the documents
  workstream (a test importing a function that does not exist yet), so they will resolve
  without action here; the `template-html` snapshot reds were pre-declared in the brief.
- **`apps/web/dist/sw.js` still contains the old inline copy table.** It is a committed build
  artifact, regenerated on the next build; not edited here.
- **Stale-Vite-cache trap** documented under Self-gate — a repo-wide hazard for anyone adding
  a `packages/shared` export, not specific to this batch.

## Confidence

**High.** Every behavior change was watched RED first (including both integration-level ones,
via a temporary and restored inversion), every owned file is at 100% per-file coverage,
typecheck is exit 0 across all three packages, and every remaining red in api/web is
attributed by file to a concurrent workstream with the failing symbol verified absent from
source. The one judgment call — which of the two `runCompletion` bodies to keep — is flagged
above and is a one-string reversal.
