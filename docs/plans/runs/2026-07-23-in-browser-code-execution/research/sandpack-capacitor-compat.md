# Does Sandpack (classic bundler, self-hosted) work inside Capacitor WebViews?

Research date: 2026-07-23. Scope: `@codesandbox/sandpack-react` 2.20.0, classic (non-experimental)
bundler, self-hosted on our own https origin, loaded via `bundlerURL` inside an iframe, inside a
Capacitor app — iOS WKWebView (`capacitor://` custom scheme) and Android WebView
(`https://localhost`).

## Direct answer

**iOS WKWebView: blocked, not a spike candidate — it needs a documented Apple capability that
does not currently exist.** The classic bundler's boot sequence hard-throws when
`navigator.serviceWorker` is absent, and WKWebView does not expose `navigator.serviceWorker` at
all outside Safari/SFSafariViewController/home-screen web apps — confirmed by Apple's own DTS
engineer in Feb 2025, re-confirmed by a developer's live re-test in Apr 2025, and matching
Capacitor's own issue tracker (closed "not planned"). App-Bound Domains does **not** reliably fix
this — Apple has never confirmed it works, one developer specifically retested with it configured
and it still failed, and the mechanism only ever governs the top-level frame's restricted-API
access, not iframe capability grants.

**Android WebView: plausible, must-spike — no hard blocker found, but no direct prior-art
confirmation either.** Chromium's Android WebView has supported service workers since API 24
(Android 7.0) and shares Chrome's engine, so the SW dependency itself is not disqualifying. The
open question is Chrome's third-party storage-partitioning behavior for a cross-origin bundler
iframe registering its own service worker inside an `https://localhost`-origin Capacitor page —
this needs an on-device test; no source confirms or refutes it for this exact shape.

## 1. Service worker dependency — hard requirement or graceful degradation?

**Verified — the classic bundler hard-throws when the Service Worker API is unsupported; there is
no postMessage/blob fallback path.** I traced this in the actual bundler source, not docs:

- The official self-hosting guide states `yarn build:sandpack` is `lerna run build:sandpack-sandbox
  --scope app`, which is `packages/app`'s own `build:sandpack-sandbox` script
  (`SANDPACK=true SANDBOX_ONLY=true node scripts/build.js`) —
  https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler. So the self-hosted bundler
  `www` bundle is literally `packages/app/src/sandbox` built in Sandpack mode, not a separate
  lightweight artifact.
- `packages/app/src/sandbox/worker/utils.ts`, `getServiceWorker()`:
  ```ts
  export async function getServiceWorker(): Promise<ServiceWorker | null> {
    invariant(
      'serviceWorker' in navigator,
      'Failed to start the relay Service Worker: Service Worker API is not supported in this browser'
    );
    ...
  ```
  (https://github.com/codesandbox/codesandbox-client/blob/master/packages/app/src/sandbox/worker/utils.ts)
  This throws immediately, synchronously, if `navigator.serviceWorker` doesn't exist — which is
  exactly WKWebView's condition (see §2).
- `packages/app/src/sandbox/worker/index.ts`, `startServiceWorker()`:
  ```ts
  export async function startServiceWorker() {
    const worker = await getServiceWorker().catch(error => {
      console.error('[relay] Failed to ensure the relay has a Service Worker registered...');
      console.error(error);
    });
    await navigator.serviceWorker.ready;   // throws TypeError if navigator.serviceWorker is undefined
    invariant(worker, '[relay] Failed to retrieve the worker instance: worker not found');
    ...
  ```
  (https://github.com/codesandbox/codesandbox-client/blob/master/packages/app/src/sandbox/worker/index.ts)
  The `.catch()` only swallows the error for logging — it does not recover. The next line
  unconditionally reads `navigator.serviceWorker.ready`, which itself throws when
  `navigator.serviceWorker` is `undefined`. There is no branch anywhere in this file that falls
  back to blob URLs, `postMessage`-only delivery, or any other transport. The preview iframe never
  reaches its `preview/ready` handshake message if this throws — i.e., the bundler never boots.

**Re the FAQ's Brave note** (Sandpack FAQ,
https://sandpack.codesandbox.io/docs/resources/faq): that failure mode is different — Brave
*has* `navigator.serviceWorker` (the API exists) but denies registration permission via Shields,
producing "The user denied permission to use Service Worker." The FAQ's fix is a manual
brave://settings/cookies allowlist entry, done once by the human user; it is not a
programmatic fallback, and it doesn't apply to WKWebView, which fails the earlier
`'serviceWorker' in navigator` check entirely (the API is absent, not merely denied).

**Gap:** I did not find the *iframe-side* bundler application code that decides how to render the
preview after the relay worker step (e.g., how `SandpackPreview`'s own React shell in the iframe
consumes the relay). The relay/worker layer traced above is the piece that both the docs and the
build-target evidence point to as the mandatory first stage, but I have not personally read every
downstream file in `packages/app/src/sandbox`.

## 2. WKWebView service worker support (iOS 17/18/26-era) and App-Bound Domains

**Verified — `navigator.serviceWorker` is unsupported in WKWebView outside Safari itself,
SFSafariViewController, and home-screen web apps, as of the most recent (2025) evidence
available, with no contrary WWDC 2025/2026 announcement found.**

- caniwebview.com's Service Workers page (data current to 2026-07-18, i.e. within days of this
  research) lists **every** Service Worker API surface (`Navigator.serviceWorker`,
  `ServiceWorkerContainer.register`, `ServiceWorkerGlobalScope`, `FetchEvent`, etc.) as
  **unsupported** for WKWebView on both iOS and macOS —
  https://caniwebview.com/features/web-feature-service-workers/. Feature is flagged "Widely
  available in browsers" but explicitly excluded from that Baseline calculation because of
  WebViews.
- Apple Developer Forums thread 773539 ("ServiceWorker Support in iOS WKWebView", opened Jan
  2025): Apple's own Frameworks Engineer, in the thread's Accepted Answer (Feb 2025):
  > "There's no supported way for you to explicitly support service workers in iOS WKWebView with
  > the APIs currently available. If you'd like us to consider adding the necessary
  > functionality, please file an enhancement request using Feedback Assistant."
  A second developer (ShaddamIV, Apr 2025) independently re-tested with `'serviceWorker' in
  navigator` and reported it evaluates false in WKWebView on both iOS and Mac Catalyst (true only
  in Safari proper), and quotes Apple DTS Code-Level Support directly: **"iOS WKWebview does not
  support Service Workers."** — https://developer.apple.com/forums/thread/773539
- I found no WWDC 2025 or WWDC 2026 announcement reversing this
  (targeted search turned up nothing; the same forum thread remains the most current primary
  source).

**App-Bound Domains (`WKAppBoundDomains`) — does listing our bundler domain enable SW in the
iframe? Evidence is mixed and leans "no" / unconfirmed, not "yes":**

- WebKit's own blog post on the mechanism (https://webkit.org/blog/10882/app-bound-domains/)
  documents App-Bound Domains as restoring `evaluateJavaScript:`, `addUserScript:`,
  `window.webkit.messageHandlers`, and `WKHTTPCookieStore` cookie APIs. **It does not mention
  Service Workers or IndexedDB at all.** It also states explicitly the domain check "only occurs
  for the top-level frame" — the mechanism is a navigation-scope gate on the top frame, not a
  grant that propagates into arbitrary iframes.
  - This matters directly for our design: our bundler would load in an **iframe**, not as the
    top-level navigation, so even in the reading most favorable to App-Bound Domains, the
    mechanism's documented behavior targets the frame that actually navigates to an app-bound
    domain, and third-party iframes from non-app-bound domains are explicitly still permitted to
    load without becoming app-bound themselves.
- In the same forum thread (773539), the original poster's own empirical claim was that SW
  "becomes available for a domain in WKWebView if the domain is allowlisted in app-bound
  domains" — but Apple never confirmed this, and ShaddamIV's later reproduction explicitly says
  **"Solutions with app boundaries and a few settings in WKWebview do not work."**
- Capacitor's own issue tracker, #7069 (opened Nov 2023, Capacitor 5.5.1, iOS): reporter's
  `navigator.serviceWorker.register("/sw.js")` fails with `"TypeError: serviceWorker.register()
  must be called with a script URL whose protocol is either HTTP or HTTPS"` because Capacitor
  serves iOS content over the `capacitor://` scheme, which the SW API rejects outright — a
  distinct, compounding failure mode from the App-Bound-Domains question, and specific to *our
  own app's origin* trying to register a worker, not the bundler's. Status: **closed "not
  planned"** by the Capacitor maintainers, no fix shipped. — https://github.com/ionic-team/capacitor/issues/7069
- Older App-Bound-Domains-in-iframe reports (2020–2021, pre-dating our target iOS versions but
  never superseded by a fix) describe the grant being flaky even when obtained: "the API was
  available but couldn't be properly used because `ServiceWorkerRegistration.unregister` always
  failed... maximum limitation of 3 service workers, after which register and update methods
  fail" — Apple Developer Forums thread 684591, referenced via search; not independently
  refetched this session, graded **Inferred** from the search-tool's extraction rather than a
  direct WebFetch read.

**Capacitor's own docs/config on this** (https://capacitorjs.com/docs/config, v8, fetched this
session): `ios.limitsNavigationsToAppBoundDomains` (default `false`, since 3.1.0) — "recommend
enabling this option if your `Info.plist` includes `WKAppBoundDomains`, otherwise some features
won't function," with the caveat that as a side effect it "blocks navigation outside the domains
in the list," and `localhost` (our own app origin) must itself be added to the app-bound list
alongside any bundler domain. Capacitor does not itself claim this enables Service Workers
anywhere in its docs — it only forwards the raw WKWebView configuration flag.

**Conclusion for §2:** stacking the evidence — caniwebview's blanket "unsupported," Apple DTS's
Feb 2025 "no supported way," a live 2025 re-test finding App-Bound Domains "do not work," and
Capacitor's own SW issue closed "not planned" — the balance of current, dated evidence is that
service workers do not work in WKWebView for this use case, app-bound or not. Nothing found
justifies spending spike time on the App-Bound-Domains path specifically; it is not merely
unverified, it has an on-record negative re-test.

## 3. Cross-origin iframes on a `capacitor://` page

**Verified — direct DOM/property access across the `capacitor://` ↔ `https://` boundary is
blocked by protocol mismatch (same-origin policy on scheme); this is well documented and distinct
from the SW question.** Example error quoted from a Capacitor GitHub issue: *"Blocked a frame with
origin 'capacitor://localhost' from accessing a frame with origin 'https://oursite.com'... The
frame requesting access has a protocol of 'capacitor', the frame being accessed has a protocol of
'https'. Protocols must match."* — https://github.com/ionic-team/capacitor/issues/2847. This only
affects synchronous cross-frame property access (e.g. `contentDocument`); it does not, by itself,
block iframe loading or `postMessage`.

**postMessage origin validation — Sandpack's own code, read directly:**

- `sandpack-client/src/clients/runtime/iframe-protocol.ts` (the classic/"runtime" client used by
  the classic bundler) — parent→iframe `dispatch()`:
  ```ts
  this.frameWindow.postMessage(
    { $id: this.channelId, codesandbox: true, ...message },
    this.origin   // = the bundlerURL, an https:// origin
  );
  ```
  `targetOrigin` here is the **bundler's** https origin, not our app's. `postMessage`'s
  `targetOrigin` parameter restricts delivery based on the *receiving* window's origin, not the
  sender's — so the fact that our page is `capacitor://localhost` does not, by itself, break this
  call. — https://github.com/codesandbox/sandpack/blob/main/sandpack-client/src/clients/runtime/iframe-protocol.ts
- The same file's iframe→parent listener does **not** check `evt.origin` at all — it only checks
  `evt.source !== this.frameWindow` (window-reference identity) and a `message.codesandbox` /
  `message.$id` payload tag. So incoming messages from the bundler iframe are not filtered by
  string-origin comparison and would not be broken by our page's `capacitor://` origin.
- Other sandpack-client code paths (`static/index.ts`, `node/index.ts`,
  `node/inject-scripts/*.ts`, `runtime/index.ts`'s handshake `postMessage(initMsg, "*", ...)`) use
  the wildcard `"*"` targetOrigin — even less origin-sensitive. Repo-wide search for
  `targetOrigin` in `sandpack-client/src` returned zero matches outside the one `this.origin`
  usage above; `event.origin` returns zero matches anywhere in `sandpack-client`.
- **Gap:** this only covers `sandpack-client`'s side. The bundler's *own* application code running
  inside the iframe (built from `packages/app/src/sandbox`, not published as readable
  "sandpack-client" source in the same way) was not inspected for origin checks on its inbound
  listener. If that code validates `event.origin` or `document.referrer` against an expected
  parent origin, a `capacitor://` parent could be rejected there — unverified, not ruled out.

**Real-world capacitor:// + postMessage failure report, root-caused to `document.referrer`, not
`event.origin`:** An Ionic Forum thread (Capacitor 4.1.0, physical iOS devices only, not
simulator) found a third-party iframe never reacted to `contentWindow.postMessage()` calls from
a Capacitor app; the poster's own follow-up diagnosis: *"the iFrame is expecting the
`window.document.referrer` value to be set. For iOS, it isn't, but it is on other browsers."* —
https://forum.ionicframework.com/t/iframe-not-not-responding-to-postmessage-call-on-ios/234426.
This is real, current-mechanism prior art of a `capacitor://`-origin page's postMessage silently
failing to be *acted on* by an iframe's own logic (not a spec-level postMessage failure) — grade
**Verified** as an observed report, but **Inferred** as a predictor for Sandpack specifically,
since Sandpack's own eventListener code (read directly, above) does not appear to check
`document.referrer`.

**Mixed content:** not applicable in the traditional sense — the mixed-content check fires for an
`https://` top-level page loading `http://` (non-secure) subresources. Our top frame is
`capacitor://` (a custom scheme, not `https://`), and our iframe would be `https://` (upgraded,
not downgraded), so the standard mixed-content blocking rule does not describe this pairing. I
found no evidence (and no search hit) of WKWebView independently mixed-content-blocking an
`https://` iframe embedded from a `capacitor://` page — the well-documented failures in this area
are the protocol-mismatch DOM-access error and the referrer/postMessage report above, not a mixed
content block.

## 4. Android WebView

**Verified — Android's WebView component has native framework support for service workers since
API level 24 (Android 7.0 Nougat)**, via `android.webkit.ServiceWorkerController` /
`ServiceWorkerWebSettings`, both added at API 24 —
https://developer.android.com/reference/android/webkit/ServiceWorkerController,
https://developer.android.com/reference/android/webkit/ServiceWorkerWebSettings. Android WebView
is Chromium-based and shares Chrome's engine, so the SW dependency identified in §1 is not
inherently disqualifying on this platform, unlike iOS.

**Inferred/Assumed — cross-origin iframe SW registration under an `https://localhost`-scheme
Capacitor page has not been directly confirmed or refuted for this exact configuration.** Two
threads of general (non-Capacitor-specific) evidence are relevant but not conclusive:

- Chrome's third-party storage-partitioning work (rolling out progressively; Chrome's own docs
  describe a `ServiceWorker` API among the partitioned categories in third-party/cross-origin
  contexts, with an opt-out deprecation trial that must be activated by the *top-level* site, not
  the embedded iframe) — https://privacysandbox.google.com/cookies/storage-partitioning,
  https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning. This governs *storage
  isolation*, not registration outright — a service worker can still register in a third-party
  iframe under partitioning, but its storage (caches, IndexedDB) is scoped per top-level site
  rather than shared with the same origin's first-party visits. It is unclear whether Android
  System WebView (a distinct release channel from desktop/mobile Chrome) has shipped this
  partitioning on the same timeline; I found no WebView-specific rollout note.
- No GitHub issue, forum post, or blog post was found describing Sandpack (or the underlying
  `codesandbox-client` sandbox runtime) running — successfully or unsuccessfully — inside an
  Android WebView, Capacitor, Cordova, or `react-native-webview` context. Searches targeting this
  exact combination (`sandpack-react capacitor`, `sandpack-react cordova`,
  `"react-native-webview" sandpack`) returned no on-topic results.
- Android-specific Capacitor origin quirks exist but are orthogonal to SW support per se: search
  results describe `androidScheme` interacting with CORS/hostname routing in ways that have
  caused separate bugs (e.g., issue #6936, #6875), but none of these were about service workers
  or the Sandpack bundler specifically, and none were independently fetched/verified this
  session — flagged as **not verified**, background context only.

**Conclusion for §4:** no disqualifying blocker found, but also no positive confirmation. This is
squarely a "must spike on a real device" item, not a "known-good" or "known-blocked" one.

## 5. Prior art — Sandpack/CodeSandbox/artifact previews inside Capacitor/Cordova/React Native WebViews

**No direct prior art found for Sandpack specifically.** Multiple targeted searches (`Sandpack
inside Capacitor app WebView`, `sandpack-react capacitor OR cordova OR react-native-webview`,
`Sandpack self-hosted bundler mobile app WebView`) returned no GitHub issue, forum thread, or blog
post describing anyone running Sandpack (self-hosted or CDN-hosted, classic or experimental
bundler) inside a Capacitor, Cordova, or React Native WebView context, successfully or otherwise.
This is a genuine **gap**, not a "clean bill of health" — absence of complaints here is at least
partly explained by absence of attempts, given the SW requirement traced in §1 would fail fast and
visibly (a thrown error, not a silent degraded state), which would likely have generated a
findable issue if anyone had shipped this combination at any scale.

**Related-but-not-equivalent prior art found:**

- **LibreChat** ships Sandpack-based artifacts in its web app and documents self-hosting the
  bundler (`ghcr.io/librechat-ai/codesandbox-client/bundler:latest`,
  `SANDPACK_BUNDLER_URL`) — https://www.librechat.ai/docs/features/artifacts. LibreChat has no
  documented native mobile wrapper; its docs and GitHub issues found in this research (e.g.
  https://github.com/danny-avila/LibreChat/discussions/9112,
  https://github.com/danny-avila/LibreChat/issues/8581) are entirely about desktop-browser CSP
  and connectivity issues (`frame-src`, HTTPS↔HTTP proxying), never a Capacitor/native-WebView
  deployment. Not usable as evidence either way for this question.
- **VS Code's own webview extension host** is known prior art for the general pattern of "run a
  service worker inside a webview iframe you control" (a technique referenced in passing by a
  Chromium issue thread found during search, https://issues.chromium.org/issues/40052335, and
  echoed by an unfetched summary claim that VS Code webviews point an iframe at a domain the
  extension controls so a service worker can be active inside it) — but VS Code's desktop webview
  is an Electron/Chromium context, not WKWebView, so it says nothing about the iOS blocker in §2.
  Not independently re-verified this session — grade **Inferred**, low confidence, cited only as
  a pattern precedent, not as evidence this works on iOS.
- **Claude's and ChatGPT's own mobile artifact/canvas rendering implementations are not publicly
  documented.** Search found no engineering post, source, or credible reverse-engineering writeup
  confirming how either renders artifacts/canvas content in their iOS/Android apps (WebView vs.
  native re-render vs. server-side screenshot, etc.). One community reverse-engineering post
  exists for ChatGPT's *Apps SDK* iframe sandbox on desktop/web
  (https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3) but it was
  not fetched this session and does not address mobile-app WebView behavior. This is a genuine
  **gap** — cannot be used to infer feasibility either way.

## 6. Verdict shape — failure modes enumerated

| # | Failure mode | Status |
|---|---|---|
| 1 | Classic bundler's relay-worker boot (`getServiceWorker()` → `startServiceWorker()`) throws when `navigator.serviceWorker` is absent — no fallback path exists in the traced source | **Confirmed** (read directly in `packages/app/src/sandbox/worker/{utils,index}.ts`, the exact code the self-hosted `www` build ships, per the official hosting guide) |
| 2 | `navigator.serviceWorker` is undefined in stock WKWebView (iOS, all recent versions through the 2025 evidence available) | **Confirmed** (caniwebview.com blanket-unsupported listing, Apple DTS Feb 2025 accepted answer, independent Apr 2025 re-test, Capacitor issue #7069 closed not-planned) |
| 3 | App-Bound Domains (`WKAppBoundDomains` + `limitsNavigationsToAppBoundDomains`) reliably unlocks Service Workers for our bundler iframe | **Disproven as a reliable fix** — WebKit's own blog never lists SW among the restored APIs and states the domain check is top-level-frame-only; a 2025 developer re-test explicitly found it "does not work"; Apple never confirmed the OP's contrary claim |
| 4 | Combined effect of (1)+(2): the classic bundler cannot boot in iOS WKWebView, top-level or iframe, App-Bound or not | **Confirmed by composition of #1 and #2/#3** — this is the load-bearing conclusion for iOS |
| 5 | `capacitor://` ↔ `https://` protocol mismatch blocks direct DOM/property access across the iframe boundary | **Confirmed**, but scoped — does not itself block iframe loading or `postMessage` |
| 6 | Sandpack's own parent↔iframe `postMessage` breaks due to `capacitor://` parent origin | **Disproven for the `sandpack-client` code actually read** — send side targets the bundler's own https origin (targetOrigin doesn't check sender origin); receive side filters by window-reference identity, not origin string. **Unknown** for the bundler's own iframe-side listener code, which was not inspected (not published in the same readable form) |
| 7 | Real-world `document.referrer`-based rejection of a `capacitor://`-originated `postMessage`, observed in an unrelated third-party iframe | **Confirmed as a general risk pattern** (Ionic Forum, Capacitor 4.1.0, physical iOS only); **not confirmed** for Sandpack's specific bundler code, which was not found to check `document.referrer` in the parts read |
| 8 | Android WebView SW support exists at the framework level | **Confirmed** (API 24+, native `ServiceWorkerController`) |
| 9 | Android WebView cross-origin/third-party storage partitioning affects a bundler iframe registering its own SW inside our `https://localhost` app origin | **Unknown — must spike on a real device.** No source found that confirms or refutes this for Android WebView specifically (only general Chrome desktop/mobile documentation was found) |
| 10 | Any prior art (Sandpack, CodeSandbox embeds, LibreChat mobile, or similar) running successfully inside Capacitor/Cordova/RN WebViews | **Not found** — absence of evidence, not evidence of absence; plausibly explained by #1's fail-fast nature deterring anyone from getting far enough on iOS to write it up, but Android was equally unfound |

### Per-platform verdict

- **iOS WKWebView (`capacitor://` top frame): BLOCKED.** Not a "spike to find out" item — the
  classic bundler's own source code throws on the exact condition (`navigator.serviceWorker`
  absent) that current, dated (2025) evidence says is WKWebView's actual state, and the one
  candidate workaround (App-Bound Domains) has an on-record failed re-test rather than
  ambiguous silence. Overturning this verdict would require either Apple shipping WKWebView SW
  support (no announcement found through mid-2026) or Sandpack shipping a non-SW code path for
  its classic bundler (not found in the source read).
- **Android WebView (`https://localhost` top frame): MUST-SPIKE.** No structural blocker
  comparable to iOS was found — the SW API exists at the framework level and Chromium's engine
  underlies both. The unresolved variable is third-party storage-partitioning behavior for a
  cross-origin bundler iframe's own service worker inside this specific top-level scheme/host
  combination, which was not confirmed either way by any source found. This needs a real-device
  (or real-emulator) test of the actual self-hosted bundler + our `capacitor.config` before any
  go/no-go call, not further literature search.

## Sources consulted (fetched or read directly this session)

- https://sandpack.codesandbox.io/docs/resources/faq
- https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler
- https://sandpack.codesandbox.io/docs/advanced-usage/client
- https://sandpack.codesandbox.io/docs/advanced-usage/bundlers
- https://github.com/codesandbox/sandpack/issues/1091
- https://github.com/codesandbox/sandpack/blob/main/sandpack-client/src/clients/runtime/iframe-protocol.ts
- https://github.com/codesandbox/sandpack/blob/main/sandpack-client/src/clients/runtime/index.ts
- https://github.com/codesandbox/sandpack/blob/main/sandpack-client/src/clients/base.ts
- https://github.com/codesandbox/codesandbox-client/blob/master/packages/app/src/sandbox/worker/utils.ts
- https://github.com/codesandbox/codesandbox-client/blob/master/packages/app/src/sandbox/worker/index.ts
- https://github.com/codesandbox/codesandbox-client (package.json `build:sandpack` script; `packages/app/package.json` `build:sandpack-sandbox` script — via GitHub code search)
- https://caniwebview.com/features/web-feature-service-workers/
- https://webkit.org/blog/10882/app-bound-domains/
- https://developer.apple.com/forums/thread/773539
- https://github.com/ionic-team/capacitor/issues/7069
- https://github.com/ionic-team/capacitor/issues/2847
- https://capacitorjs.com/docs/config
- https://forum.ionicframework.com/t/iframe-not-not-responding-to-postmessage-call-on-ios/234426
- https://developer.android.com/reference/android/webkit/ServiceWorkerController
- https://developer.android.com/reference/android/webkit/ServiceWorkerWebSettings
- https://privacysandbox.google.com/cookies/storage-partitioning
- https://www.librechat.ai/docs/features/artifacts

Additional sources referenced only via search-tool extraction (not independently re-fetched;
graded Inferred where used above): Apple Developer Forums thread 684591 (offline support in
iframes / 3-worker limit); ionic-team/capacitor discussion #3548 and issue #4122 (App-Bound
Domains implementation history); ionic-team/capacitor PR #4789 (`limitsNavigationsToAppBoundDomains`
config option); Chromium issue 40052335 (cross-origin iframe SW in Android WebView, VS Code
pattern reference).
