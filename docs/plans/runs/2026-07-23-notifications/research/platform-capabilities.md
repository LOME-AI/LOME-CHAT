# Notifications platform-capabilities research (2026-07-23)

Scope: current (2025–2026) technical landscape for push + browser notifications from
HushBox's stack (Cloudflare Workers/Hono API, Durable Objects, React SPA on Pages,
Capacitor iOS/Android). Research only — no design decisions made here.

---

## 1. Web Push in 2026: browser/OS support matrix

**Traditional Web Push (Service Worker + Push API + VAPID, RFC 8030/8291/8292):**
Chrome and Firefox on desktop and Android have supported this since 2015/2016
(Verified, historical, restated in [WebKit Safari 18.4 blog](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).
Safari added standards-based Web Push in Safari 16.1 on macOS, then extended it to
installed web apps on iOS/iPadOS 16.4 (March 2023) (Verified,
[WebKit blog](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).

**iOS/iPadOS constraint (unchanged as of 2026):** the Push API is available **only**
to web apps added to the Home Screen — an open Safari tab (or any other iOS browser,
since all are WebKit-based per Apple's engine policy) has no `PushManager` access.
Permission must be requested from a user gesture. Per StatCounter cited by the source,
>95% of iPhones run iOS 16+ as of early 2026, so the installed-PWA gate — not OS
version — is the binding constraint (Verified/Inferred synthesis,
[MagicBell PWA iOS guide 2026](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)).

**EU/DMA wrinkle:** Apple briefly threatened to strip PWA push/standalone-mode
support in the EU under DMA pressure (iOS 17.4), reversed after backlash, but sources
disagree on final state — one 2026 source still lists push as unavailable in some EU
configurations. **Conflict, not resolved**: verify current EU behavior at
implementation time if EU users matter (Gap).

**Declarative Web Push (Safari 18.4+, shipped March 2025):** a new delivery mode that
renders a user-visible notification **without invoking a Service Worker**, addressing
battery/CPU cost and the "silent push" abuse vector of the classic model (Verified,
[WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/),
[WebKit Safari 18.4 post](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)).

- **Payload format** — a JSON body (not the encrypted binary aes128gcm body of
  classic Web Push) shaped like:
  ```json
  {
    "web_push": 8030,
    "notification": {
      "title": "...", "lang": "en-US", "dir": "ltr", "body": "...",
      "navigate": "https://example.com/target", "silent": false, "app_badge": "1"
    }
  }
  ```
  `web_push: 8030` is the opt-in magic number (a nod to RFC 8030); `notification.title`
  and `notification.navigate` are required; most standard `NotificationOptions` fields
  are supported; `app_badge` updates the Badging API count declaratively (Verified,
  [WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)).
- **Encryption implications**: the WebKit posts describe the JSON *shape* but do not
  state whether the message body arrives encrypted or plaintext at the transport
  layer. The existing Web Push encryption pipeline (RFC 8291 aes128gcm, keyed to the
  subscription's `p256dh`/`auth`) is described as unchanged — "sending works exactly as
  before" — which implies the JSON above is still the **decrypted content** that
  results from the normal aes128gcm decrypt step, i.e., the payload sent over the wire
  is still encrypted per RFC 8291, and Declarative Web Push changes what the decrypted
  JSON must contain / how the OS renders it, not whether transport encryption happens
  (Inferred, same WebKit post — the post does not use the words "aes128gcm" or
  "plaintext" at all, so treat this as inference, not a verified statement — **Gap**).
- **Service Worker interplay**: if a Service Worker is registered, the `PushEvent`
  still fires carrying the "proposed notification"; the SW handler may replace it, or
  if it fails/times out, the declarative fallback still displays. Because a
  user-visible notification is now guaranteed, the "silent push" revocation penalty
  does not apply to declarative pushes (Verified, same source).
- **Subscription model**: adds `window.pushManager` (subscribing without any Service
  Worker at all) alongside the existing `ServiceWorkerRegistration.pushManager`; if a
  SW is registered at the same scope, subscriptions are shared (Verified, same
  source).
- **Availability**: testable on iOS/iPadOS 18.4+ and macOS 15.5+/Safari 18.5+ (Safari
  18.5 extended it to regular Safari tabs, not just installed apps, on macOS)
  (Verified, [aimtell: State of Declarative Web Push 2026](https://aimtell.com/blog/state-of-declarative-web-push-2026)).
- **Cross-browser status as of April 2026**: Apple platforms are the only shipping
  implementers. Chrome has no native support (falls back to classic SW rendering of
  the same payload). Firefox/Mozilla recorded a "positive" standards position
  (Feb 2025) and co-edits the Push API spec draft, but has not shipped (Verified,
  [aimtell 2026](https://aimtell.com/blog/state-of-declarative-web-push-2026)). The
  spec itself reached W3C Working Draft status with a normative "Declarative push
  message" section on 2025-12-01, with multi-vendor (Apple + Mozilla) editorship
  (Verified, same source).

**Practical takeaway**: Declarative Web Push is an Apple-only optimization today; a
correct implementation still needs classic Service-Worker-driven Web Push (RFC
8291/8292) as the baseline for Chrome/Firefox/Android, with the declarative JSON as an
additive, backward-compatible payload shape aimed at Safari.

---

## 2. Sending Web Push FROM Cloudflare Workers

**Core problem**: the canonical `web-push` npm package (web-push-libs/web-push) is
built for Node — it needs `Buffer`, `crypto.createECDH`, and `https.request`, none of
which exist natively in the `workerd` runtime. `nodejs_compat` bridges the `Buffer`
gap but **not** `https.request`, so the stock package still doesn't work unmodified on
Workers (Verified, [Cloudflare Workers issue thread on web-push-libs/web-push#718](https://github.com/web-push-libs/web-push/issues/718)
as summarized by search; [block65/webcrypto-web-push README description](https://github.com/block65/webcrypto-web-push)).

**Why it's feasible anyway**: `workerd` implements the full WebCrypto standard
(`crypto.subtle`), which is sufficient to do everything RFC 8291 (aes128gcm payload
encryption: ECDH + HKDF-SHA-256 + AES-128-GCM) and RFC 8292 (VAPID: ES256 JWT signing
with `crypto.subtle.sign`) require, with zero Node shims (Verified,
[Cloudflare Workers Web Crypto docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
referenced in search results; corroborated by the existence of multiple
Workers-targeted libraries below).

**Purpose-built libraries confirmed to target Workers:**
- **`@block65/webcrypto-web-push`** — explicitly supports Node/Cloudflare
  Workers/Bun/Deno; ships a dedicated Cloudflare Workers example
  ([examples/cloudflare-workers/main.ts](https://github.com/block65/webcrypto-web-push/blob/master/examples/cloudflare-workers/main.ts)).
  Latest release v1.0.2 (Dec 2024) (Verified, [GitHub repo](https://github.com/block65/webcrypto-web-push),
  [npm](https://www.npmjs.com/package/@block65/webcrypto-web-push)). ESM-only package
  (needs `moduleResolution: node16/nodenext/bundler` in TS config).
- **`web-push-browser`** (colecrouter) — zero-dependency, ESM-first; VAPID key
  gen/serialization plus aes128gcm payload encryption (aesgcm only "partially
  supported"); explicitly targets browsers, Cloudflare Workers, Deno, Bun (Verified,
  [npm](https://www.npmjs.com/package/web-push-browser)).
- **`@pushforge/builder`** (draphy/pushforge) — cross-platform (Node/Browser/Deno/
  Bun/Cloudflare Workers), explicitly built to dodge the exact Workers failure modes
  (`crypto.createECDH is not a function`, `https.request is not available`); supports
  TTL, Urgency, Topic; has a live Cloudflare-Workers-hosted playground (Verified,
  [GitHub](https://github.com/draphy/pushforge)).
- **`webpush-webcrypto`** (rtedge-net) — WebCrypto-only dependency, works in both
  browser and server contexts (Verified, mentioned alongside block65 in search
  results, not independently fetched — **treat as Inferred** pending direct README
  read).
- Cloudflare's own **Agents** docs include a push-notifications guide built on this
  same VAPID + Workers model, confirming Cloudflare treats this as a supported pattern
  (Verified, [Cloudflare Agents push-notifications guide](https://developers.cloudflare.com/agents/guides/push-notifications/)).

**Known pitfalls (from search synthesis, not independently reproduced — Inferred):**
- Must handle 404/410 responses from the push service by deleting the dead
  subscription (Cloudflare's own guidance repeats this).
- ESM/`moduleResolution` friction with `@block65/webcrypto-web-push`'s package
  exports under strict TS configs.
- If instead trying to force the classic `web-push` npm package via
  `nodejs_compat`, the `https.request` gap remains unresolved — this path is a dead
  end, not just an inconvenience.

**Bottom line**: sending RFC 8291/8292-compliant Web Push directly from a Cloudflare
Worker is feasible today using WebCrypto-native libraries; no server framework or
Node-compat layer is required beyond what `workerd` already provides.

---

## 3. Capacitor native push in 2026

**`@capacitor/push-notifications` (official plugin):**
- **Android**: straightforward. Drop `google-services.json` into `android/app/`; the
  plugin auto-includes a `firebase-messaging` dependency; no manual native wiring;
  permission is granted without a prompt (pre-Android-13 semantics still apply per
  older docs — verify current API-level prompt behavior at implementation, not
  confirmed this session — **Gap**). Tokens returned are native FCM tokens (Verified,
  [Capacitor docs: push-notifications-firebase](https://capacitorjs.com/docs/guides/push-notifications-firebase)).
- **iOS — the "iOS Wall"**: the plugin's registration flow talks to APNs directly and
  the `'registration'` event returns a **raw APNs device token** (hex string), *not*
  an FCM token, out of the box. FCM's send API expects an FCM registration token, so
  naively wiring the plugin's iOS token into Firebase silently fails (Verified,
  [Capawesome / dev.to Jan 2026 guide](https://dev.to/saltorgil/the-complete-guide-to-capacitor-push-notifications-ios-android-firebase-bh4)
  as summarized in search; corroborated by the official Capacitor Firebase guide's
  manual-exchange step).
- **The fix, per the official Capacitor Firebase guide**: in `AppDelegate.swift`,
  intercept `didRegisterForRemoteNotificationsWithDeviceToken`, set
  `Messaging.messaging().apnsToken = deviceToken`, then call
  `Messaging.messaging().token(...)` and post *that* FCM token via
  `capacitorDidRegisterForRemoteNotifications` — so the JS-side `token.value` ends up
  being the FCM token, not the APNs token (Verified,
  [Capacitor docs: push-notifications-firebase](https://capacitorjs.com/docs/guides/push-notifications-firebase)).
  This requires: a paid Apple Developer account, an APNs auth key (.p8) uploaded to
  Firebase Console → Cloud Messaging, `GoogleService-Info.plist` added to all Xcode
  targets, the Firebase iOS SDK (SPM or CocoaPods) added to the app target, and
  `FirebaseApp.configure()` called at launch.
- **Community alternative**: `@capacitor-firebase/messaging` is cited (Jan 2026 guide)
  as the "robust 2026 solution" — it handles the native token-swizzling for you,
  giving a unified FCM token on both platforms without hand-editing `AppDelegate`
  (Verified as *cited*, not independently vetted for maturity/maintenance — **Inferred**
  recommendation strength).

**Direct-to-APNs from a Worker (bypassing FCM for iOS) is also viable:**
- **`cloudflare-apns2`** (FiveSheepCo) — a fork of the `apns2` Node client rewritten
  to drop Node-only dependencies and use native Workers APIs; explicitly "not
  compatible with Node.js" and needs no `nodejs_compat` flag (Verified,
  [GitHub](https://github.com/FiveSheepCo/cloudflare-apns2)).
- **HTTP/2 support**: APNs requires HTTP/2 and terminates HTTP/1.1 connections;
  Cloudflare Workers' `fetch()` negotiates HTTP/2 in production. **Caveat**: a
  documented `workerd` bug means local dev (`wrangler dev` on macOS) can fail to
  reach APNs via `fetch()` even though the identical code works once deployed
  (Verified, [cloudflare/workerd issue #4841](https://github.com/cloudflare/workerd/issues/4841)).
  This is a concrete local-dev-parity gap worth flagging given the stack's
  "local dev parity" value.
- **Token auth mechanics**: JWT header `{alg: ES256, kid: <10-char Key ID>}`, claims
  `{iss: <10-char Team ID>, iat: <unix seconds>}`; must be signed with the ES256
  algorithm only (anything else → `InvalidProviderToken` 403); token must be
  refreshed within an hour (`ExpiredProviderToken` 403 otherwise) (Verified,
  [search synthesis of Apple's APNs provider-token docs](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html)).
  Importing a `.p8` key via `crypto.subtle.importKey` with ECDSA P-256 and signing
  with WebCrypto is the same pattern used for VAPID and for Google service-account
  JWTs below — all three are "sign an ES256/RS256 JWT with WebCrypto" instances of one
  mechanism.

**FCM HTTP v1 (needed regardless, for Android; optional for iOS if going the
Firebase-unification route) — auth from a Worker:**
- The legacy FCM server key does **not** authenticate v1 API requests. v1 requires an
  OAuth 2.0 access token minted from a Firebase/GCP **service account** (Verified,
  [Firebase FCM v1 OAuth2 codelab](https://firebase.google.com/codelabs/use-the-fcm-http-v1-api-with-oauth-2-access-tokens)).
- Flow: sign a JWT with the service account's RSA private key (RS256, imported via
  `crypto.subtle.importKey('pkcs8', ...)`), POST it to
  `https://oauth2.googleapis.com/token`, receive a bearer access token valid for 1
  hour, then `POST` to
  `https://fcm.googleapis.com/v1/projects/{project}/messages:send` with
  `Authorization: Bearer <token>` (Verified, same codelab + corroborated by
  [Marco Cimolai's Medium writeup](https://marplex.medium.com/firebase-authentication-on-cloudflare-workers-7c0af9df369b)
  and the [Cloudflare Community example](https://community.cloudflare.com/t/example-google-oauth-2-0-for-service-accounts-using-cf-worker/258220)).
- **Library**: `@sagi.io/workers-jwt` provides `getTokenFromGCPServiceAccount(...)`
  built specifically for this Workers/WebCrypto pattern (Verified, search result
  description; not independently fetched — treat exact API shape as **Inferred**).
- **Historical blocker, now resolved**: an older (2018-era) attempt at this hit a
  wall because `crypto.subtle.importKey` didn't support the `pkcs8` key format at the
  time; modern WebCrypto implementations (including `workerd`) do support `pkcs8`
  import now (Verified via search synthesis of the Cloudflare Community thread —
  the underlying claim that pkcs8 import now works is corroborated by every current
  library above successfully doing exactly this).
- **Token caching**: the 1-hour-lived access token is a natural candidate for a
  cache (KV, or in-memory within a DO/isolate) rather than re-minting per send
  (Inferred best practice from the codelab's caching note, not HushBox-specific).

**Bottom line**: both FCM v1 (Android, and iOS-via-Firebase) and direct APNs (iOS)
are reachable from a Cloudflare Worker using only WebCrypto + `fetch()` — no Node
runtime, no external signing service needed. The realistic per-platform choice is
FCM-for-both (simpler Worker-side code, one credential type, but requires the
AppDelegate token-swap dance in the Capacitor app) vs. FCM-for-Android +
direct-APNs-for-iOS (two credential types and two send paths server-side, but no
iOS-side token-swap hack and no Firebase iOS SDK dependency in the app bundle).

---

## 4. E2EE payload handling (server can't read content)

**The fundamental tension**: HushBox's architecture keeps plaintext off the server
(R2 holds only ciphertext; messages are E2E-encrypted). A push notification body that
says "New message from Alice: <preview>" requires either (a) the server sending an
encrypted payload the client decrypts before display, or (b) a generic/no-content
push that just wakes the client to fetch and locally render.

**Path A — client-side decrypt via Notification Service Extension (iOS only):**
- Apple's NSE mechanism exists exactly for this: a payload with `"mutable-content": 1`
  inside the `aps` dict routes the notification through your app's Notification
  Service Extension *before* display, letting it decrypt an encrypted body and
  rewrite the visible title/text (Verified, [Apple docs: Modifying and Presenting
  Notifications](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/ModifyingNotifications.html)).
  A valid `alert` dict must also be present or the extension is silently skipped.
- **Production precedent**: Firefox iOS uses exactly this pattern with its Autopush
  backend — encrypt with a client-held public key, decrypt in the NSE with the
  matching private key pulled from a Keychain Access Group shared between the main
  app and the extension target (Verified, [Firefox iOS wiki: Notification Service and
  Push](https://github.com/mozilla-mobile/firefox-ios/wiki/Notification-Service-and-Push),
  [Tink engineering blog on encrypted iOS notifications](https://medium.com/engineering-at-tink/encrypted-notifications-on-ios-9a87d8765e1d)).
- **Constraints**: NSEs run under tight memory/time limits (cannot be debugged with
  breakpoints against a simulator-dragged payload — must come from a real push);
  requires a second app target (the extension) sharing a Keychain group with the main
  app for key material (Verified, same sources).
- **This mechanism has no Android or web-push equivalent** — it is iOS-specific
  plumbing (Inferred from absence of any analogous mechanism surfacing in Android/web
  search results this session).

**Path B — data-only/wake push + local fetch-and-decrypt (all platforms):**
- **iOS "Background Notifications"** (`content-available: 1`, no `alert`): wake the
  app briefly (~30s budget) to run background code, with **no guarantee**:
  - Sent at APNs priority 5 (low); iOS may delay, coalesce, or drop entirely based on
    battery, Low Power Mode (which blocks all background refresh outright), and usage
    patterns (Verified, multiple sources incl.
    [Bugfender: Advanced iOS push notifications](https://bugfender.com/blog/advanced-ios-push-notifications/),
    [Apple Developer Forums thread on throttling](https://developer.apple.com/forums/thread/22080)).
  - **Undocumented rate limit by design** — Apple deliberately does not publish the
    exact throttle so it can change it freely; practical developer reports cluster
    around ~2–4 silent pushes/hour before delivery degrades, with one documented case
    of only 3 of 10 pushes sent in 15 seconds actually invoking the handler (Verified
    as *reported developer experience*, not an Apple-published number —
    [Medium: iOS Silent Push Limits](https://medium.com/@shobhakartiwari/ios-silent-push-limits-7d0c65b642f4),
    [Apple Developer Forums thread #660149](https://developer.apple.com/forums/thread/660149)).
  - **A force-quit app will not be woken at all** by a silent push (Inferred,
    stated as "well-known" in search synthesis, not independently confirmed against
    an Apple primary source this session — **Gap**, worth a direct citation before
    relying on it).
  - New silent pushes **coalesce** — the system holds only the newest pending one.
  - 4 KB (4096-byte) hard payload cap enforced by APNs regardless of push type
    (Verified, multiple sources).
- **Android data messages (FCM)**: `priority: high` wakes a Doze-sleeping device and
  grants brief limited network access; `priority: normal` (default) is deferred and
  batched until the device exits Doze or the screen turns on. Despite `"priority":
  "high"` and `time_to_live: 0`, multiple filed issues show **data-only** high-priority
  messages still queuing/delaying during Doze in practice — the documented behavior
  and observed behavior diverge (Verified as a real, filed discrepancy:
  [firebase/flutterfire#4718](https://github.com/firebase/flutterfire/issues/4718),
  older [firebase/quickstart-android#100](https://github.com/firebase/quickstart-android/issues/100);
  official priority semantics from [Firebase docs: Android message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority),
  updated as recently as July 2026 per the search result date). One added cross-platform
  gotcha: **sending to Apple devices via FCM requires priority 5 ("normal")** — "high"
  priority is rejected outright with `INVALID_ARGUMENT` for APNs-bound sends (Verified,
  same Firebase docs synthesis).

**Path C — badge-only pushes (no content at all):** update just the numeric badge via
either the platform badge field (`aps.badge` on iOS, notification badge count via FCM
on Android) or, for the installed-web-app case, Declarative Web Push's `app_badge`
field (see §1) or a same-origin `navigator.setAppBadge()` call made after the app
processes any push. This sidesteps the content-exposure question entirely at the cost
of not showing a preview.

**Synthesis for an E2EE app**: no platform lets an untrusted server render a genuine
message preview without either (a) an iOS NSE decrypting a payload the server sent
encrypted (iOS-only, needs a second extension target + shared Keychain group), or
(b) a wake-and-fetch model where the push carries no content and the client re-derives
what to show after an authenticated fetch+decrypt — and that wake is **best-effort,
throttled, and unavailable when the app is force-quit** on iOS. Android's high-priority
data-message wake is more reliable than iOS's silent push but still has documented
Doze-related delivery gaps. A badge-only or generic ("You have new messages") push
that triggers a foreground fetch-on-open is the only universally reliable pattern; a
true background-decrypt-and-show-preview experience is iOS-NSE-only and still subject
to APNs' undocumented silent-push throttle if compounded with content-available pushes.

---

## 5. Local/dev testing without real credentials

- **`web-push-testing` (marc1706)** — a standalone local server providing a mock
  push-service endpoint: full subscribe/send/retrieve flow, supports both `aesgcm`
  and `aes128gcm` content encodings, runs on `localhost:8090` by default (configurable
  port), CLI-driven (`web-push-testing start` / `stop`), Node ≥15 (Verified,
  [GitHub: marc1706/web-push-testing](https://github.com/marc1706/web-push-testing)
  as summarized in search — description matches the tool's stated purpose as successor
  to the deprecated `GoogleChromeLabs/web-push-testing-service`).
  - Practical wiring for HushBox: point the Worker's push-send code at the mock
    server's subscription endpoints during `wrangler dev`/vitest runs instead of real
    FCM/Mozilla-autopush/APNs endpoints — no real credentials needed for the Web Push
    (browser) leg.
- **`wrangler dev` / Miniflare** itself imposes no special constraint on outbound
  `fetch()` calls to push services — it's a normal local HTTP server executing the
  same Worker code, so the constraint is entirely about *what endpoint* you point at
  (mock vs. real), not the Workers runtime (Verified/Inferred synthesis from generic
  Wrangler local-dev docs referenced in search — no HushBox-specific wrinkle found
  this session beyond the noted `workerd`-macOS-APNs-HTTP/2 local bug in §3).
- **No equivalent turnkey mock found this session for FCM v1 or APNs** in the search
  results — the searches surfaced only the Web-Push-specific mock tool. A local FCM/
  APNs test strategy (stub the OAuth2/token-exchange and `fetch()` calls, or point at
  Firebase's/Apple's sandbox environments) is a **Gap**: no current, dated source was
  found describing a maintained local mock for either. This is worth flagging as an
  open question for the design phase rather than an assumed non-issue.
- **Community caution**: at least one developer quoted in search results prefers
  testing against the *real* Wrangler/production push services over mocks, because
  "mocks don't catch configuration issues" — supports keeping a CI/sandbox real-call
  path in addition to local mocks, consistent with this repo's existing cassette-based
  philosophy for other external calls (Inferred parallel to CODE-RULES' cassette
  policy, not a claim about this specific tool).

---

## 6. Reliability facts

- **410 Gone** = push service is done retrying for this subscription and will not
  send anything more to it — remove it from storage immediately. **404** = per RFC
  8030, "Subscription Expired" (some libraries have historically conflated the two
  codes) — also a permanent failure requiring subscription deletion and later
  re-subscription (Verified, [web.dev: The Web Push Protocol](https://web.dev/articles/push-notifications-web-push-protocol),
  cross-checked against RFC 8030 semantics summarized in search).
- **`pushsubscriptionchange` service worker event** exists to catch a
  browser-initiated subscription rotation *before* a 410 happens, but doesn't cover
  every rotation cause — 410-on-send remains the backstop detection path (Verified,
  same web.dev source).
- **TTL header is mandatory** on every Web Push send; it's the number of seconds the
  push service may hold the message before giving up. `TTL: 0` means "attempt once,
  now, discard if the recipient isn't reachable" — useful for ephemeral/real-time-only
  content. Push services may **clamp** an over-large requested TTL and report the
  clamped value back in the response `TTL` header — a sender should check the
  response, not assume its requested value stuck (Verified, same source).
- **Topic header** (Web Push) / **`collapse_key`** (FCM) let a new message replace a
  still-undelivered older one with the same key, so an offline user only ever sees
  the latest — e.g. appropriate for "unread count" or "someone is typing" style
  updates, not for a running list of individual messages. Web Push's `Topic` is
  capped at 32 URL-safe-Base64 characters and rejected with 400 if malformed
  (Verified, same source + RFC 8030 cross-reference in search).
  Privacy note: a `Topic` value is visible to the push service, so avoid embedding
  sensitive identifiers in it (Verified, same source).
- **Urgency header** (`very-low|low|normal|high`, Web Push) lets the push service
  economize battery by only waking low-power devices for high-urgency messages
  (Verified, same source).
- **FCM has an analogous priority split** (`normal` vs `high`) with the important
  asymmetry that iOS-bound sends through FCM must use `normal`/priority-5 — `high`
  is rejected for APNs-bound tokens (see §4) (Verified,
  [Firebase Android message priority docs](https://firebase.google.com/docs/cloud-messaging/android-message-priority)).
- **Max payload size**: Web Push minimum-supported size is 4096 bytes (413 if
  exceeded); APNs enforces a hard 4 KB cap on all push types (Verified, both facts
  independently corroborated across sources in §1/§4/§6 fetches).
- **Notification actions / inline reply support matrix:**
  - **Android**: richest support — native action buttons that fire without opening
    the app, plus true inline-reply (`RemoteInput`) directly in the notification
    shade (Verified, search synthesis of Android notification docs/blog sources).
  - **Web (Chromium-based)**: the Notifications API's `actions` array supports both
    plain buttons and `type: 'text'` inline-reply actions; handled in the service
    worker's `notificationclick` event via `event.action` / `event.reply` (Verified,
    [MDN: Notification.actions](https://developer.mozilla.org/en-US/docs/Web/API/Notification/actions)
    as summarized in search).
  - **Web on Safari/iOS**: action-button support for the standard (non-declarative)
    Notifications API is comparatively limited; the search results didn't surface a
    definitive current Safari action-button support statement — **Gap**, verify
    directly against MDN's browser-compat-data table before relying on it.
  - **iOS native**: action buttons are supported via `UNNotificationCategory`; true
    inline reply requires the native `UNTextInputNotificationAction` configured
    app-side (in the category definition), not something a bare push payload can
    request on its own (Verified, search synthesis referencing Apple's
    UserNotifications framework naming — not independently fetched from an Apple
    primary doc this session, treat exact API name as **Inferred**).

---

## 7. Badging API (`navigator.setAppBadge`) support matrix

| Platform | Support | Notes |
|---|---|---|
| Chrome/Edge desktop | Yes, since Chrome/Edge 81 (April 2020) | installed PWAs |
| Safari macOS | Yes, since Safari 17 (Sept 2023) | |
| iOS/iPadOS Safari | Yes, since iOS 16.4 (March 2023) | **Home Screen web apps only** — not exposed to open Safari tabs, other iOS browsers, or WKWebView; requires notification permission to actually render a visible badge even though `setAppBadge()` itself doesn't error without it |
| Chrome for Android | **No** | not supported |
| Firefox (all platforms) | **No** | not supported |

(Verified, search synthesis of [MDN browser-compat-data issue #19248](https://github.com/mdn/browser-compat-data/issues/19248),
[caniuse: setAppBadge](https://caniuse.com/mdn-api_navigator_setappbadge), and
[WebKit: Badging for Home Screen Web Apps](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)
as summarized in search results — the caniuse table itself was not independently
re-fetched this session, so treat exact version numbers as Verified-via-search-summary
rather than Verified-via-direct-fetch.)

**iOS quirks**: calls must originate from a frame same-origin with the top-level
document (cross-origin iframes are ignored); Safari has a known bug where calling
`setAppBadge()` with no argument or `0` **removes/hides** the badge instead of showing
an argument-less badge dot, diverging from the spec (Verified, search synthesis of MDN
compat-data issue).

**EU/DMA caveat**: under the March 2024 DMA-driven changes, EU-region PWAs reportedly
lost standalone mode, push, and badging entirely (all opened as plain Safari tabs) —
**same unresolved conflict as §1**; treat EU behavior as unverified/volatile pending a
direct check (Gap).

**Android has no Badging API path at all** — any "unread count on the home-screen
icon" requirement on Android would need a different, OS/launcher-specific mechanism
(e.g. notification-channel-driven badge counts via native Android APIs in a Capacitor
build), not the web Badging API (Inferred from the flat "no" in every source; no
alternative mechanism was independently researched this session — **Gap** if Android
icon-badging turns out to be a requirement).

---

## Gaps / open questions

- Whether Declarative Web Push payloads travel encrypted (aes128gcm) or plaintext at
  the transport layer is inferred, not directly stated in either WebKit source read.
- EU/DMA current status for iOS push/badging/standalone-mode is genuinely
  contradictory across sources — needs a direct, dated check before any EU-specific
  design assumption.
- No current, maintained local mock was found for FCM v1 or APNs (only Web Push has
  one: `web-push-testing`).
- Whether a force-quit iOS app is truly unreachable by silent push was not traced to
  an Apple primary source this session (widely repeated in secondary sources only).
- Safari's current support for standard (non-declarative) Notification API action
  buttons was not conclusively established.
- `@sagi.io/workers-jwt`, `webpush-webcrypto`, and `@capacitor-firebase/messaging`
  were characterized from search-result summaries only, not from directly fetched
  README/source — treat their exact APIs as Inferred until read firsthand.
