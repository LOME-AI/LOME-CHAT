# iOS FCM plugin decision — analyst material (2026-07-24)

Verified facts (sources fetched 2026-07-24):

- `@capacitor-firebase/messaging` v8.3.0 — iOS docs REQUIRE "no other Capacitor Push
  Notification plugin installed"; **replaces** `@capacitor/push-notifications` on both
  platforms; hard peers `@capacitor/core >=8.0.0` AND `firebase ^12.6.0` (full JS SDK).
- `@capacitor-community/fcm` v8.1.0 — explicitly designed to **coexist** with
  `@capacitor/push-notifications` (`PushNotifications.register()` is a required step,
  then `FCM.getToken()`); peer only `@capacitor/core >=8.0.0`, NO `firebase` npm peer;
  adds only the native firebase-messaging SDK.
- Repo: Android fully FCM-wired (google-services.json + gradle plugin) and WORKING; iOS
  has zero Firebase (no plist, no AppDelegate push code) → raw APNs token → FCM rejects.
- Server (`push-fcm.ts`) is plugin-agnostic — **zero server changes in all options**.
- Client change is one hook (`use-push-notifications.ts`).

Options:
- **A — full migration to `@capacitor-firebase/messaging`.** Remove push plugin, add it +
  `firebase` JS SDK, rewrite+retest Android, rewrite JS both platforms. Best-maintained;
  gives foreground-notification handling, topics, web push. COST: deepest Firebase
  lock-in (full JS SDK), Android regression risk for an iOS-only bug. Violates
  Minimal-Vendor-Lock-in + Surgical-Changes.
- **B — `@capacitor-community/fcm` coexisting (RECOMMENDED).** Add it, keep push plugin,
  Android untouched, small iOS-only JS branch (after register(), use FCM.getToken() on
  iOS). Adds only native Firebase iOS SDK (which ANY iOS-via-FCM path needs). Best fit for
  Minimal-Vendor-Lock-in, Simplicity, Surgical-Changes, DX. Mild One-Impl tension (a
  platform branch) but that's legitimate platform dispatch, not a sync-contract.
- **C — manual Firebase iOS SDK + AppDelegate bridge, no plugin.** Zero lock-in advantage
  over B (both add native SDK), maximal DX/maintenance cost, fights push-plugin swizzling.
  Dominated by B.

iOS-native work required IDENTICALLY by all options (founder/device-owned, not
CI-verifiable on Linux): GoogleService-Info.plist, Firebase iOS SDK, upload APNs .p8 auth
key to Firebase, AppDelegate registration; real-device push is the only authoritative
proof of fix.

Analyst recommendation: **B**, unless the founder wants the richer Firebase feature set
(foreground handling / topics / web push) soon — that requirement is the only case where
A's cost is justified.
