# Task 11 — iOS FCM integration (Option B) — impl-report-1

## Objective

Fix iOS push end-to-end. iOS currently registers a raw APNs token that the server posts
to FCM, which rejects it. Founder ruled (2026-07-24) Option B: add
`@capacitor-community/fcm` ALONGSIDE the existing `@capacitor/push-notifications` (they
coexist), and add a small iOS-only client branch that exchanges the APNs token for an FCM
token via `FCM.getToken()`. Android stays untouched. Do NOT add
`@capacitor-firebase/messaging` or the `firebase` JS SDK. Permission timing unchanged
(Task 08 owns ask-on-mount removal).

## Status: DONE_WITH_CONCERNS

JS + dependency + config work is complete, verified, and green. The iOS **native** half
(SPM link + Xcode build + real-device FCM token) cannot be executed or verified in this
Linux environment and is founder/device-owned — stated precisely below. Two coordination
raises (pnpm-lock churn; a known full-suite coverage-merge flake).

## Verification of the founder's chosen plugin (done before wiring)

- `@capacitor-community/fcm` is explicitly designed to **coexist** with
  `@capacitor/push-notifications`: `PushNotifications.register()` is a required first step,
  then `FCM.getToken()` returns the FCM token instead of the APNs token Capacitor returns
  on Apple. Verified from the plugin README (GitHub `capacitor-community/fcm`) and the
  installed type defs (`FCMPlugin.getToken(): Promise<{ token: string }>`, doc comment:
  "because the native capacitor method, for apple, returns the APN's token").
- Latest version = **8.1.0** (`npm view … dist-tags` → latest 8.1.0). Peer deps: only
  `@capacitor/core >=8.0.0` (repo has `^8.4.0` ✓). **No `firebase` npm peer** — the
  Firebase iOS SDK arrives natively only.
- The plugin's own `Package.swift` (SPM) declares `firebase-ios-sdk` (FirebaseMessaging)
  `11.6.0..<12.0.0` as a transitive dependency, and its `Plugin.swift` `load()` calls
  `FirebaseApp.configure()` itself when no app is configured and sets the Messaging
  delegate + APNs token. Consequence: **AppDelegate.swift needs no Firebase code** (the
  plugin self-configures and rides Firebase's APNs swizzling) — no AppDelegate edit made.

## Files changed

- `apps/web/package.json` — add `"@capacitor-community/fcm": "^8.1.0"` (single dependency
  line, caret pin matching repo convention for the other `@capacitor/*` deps).
- `apps/web/src/capacitor/hooks/use-push-notifications.ts` — iOS-only token-acquisition
  branch. `PushNotifications.requestPermissions()` + `register()` are unchanged (permission
  timing untouched). In the existing `registration` listener: when `getPlatform() === 'ios'`,
  call `FCM.getToken()` and forward the FCM token; on all other platforms forward the
  `registration` event token exactly as before (Android path byte-for-byte unchanged).
- `apps/web/src/capacitor/hooks/use-push-notifications.test.ts` — new iOS-branch tests +
  mocks (`@capacitor-community/fcm`, `getPlatform`); the pre-existing token test renamed to
  its Android meaning. All original cases preserved.
- `apps/web/ios/App/App/GoogleService-Info.plist` — NEW committed **placeholder** (clearly
  fake, non-secret values; bundle id `ai.hushbox.app`). Lets the iOS build have a config
  file for dev/CI; the founder replaces it with the real secret plist for production.

Not changed: `apps/web/capacitor.config.ts` (the community FCM plugin needs no JS
config — the existing `PushNotifications` presentationOptions block is sufficient);
`AppDelegate.swift` (plugin self-configures Firebase); anything under Android.
`apps/web/src/capacitor/provider.tsx` shows as modified in the tree — that is Task 01's
already-landed `conversationIdSchema` hoist; I did not touch it.

## Tests added / changed (all in use-push-notifications.test.ts)

- `exchanges the APNs token for an FCM token on iOS` — on iOS, the `registration` event's
  raw APNs value is ignored; `FCM.getToken()` is called and its token is forwarded to
  `onTokenReceived`. Covers "iOS registration path yields an FCM token".
- `logs and skips registration when the iOS FCM token lookup fails` — `FCM.getToken()`
  rejection is logged via `console.error` (the repo's client error channel, per
  live-update.ts) and no token is forwarded (best-effort). Covers the error branch.
- `forwards the registration event token on Android` (renamed from the original
  "calls onTokenReceived when FCM token arrives") — Android path unchanged: the
  `registration` token is forwarded directly. Covers the Android no-regression criterion.
- Preserved unchanged: `does nothing on web`, `requests permissions and registers on
  native`, `calls onNotificationTap when user taps a notification`, `does not register when
  permission is denied`.

TDD: new iOS tests were written first and watched fail for the right reason (FCM.getToken
never called; console.error never called — the branch did not exist), then the hook branch
was added to make them pass.

## Self-gate (run after the last edit)

- `eslint src/capacitor/hooks/use-push-notifications.ts use-push-notifications.test.ts`
  (from `apps/web`) — **pass**, exit 0. (One initial `unicorn/no-useless-undefined` on the
  console spy was fixed to the repo idiom `() => {}`.)
- `turbo typecheck --filter=@hushbox/web` — **pass** (1 successful).
- `vitest run use-push-notifications.test.ts` — **pass**, 7/7.
- Per-file coverage on `use-push-notifications.ts` — **100%** (stmts 30/30, branch 8/8,
  funcs 9/9, lines 28/28).
- `gitleaks detect --no-git` on the placeholder plist — **no leaks found** (values chosen
  to avoid any secret pattern; I did not touch `.gitleaks.toml`, which Task 03 owns).
- `pnpm test:web` (full suite) — **exit 1**, but NOT a test failure of this change: every
  test that executed passed; the run aborts in coverage aggregation with
  `ENOENT … coverage/.tmp/coverage-81.json` inside `V8CoverageProvider.readCoverageFiles`.
  This is the known Vitest coverage-merge/worker-timing flake (documented in the run's
  memory as the unfixed ENOENT crash), outside this task's ownership. Attribution evidence:
  my test file passes clean in isolation (7/7, above), and the crash is in coverage merge,
  not any assertion. RAISED so the orchestrator can decide (re-run / cross-check against
  concurrent workstreams), not silently absorbed.
- Full-package `lint --filter=@hushbox/web` not used as the gate because the standing
  amendment records a known-external red in `apps/web/src/hooks/billing/use-prompt-budget.ts`
  (billing workstream, not my file); my owned files lint clean on their own (above).

## iOS-native gap (precise — founder/device-owned)

`cap sync ios` cannot run in this environment for TWO independent reasons:
1. The Capacitor CLI fails to parse `capacitor.config.ts` because it imports
   `@hushbox/shared`, whose source uses ESM `./constants.js` specifiers the CLI's CJS
   `require` cannot resolve (`Cannot find module './constants.js'`). This is **pre-existing**
   — `capacitor.config.ts` imported `@hushbox/shared` before this task — and reproduces
   independent of my change.
2. No iOS toolchain is present (`pod`, `xcodebuild`, `swift` all absent — Linux host), so
   SPM resolution / Xcode build could not run regardless.

Therefore, on a Mac with Xcode the founder (or an iOS CI runner) must still:
- run `cap sync ios` so the CLI regenerates `ios/App/CapApp-SPM/Package.swift` to link the
  `@capacitor-community/fcm` package (which transitively pulls the Firebase iOS SDK) — the
  `Package.swift` in-repo is CLI-managed ("DO NOT MODIFY"), so I intentionally did not
  hand-edit it;
- add `GoogleService-Info.plist` to the App target in Xcode (Copy Bundle Resources) —
  I committed the placeholder file but did NOT hand-edit `project.pbxproj` to reference it
  (unverifiable here; a malformed pbxproj would break the whole project — the README's
  "drag into Xcode" step does this correctly);
- build and run on a **real device** (APNs does not work on the iOS Simulator) to confirm
  the app obtains an FCM token and a test push arrives — the only authoritative proof of
  fix, founder-owned per the plan.

## Android regression check

Android is untouched and remains correct: the `registration` listener forwards the token
directly for all non-iOS platforms (unchanged code path; pinned by the renamed Android
test). Android FCM wiring is present and working — `android/app/google-services.json`
exists; `android/build.gradle` applies `com.google.gms:google-services:4.4.4`;
`android/app/build.gradle` applies the plugin conditionally. Installing
`@capacitor-community/fcm` adds native Android sources too, but the Android JS path never
calls `FCM.*`, so behavior is identical to today.

## Founder-facing production setup checklist

1. **Firebase console** → HushBox project → Add app → **iOS**, bundle id `ai.hushbox.app`.
   Download the real `GoogleService-Info.plist` (the secret) and replace the committed
   placeholder at `apps/web/ios/App/App/GoogleService-Info.plist` (add it to the App target
   in Xcode if not already referenced).
2. **Apple Developer** → Certificates, Identifiers & Profiles: enable the **Push
   Notifications** capability on the `ai.hushbox.app` App ID; create an **APNs Auth Key
   (.p8)** and note its Key ID + your Team ID. (The Xcode project also needs the Push
   Notifications capability / `aps-environment` entitlement enabled — an Xcode step.)
3. **Firebase console** → Project Settings → Cloud Messaging → Apple app config: upload the
   APNs **.p8** key with its Key ID and Team ID.
4. On a Mac: `cap sync ios`, then build to a **real iOS device**; grant notifications;
   confirm an FCM token registers and a Firebase-console test push arrives.

## Acceptance criteria

- "pnpm dep added, exact version pinned per repo convention" — MET (`^8.1.0`, verified
  latest, caret per the other capacitor deps).
- "iOS project builds (`cap sync` + Xcode if runnable; otherwise typecheck + sync green and
  the gap stated)" — PARTIAL as designed: typecheck green; `cap sync ios` NOT runnable here
  (two reasons above); gap stated; real-device verification founder-owned.
- "Token registration path on iOS yields an FCM token (unit-test the JS branch)" — MET
  (iOS branch unit-tested; native bridge covered by the plugin).
- "Android path regression-tested (registration listener unchanged)" — MET.
- "Founder-facing production steps note" — MET (checklist above).

## Deviations

None from the Option B brief. Two judgment calls, both toward safety and both reported:
(a) did not hand-edit the CLI-managed `Package.swift` or `project.pbxproj` (regeneration is
`cap sync`'s job and unverifiable here); (b) used `console.error` for the best-effort iOS
token-lookup failure, matching the existing client error channel (`live-update.ts`) rather
than swallowing silently.

## Concerns and limitations

- The native iOS half is unverifiable here (see gap). Real-device delivery is the only
  authoritative proof and is founder-owned.
- `pnpm-lock.yaml` is modified by the dependency add (unavoidable). It is a shared file and
  the standing amendments note concurrent workstreams — flagged as a coordination raise.
- The full `pnpm test:web` run aborts on the known coverage-merge ENOENT flake (not this
  change) — flagged so the orchestrator can re-run / cross-check rather than read it as a
  red from this task.

## Confidence

high (JS/dep/config) — the plugin API and coexistence contract are verified from the
installed types and README; the hook branch is unit-tested at 100% per-file coverage;
typecheck and owned-file lint are green. medium overall only because the iOS native build
+ real-device delivery cannot be exercised in this environment and remain founder-owned.
