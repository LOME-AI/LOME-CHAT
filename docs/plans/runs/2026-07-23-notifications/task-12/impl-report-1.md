# Task 12 — impl report 1

## Objective

Rewrite `mobile-tests/flows/07-push-notification-prompt.yaml` for the one-time in-app
notification offer (it pinned the ask-on-mount behavior that was removed, so it asserted
behavior that no longer exists), and add an Enable → OS-permission-dialog → grant flow.
Report the outcome of the optional broadcast-simulated-FCM-delivery spike.

## Files changed

| File                                              | Why                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mobile-tests/flows/07-push-notification-prompt.yaml` | Rewritten: asserts no OS dialog at launch, the in-app callout, and that "Later" sticks     |
| `mobile-tests/flows/15-notification-enable-grant.yaml` | New: Enable tap raises the OS dialog, granting it retires the callout                      |

No TypeScript changed. `mobile-tests/config.ts` needed no edit: `fullFlowsExcludingOta()`
in `scripts/mobile-test.ts` discovers flows by reading `mobile-tests/flows` and partitions
them across `SHARDS` by weight, so a new `.yaml` registers itself.

## The inversion in flow 07 (before → after)

Before — the flow asserted the system dialog appears at launch:

```yaml
name: Push notification permission dialog appears
- launchApp:
    clearState: true
    permissions: { notifications: unset }
- extendedWaitUntil: { visible: 'Allow', timeout: 45000 }   # system dialog expected
- tapOn: 'Allow'
```

After — the same launch condition, opposite expectation, plus what replaced it:

```yaml
name: Notification permission is never asked at launch and the in-app offer is one-time
- launchApp: { clearState: true, permissions: { notifications: unset } }
- extendedWaitUntil: { visible: 'Sign up', timeout: 45000 }
- waitForAnimationToEnd: { timeout: 5000 }
- assertNotVisible: 'Allow'                       # no OS dialog at launch
  ... log in ...
- assertNotVisible: 'Allow'                       # nor when the authenticated shell mounts
- extendedWaitUntil: { visible: '.*Turn on notifications.*', timeout: 15000 }
- assertVisible: 'Enable'
- assertVisible: 'Later'
- tapOn: 'Later'
- assertNotVisible: 'Enable'
  ... relaunch (state kept, permission re-declared unset), log in again ...
- assertNotVisible: '.*Turn on notifications.*'   # the answer stuck on this device
```

Two design points worth recording:

- **The flow logs in.** The callout renders inside the authenticated shell and its
  eligibility reads account notification preferences, so an unauthenticated launch can
  never show it. The login steps copy `10-core-user-flow.yaml` verbatim (same seeded
  `tmu` persona, same 3-char-username reasoning), which is the established convention —
  `14-document-renders.yaml` inlines the same block rather than sharing a subflow.
- **The `Allow` absences are guarded against vacuity.** Each is preceded by a settle
  (`waitForAnimationToEnd`) so a slow emulator cannot pass the assertion by racing it,
  and both moments where a mount-time request could fire (app launch, authenticated
  shell mount) are covered.

Selectors: there are no `TEST_IDS` entries for the callout and literal `data-testid` is
lint-banned, so it is addressed by its accessible button names (`Enable`, `Later`) and by
its copy. The copy is matched as `.*Turn on notifications.*` because the paragraph wraps
across nodes in the view hierarchy; the button labels are matched exactly and are unique
in the app (`Enable` appears nowhere else; the only other `Later` is the trial signup
modal's "Maybe Later", which never renders on the authenticated chat page).

## Flow 15 — Enable → OS dialog → grant

`clearState` launch with the permission unset → log in → callout visible →
`assertNotVisible: 'Allow'` (so the next step cannot be satisfied by a dialog that was
already up) → `tapOn: 'Enable'` → `extendedWaitUntil visible 'Allow'` → `tapOn: 'Allow'`
→ `extendedWaitUntil notVisible` the callout (registration runs behind the grant) →
`Enable`/`Later` gone.

## Self-gate

| Command                                                                          | Result                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npx vitest run scripts/mobile-test.test.ts`                                       | pass — 1 file, 144 tests (flow discovery + sharding over the real flow dir, new file included) |
| `npx prettier --check mobile-tests/flows/07-…yaml mobile-tests/flows/15-…yaml`      | pass — "All matched files use Prettier code style"            |
| js-yaml `loadAll` over all 15 flow files                                           | pass — every flow parses as header + step list; `name:` values unique (the harness maps failures back to paths by `name`) |
| Real emulator run #1 — both flows, `maestro test --device localhost:5555`          | **2/2 Flows Passed in 2m 17s** (flow 07 1m31s, flow 15 46s)   |
| Real emulator run #2 — same, later, under host contention                          | **2/2 Flows Passed in 5m 09s** (flow 07 4m17s, flow 15 52s)   |
| `pnpm typecheck`                                                                   | not applicable — no TypeScript touched                        |

Both emulator runs invoked `maestro test` **once** with no retry wrapper, so the two
consecutive greens are retries=0 results. The runs used the real harness functions
(`startEmulators`, `installApks`, `configureAllAppLinks`, `resetVersionOverride`,
budtmo `emulator_14.0` container, Android 14) driven from a scratchpad script that runs
only these two flows; `--smoke` could not be used because the smoke list is flows 01–03.

### What it took to run anything at all (two pre-existing blockers, not this task's)

1. **`npx cap sync android` is broken repo-wide.** The Capacitor CLI (8.4.0) evaluates
   `apps/web/capacitor.config.ts` through a CJS TS hook; the config imports
   `@hushbox/shared`, whose barrel uses ESM `./constants.js` specifiers the hook cannot
   resolve:
   `Parsing capacitor.config.ts failed. Error: Cannot find module './constants.js'`
   (require stack: `packages/shared/src/index.ts` ← `apps/web/capacitor.config.ts`).
   `buildApk()` calls `cap sync`, so `pnpm mobile:test` — and CI's mobile job — currently
   dies before the APK exists. Reproduced directly with `npx cap sync android`.
2. **The committed Gradle project paths are stale.** `apps/web/android/capacitor.settings.gradle`
   points at `node_modules/.pnpm/@capacitor+android@8.2.0_@capacitor+core@8.2.0/…` and
   seven sibling plugin paths; the installed versions are `@capacitor+android@8.4.0_…`
   etc. after dependency bumps, so Gradle resolves eight empty projects and fails with
   `No matching variant of project :capacitor-android was found … No variants exist.`
   Those files are regenerated by `cap sync`, i.e. same root cause as (1).

Neither file is in this task's ownership, so neither was fixed. To get a real run I
worked around both **outside the repo**: the driver replicated `cap copy` by copying
`apps/web/dist` into `apps/web/android/app/src/main/assets/public` (both that directory
and `capacitor.config.json` are git-ignored, and the already-synced
`capacitor.config.json` / `capacitor.plugins.json` match the current `capacitor.config.ts`
exactly, including the PushNotifications plugin), and eight symlinks were created in
`node_modules/.pnpm` aliasing the stale path names to the installed ones. **Those symlinks
are still in place** so the run is reproducible; they are install state, not repo content.
Remove with `rm` on the eight `@capacitor+*@…_@capacitor+core@8.2.0` /
`@capgo+capacitor-updater@8.43.10_…` symlinks under `node_modules/.pnpm` if they should
not mask the breakage above.

## Acceptance criteria

1. **Flow 07 rewritten: launch with `notifications: unset` → no OS dialog at launch →
   in-app callout visible → Later dismisses and it stays gone across an app relaunch** —
   MET, and verified on a real Android 14 emulator twice. One deviation inside the
   criterion, described below: the relaunch re-authenticates, because the session does
   not survive a process restart.
2. **New flow: Enable tap → OS permission dialog appears → grant → callout resolves;
   registered in the shard config if flows are sharded** — MET.
   `15-notification-enable-grant.yaml` passed on both runs. No shard-config edit was
   needed or made: flows are discovered from the directory and partitioned by weight
   (`fullFlowsExcludingOta` → `partitionByWeight`), which `scripts/mobile-test.test.ts`
   still passes over the 15-file directory.
3. **Flows pass locally via the harness smoke path if the environment permits** — MET in
   substance, by a stronger check than `--smoke` (which only runs flows 01–03 and would
   not have executed either flow): both flows were run on the real dockerized emulator
   through the harness's own bring-up functions, green twice.
4. **Spike outcome reported either way; only landed if reliable at retries=0** — MET:
   run, found not viable, **not landed**. Detail below.

## Spike — broadcast-simulated FCM delivery

Run on the same emulator against the installed debug APK. Findings, in order:

- The emulator image has Google Play services and the Play Store
  (`package:com.google.android.gms`, `package:com.android.vending`).
- The APK does declare the receiver the technique targets, and holds the matching
  permission: `ai.hushbox.app/com.google.firebase.iid.FirebaseInstanceIdReceiver` filtering
  `com.google.android.c2dm.intent.RECEIVE`, with `com.google.android.c2dm.permission.RECEIVE:
  granted=true`; the Capacitor `MessagingService` is registered for
  `com.google.firebase.MESSAGING_EVENT`.
- `adb shell am broadcast -a com.google.android.c2dm.intent.RECEIVE -n
  ai.hushbox.app/com.google.firebase.iid.FirebaseInstanceIdReceiver --es gcm.notification.title …`
  from the shell UID is **not** permission-denied: `Broadcast completed: result=0`, and
  with the app foregrounded it reached the app's push pipeline —
  `Capacitor/PushNotificationsPlugin: Notifying listeners for event pushNotificationReceived`.
- **It never rendered in the shade.** Second pass with
  `pm grant ai.hushbox.app android.permission.POST_NOTIFICATIONS` (confirmed:
  `importance=DEFAULT`) and the app backgrounded via `KEYCODE_HOME`: the broadcast still
  reported `result=0`, but `dumpsys notification --noredact` showed no posted record for
  the app (only its `AppSettings` line) and logcat showed no push-related lines at all.
- Independently of the above, **a Maestro flow cannot issue the broadcast**: the step
  vocabulary has no shell/adb command, and `runScript` is a sandboxed JS engine without
  process access. Landing this would mean interleaving host-side commands between flow
  steps — a harness restructure, and a second delivery mechanism alongside the flow files.

Conclusion: not reliable, not expressible in a flow, not landed. Real FCM delivery stays
out of CI as designed.

## Deviations, with reasons

1. **Flow 07's relaunch re-authenticates.** The criterion's "stays gone across an app
   relaunch" is asserted after a fresh login rather than on a surviving session, because
   the session does **not** survive a process restart on this build: the first version of
   the flow asserted the authenticated shell after `launchApp` and failed on
   `assertNotVisible: 'Sign up'`; the failure screenshot shows the unauthenticated trial
   page ("Free preview. Sign up for full access."). Re-authenticating proves the intended
   property more strongly — the answer is device-local and survives both a process restart
   and a new session — but it is a real behavioral finding about the app, flagged below.
2. **New flow numbered 15 rather than inserted next to 07.** Renumbering the existing
   flows would rewrite files this task does not own; `15-…` sorts and shards fine, and the
   two-digit-prefix convention is preserved.
3. **The login block is duplicated in both flows** instead of extracted into a shared
   subflow. This matches how flows 10 and 14 already do it; introducing a subflow
   directory would be a new convention in files owned by the wider harness.

## Concerns and limitations

- **The session is lost on app relaunch** (force-stop + start, no `clearState`). Observed,
  not investigated — it is outside this task, but if it is unintended it is a product bug
  worth a look, and if it is intended the flows are now written to match it.
- **Flow 07 is now the heaviest flow in the suite** (~48 steps, two logins; 1m31s on a
  quiet host, 4m17s under contention). Sharding weights by step count, so it will be
  placed first — but two logins is real wall-clock added to the mobile job.
- **Neither flow can run in CI until `cap sync` is fixed** (blocker 1 above). The flows
  themselves are verified; the harness path that would run them in CI is currently red for
  reasons unrelated to this task.
- **`@capacitor-community/fcm` is absent from the Android project.** It is not in
  `capacitor.settings.gradle`, so the APK built here does not include it. That is correct
  for these flows (it is only called on iOS), but it is another symptom of the un-run
  `cap sync` and will need to be true after the sync is repaired.
- The flows assert the callout's copy and button labels; if the copy is reworded, they
  fail loudly rather than silently passing — intended, but it couples them to the strings.

## Confidence

**High** for both flows: each acceptance criterion is asserted by a step that was watched
fail for the right reason (the launch-time `Allow` assertion is the deliberate inverse of
the assertion it replaced, and the relaunch assertion caught a genuine unexpected state
before being corrected), and both flows then passed twice consecutively on a real Android
14 emulator with no retries. **Medium** on how soon this is provable in CI, since the
mobile harness cannot currently build an APK for reasons outside this task.
