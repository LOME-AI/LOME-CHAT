# Pyodide inside Capacitor WebViews — 2026 compatibility research

Question: does Pyodide (latest stable, in a web worker, self-hosted assets) work inside a
Capacitor app's WebView — iOS WKWebView (`capacitor://` scheme) and Android WebView
(`https://localhost` scheme)?

Repo context (Verified, `apps/web/package.json:` `"@capacitor/core": "^8.4.0"`): this
project is on Capacitor 8.x, which post-dates every relevant upstream fix found below.

---

## 1. Pyodide version

- **Latest stable: Pyodide 314.0.2**, released 2026-06-30, preceded by 314.0.1
  (2026-06-26) and 314.0.0 (2026-06-09). Verified —
  [pyodide.org/en/stable](https://pyodide.org/en/stable/index.html),
  [changelog](https://pyodide.org/en/stable/project/changelog.html).
- **314.x is a new versioning scheme** replacing `0.29.x` — Pyodide now version-numbers
  itself after the bundled CPython release and plans one major release per year in sync
  with CPython. Verified — [Pyodide 314.0 release post](https://blog.pyodide.org/posts/314-release/).
- Immediately prior line was `0.28.x`/`0.27.x` (last `0.27` release was `0.27.7`; `0.28.3`
  published 2025-09-22). Verified via npm/GitHub release metadata cross-checked against
  the changelog.

---

## 2. WASM support in WKWebView (iOS)

- **`wasm-unsafe-eval` CSP directive is supported in WebKit since it landed in WebKit
  nightly ~May 2022**, shipping in **Safari 16**. Since WKWebView uses the system
  WebKit/JavaScriptCore, any WKWebView on **iOS 16+** supports `wasm-unsafe-eval`,
  letting you scope a CSP to allow `WebAssembly.instantiate`/`compileStreaming` without
  the much broader `unsafe-eval`. Verified —
  [WebKit bug 197759](https://bugs.webkit.org/show_bug.cgi?id=197759),
  cross-referenced against the W3C webappsec-csp mailing list thread and caniuse.
  Capacitor's own minimum iOS target is 15+ (Verified, capacitorjs.com/docs/ios), so an
  app supporting iOS 15 needs a fallback `unsafe-eval` CSP entry for that one version, or
  to raise its floor to 16.
- **JIT / compile path**: WKWebView's JavaScriptCore runs WASM through the normal
  in-process, sanctioned WebView JIT — this is the *only* JIT-capable path allowed for
  third-party App Store apps (an app's own embedded JavaScriptCore, outside WKWebView, is
  interpreter-only with no JIT). Running WASM inside WKWebView is the standard, App
  Store-accepted mechanism; Apple has not published an official statement blessing it
  but it is widespread practice and Apple has never rejected apps on this basis in
  discussion threads found. Inferred —
  [Hacker News #40726948](https://news.ycombinator.com/item?id=40726948),
  [Apple Developer Forums thread on WASM in iOS apps](https://developer.apple.com/forums/thread/705778)
  (no reply from Apple staff, so "App Store accepted" is Inferred from prevalence, not an
  Apple policy statement).
- **Instantiating large (~7–20MB) WASM modules**: no hard WKWebView-specific size cap was
  found. The real-world failure mode found is not a size ceiling but a **streaming-fetch
  corruption bug specific to Capacitor's `CapacitorHttp` plugin** (see §3) — with plain
  `fetch()` (CapacitorHttp disabled, the default), a 9.4MB `pyodide.asm.wasm` streams and
  compiles successfully in native iOS/Android per the linked repro. Verified —
  [Capacitor issue #6123](https://github.com/ionic-team/capacitor/issues/6123) and its
  [repro repo](https://github.com/KevinKelchen/capacitor-http-wasm-issue). One general
  WKWebView note found: some engines throw `RangeError` for WASM compilation attempted
  synchronously on the UI thread with very large buffers — not applicable here since
  Pyodide compiles inside a worker off the UI thread. Inferred from general WASM/WebKit
  literature, not Pyodide-specific.
- **Actual module size, current stable (314.0.2)**: `pyodide.asm.wasm` in the `full`
  distribution is **9.6MB** (Verified, HTTP `content-length` from jsdelivr CDN
  `https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.asm.wasm` = 9,609,998 bytes).
  For comparison, 0.28.3's `pyodide.asm.wasm` is 8.6MB. The full unpacked distribution is
  "200+ megabytes" (Verified, [downloading-and-deploying
  docs](https://pyodide.org/en/stable/usage/downloading-and-deploying.html)); the
  `pyodide-core` tarball is the minimal self-hostable subset (interpreter + stdlib, no
  scientific packages) — the docs describe it as the "minimal set of files needed to
  start Pyodide" but don't state its compressed size in the fetched page. numpy + pandas
  wheels add roughly another ~10.5MB fetched on top per a third-party sizing tool
  (`pyodide-pack`); Inferred / not independently re-verified this session.

**Verdict — §1/§2**: WASM execution itself is **not blocked** in WKWebView on iOS 16+;
CSP needs `wasm-unsafe-eval` (or `unsafe-eval` to also cover iOS 15). Confirmed by
multiple independent sources.

---

## 3. Memory on iOS

- **iOS page memory budget**: independent of WASM, iOS's Jetsam subsystem enforces a
  device-wide, more-aggressive-than-WebKit memory ceiling on the WebView's content
  process; practical web-page budgets land roughly **300–450MB** on current mainstream
  devices, with the crash signature `com.apple.WebKit.WebContent killed by jetsam reason
  highwater`. Inferred (synthesized from a deep-dive analysis, not an Apple-published
  number) — [Catch Metrics: RAM Internals in WebKit](https://www.catchmetrics.io/blog/deep-dive-ram-internals-webkit),
  corroborated by an [Apple Developer Forums thread](https://developer.apple.com/forums/thread/678318)
  showing the same crash signature.
- A separate, differently-sourced data point (Hacker News, citing an unsourced
  StackOverflow answer) put Safari's per-page ceiling around **1.5GB on iPhone 12 Pro,
  ~3GB after a fresh device reboot, decaying back toward 1.5GB over days**, and ~3GB
  consistently on iPhone 15 Pro/Pro Max. This **conflicts** with the 300–450MB figure
  above by roughly an order of magnitude. Neither source is Apple-official; both are
  Assumed/Inferred third-party measurements and they do not agree — treat the true
  ceiling as **device- and iOS-version-dependent and unconfirmed**, not a single number.
  Flagging the conflict rather than averaging it. Sources:
  [Hacker News #39039593](https://news.ycombinator.com/item?id=39039593) (citing SO),
  vs. Catch Metrics above.
- **Pyodide's own WASM heap ceiling is a separate, harder limit**: Pyodide is built
  `wasm32` with a **~2GB heap ceiling** per its default build (a Memory64 build to lift
  this exists only as an open discussion, not shipped), and Memory64 is **not supported
  in WebKit/Safari at all** (shipped in Firefox 134 / Chrome 133 only) — so on iOS the
  2GB wasm32 ceiling cannot be worked around even in principle. In practice the iOS page
  memory budget (whichever of the two conflicting figures above is closer to truth) is
  reached well before the 2GB wasm32 ceiling. Verified re: Memory64 browser support —
  [v8.dev](https://v8.dev/blog/4gb-wasm-memory),
  [SpiderMonkey blog](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html);
  Inferred re: Pyodide's practical 2GB ceiling — [xlwings Lite
  limitations doc](https://lite.xlwings.org/limitations) plus [Pyodide discussion
  #5140](https://github.com/pyodide/pyodide/discussions/5140).
- **Baseline Pyodide footprint**: not independently benchmarked this session; download
  weight (not runtime RSS) for interpreter+stdlib+numpy+pandas is reported around ~17-20MB
  compressed transfer by a third-party sizing tool (`pyodide-pack`, PyPI) — this is
  download size, not decompressed/runtime memory, which is typically several multiples
  higher for a Python interpreter + numpy/pandas combination. No concrete "runtime MB
  with numpy/pandas/matplotlib loaded" figure was found from a primary source; treat as a
  **gap** requiring an actual device measurement.
- **Real-world Pyodide-on-iOS-Safari crash reports exist and are recent, not historical**:
  a regression in **Pyodide 0.27.1–0.27.6** (all affected; 0.27.0 was fine) caused loading
  to hang or crash on **iOS 18.3.1+** specifically — root cause confirmed as a WebKit bug
  in `wasm-gc` (WASM garbage-collection proposal) support, exposed by a CPython
  interpreter-trampoline change that started using `wasm-gc` in 0.27.1. Symptom: infinite
  spinner or "A problem repeatedly occurred" page crash; sometimes "Maximum call stack
  size exceeded" in embedded (iframed) contexts. Verified — [issue
  #5428](https://github.com/pyodide/pyodide/issues/5428),
  [fix PR #5445](https://github.com/pyodide/pyodide/pull/5445) (patch:
  `0009-Skip-wasm-gc-on-iOS-Safari-where-it-s-broken.patch`, detects iOS via
  `navigator.platform` UA-sniffing and skips the broken `wasm-gc` path there; upstream
  companion fix landed in CPython, [python/cpython#130418](https://github.com/python/cpython/pull/130418)).
  **Fixed in Pyodide 0.27.3.** The maintainers explicitly acknowledged UA-sniffing is an
  ugly stopgap, not a principled fix — meaning the underlying WebKit `wasm-gc` bug itself
  is still open upstream in WebKit as far as this research found; Pyodide merely routes
  around it. Since **314.0.2 post-dates 0.27.3 by more than a year**, this specific
  regression should not reproduce on current stable, but it demonstrates the risk class:
  **WebKit's WASM implementation has shipped iOS-specific correctness bugs that only
  surface in that engine**, and Pyodide does not run Safari/WebKit in its own CI.
  Confirmed no-Safari-CI: Pyodide's test suite runs only recent Chrome and Firefox; a
  request to add WebKit-based CI (issue #989) remains open. Verified —
  [discussion #2149](https://github.com/pyodide/pyodide/discussions/2149).
- **A second, still-open iOS-only issue** exists in the same regression window: **iPad on
  iOS 18, Pyodide 0.27.1 through 0.27.6, a distinct FS-related crash** ("harakiri") not
  fixed by the wasm-gc patch — explicitly version-scoped by the reporter as "0.27.0 fine,
  0.27.1–0.27.6 broken, iPhone fine, older iPadOS fine." Status of this against 314.x is
  **unconfirmed** — not established whether it's fixed. Verified issue exists, status
  unconfirmed — [issue #5670](https://github.com/pyodide/pyodide/issues/5670).
- A related, apparently-still-relevant issue: `FS.syncfs(populate=true)` throws a
  `TypeError` on iPad (both Safari and Chrome-on-iOS) but not on desktop or Android
  Chrome — relevant only if the plan uses OPFS-backed persistence. Verified, open —
  [issue #4057](https://github.com/pyodide/pyodide/issues/4057).

**Verdict — §3**: Memory is the **real, still-live risk** on iOS. Two independent
non-Apple sources disagree by ~5-10x on the practical per-page ceiling (300–450MB vs.
1.5–3GB) — this alone means the number must come from an on-device test, not a citation.
Separately, Pyodide has a track record (as recently as the 0.27.x line, roughly early-to-mid
2025) of iOS/WebKit-only crashes rooted in WebKit engine bugs, not Pyodide bugs, that
Pyodide could only route around, not fix at the source, and that its own CI cannot catch
because Pyodide runs no WebKit CI. Nothing found is 314.x-specific or Capacitor-specific;
absence of a currently-open 314.x iOS crash report is not proof of absence.

---

## 4. Web workers under Capacitor

- **Worker script loading itself**: no evidence found of `new Worker(url)` being blocked
  by the `capacitor://` (iOS) or `https://localhost` (Android) schemes — Capacitor serves
  all app assets, including worker scripts, from its embedded local web server under that
  origin, so a worker script requested same-origin should load like any other same-origin
  asset. This is **Inferred**, not directly confirmed by a Capacitor-specific report;
  no direct "new Worker() fails under capacitor://" bug report was found in this
  research, and no direct confirmation "it definitely works" either — **treat as a gap
  requiring a spike**, not a green light.
- **What *is* confirmed broken**: **Capacitor plugins are not accessible from web/service
  workers on either platform.** The Capacitor bridge is only exposed on `window`, which
  workers don't have; there's an open feature request to change this
  ([issue #6629](https://github.com/ionic-team/capacitor/issues/6629)), and a confirmed
  Android bug report that even the `self.window = self` shim doesn't help
  ([issue #6309](https://github.com/ionic-team/capacitor/issues/6309)). **This is not a
  blocker for Pyodide itself** (Pyodide doesn't need Capacitor plugin access inside the
  worker) but rules out calling Capacitor native APIs (filesystem, clipboard, etc.)
  directly from the same worker that runs Pyodide — any such bridging must be done via
  `postMessage` back to the main thread.
- **Service workers specifically are broken on iOS**: iOS reserves `http`/`https` for
  remote URLs, so service worker registration doesn't work against the app's own
  `capacitor://localhost` origin without extra native plugin work (App-Bound Domains) or
  a third-party plugin. Verified —
  [issue #7069](https://github.com/ionic-team/capacitor/issues/7069),
  [capacitor-plugin-service-worker](https://github.com/fellowapp/capacitor-plugin-service-worker).
  **This does not affect a plain dedicated Web Worker** (which is what the Pyodide plan
  calls for) — only Service Workers are affected, and the distinction matters: don't
  conflate the two.
- **Fetching `.whl`/`.zip`/`.wasm` assets from the app scheme**: two real, historically
  confirmed bugs, **both fixed and both pre-dating Capacitor 8** (this repo's version):
  1. **Wrong MIME type for local `.wasm` files** (`Incorrect response MIME type. Expected
     'application/wasm'`) — WKWebView's local scheme handler didn't map the `.wasm`
     extension to `application/wasm`. **Fixed in Capacitor 5.1.0** (2023-06-29),
     [PR/issue #6675](https://github.com/ionic-team/capacitor/issues/6675),
     commit `d7856de`. Verified via Capacitor's own CHANGELOG.md.
  2. **`CapacitorHttp`'s fetch-patching corrupts/truncates large binary streams**, causing
     `WebAssembly.instantiateStreaming()` to fail with "unexpected end of stream" /
     "fell off end" on a 9.4MB module, on **both** native iOS and Android — reproduced
     with a `pyodide.asm.wasm`-sized module. Root cause: `CapacitorHttp` (an opt-in
     compatibility plugin that monkey-patches `fetch`/`XMLHttpRequest` to route through
     native HTTP) breaks streaming binary responses. **Fixed in Capacitor 6.0.0-rc.1**
     (2024-03-15), [issue #6818](https://github.com/ionic-team/capacitor/issues/6818),
     commit `b853d06`. Verified via Capacitor's own CHANGELOG.md and the original repro
     ([issue #6123](https://github.com/ionic-team/capacitor/issues/6123)).
  Both fixes are several major versions behind this repo's Capacitor `^8.4.0` — **as long
  as `CapacitorHttp` is not explicitly re-enabled**, wasm asset fetching should work with
  correct MIME types and uncorrupted streaming. `CapacitorHttp` is opt-in, not default, in
  modern Capacitor (Inferred from the plugin's documented purpose as a compatibility
  shim for CORS-restricted native requests, not the default fetch path — not explicitly
  re-verified against current default-config docs this session).
- **CORS**: Capacitor's origin (`capacitor://localhost` on iOS, `https://localhost` on
  Android) is a normal, single origin for same-origin asset fetches from the app's own
  bundle — CORS only becomes relevant if fetching Pyodide assets from a *different*
  origin (e.g., a CDN) rather than self-hosting on the app's own bundled assets, which is
  the plan stated in the question. Self-hosted, same-origin assets avoid CORS entirely.
  Verified as general same-origin behavior; not Pyodide-specific.

**Verdict — §4**: No confirmed blocker for a plain dedicated Worker loading Pyodide from
same-origin self-hosted assets on Capacitor 8.x. The two wasm-specific Capacitor bugs
that would have blocked this are both fixed upstream, years before this repo's Capacitor
version. The main unconfirmed item is worker creation itself under `capacitor://` —
plausible, not directly evidenced either way — and it is cheap to spike directly.

---

## 5. Android WebView

- **WASM/CSP**: no Android-specific WASM blocker was found; Android's default
  `androidScheme` is `https` (not a custom scheme), so Android sidesteps the entire class
  of custom-scheme MIME/streaming issues that iOS needed dedicated Capacitor fixes for.
  Verified — [Capacitor config docs](https://capacitorjs.com/docs/config)
  (`server.androidScheme`, default `https`).
- **Memory**: no Android-WebView-specific Pyodide memory report or crash threshold was
  found this session (searches for "Android WebView Pyodide worker memory" returned only
  generic Android WebView crash-troubleshooting content and unrelated Chromium OOM bug
  threads from over a decade old). This is a **genuine gap** — Android WebView memory
  behavior for a Pyodide-sized WASM heap is **unknown until device-tested**, not
  disproven or confirmed either way.
- **Workers**: same plugin-inaccessibility-from-worker caveat as iOS
  ([issue #6309](https://github.com/ionic-team/capacitor/issues/6309), Android-specific
  repro); no evidence found of worker *creation* itself being blocked on Android.
- One tangential, non-Pyodide-specific data point: a Capacitor maintainer discussion
  attributes general Android WebView performance complaints to the underlying Chromium
  WebView component itself (not Capacitor), strong enough that some teams reportedly move
  off Capacitor for it — [discussion #3899](https://github.com/ionic-team/capacitor/discussions/3899).
  This is atmospheric, not a specific Pyodide finding; Inferred as weak background signal
  only, not a device-test substitute.

**Verdict — §5**: Android is very likely lower-risk than iOS (standard `https` origin, no
custom-scheme MIME/streaming bugs found or historically reported), but this is **absence
of negative evidence, not positive confirmation** — no one appears to have written up
"Pyodide works fine in Capacitor Android" either. Must-spike, same as iOS, just with a
different risk profile (memory/perf unknowns vs. iOS's engine-correctness unknowns).

---

## 6. Prior art

- **React Native + Pyodide is explicitly unsolved upstream**: an open Pyodide
  documentation request ([issue #2343](https://github.com/pyodide/pyodide/issues/2343))
  asks for guidance on running Pyodide on mobile via React Native, with the author
  reporting no method worked satisfactorily; a related bug
  ([issue #2549](https://github.com/pyodide/pyodide/issues/2549)) shows `import(url)`
  failing when trying to load Pyodide inside a React Native WebView. This is Verified as
  an open/unsolved gap specifically for **React Native's WebView**, which is a different
  embedding than Capacitor's — RN's `react-native-webview` component has different
  bridging and script-injection semantics than Capacitor's WKWebView/Android WebView
  hosting. **Do not generalize the RN difficulty to Capacitor** — no evidence found that
  Capacitor shares RN's specific failure mode; the two are architecturally different
  enough (Capacitor *is* the WebView host; RN's WebView is a bridged child component)
  that this is Inferred-not-transferable rather than an analogous data point.
  Cross-reference confirming the RN/Capacitor architectural distinction is Inferred, not
  independently sourced.
  Cross-reference: Capacitor's own docs materials on this were WebFetched but yielded no
  overlap.
- **JupyterLite on iPad**: confirmed to **largely work**, per a search-engine synthesis
  (not independently WebFetched from jupyterlite.org this session) — "largely works on
  iPad… since it needs no dedicated application server [and] is served via static
  HTTP(S)," with the caveats that touch-UI has some rough edges (e.g. file
  download/context-menu issues) and Safari isn't part of Pyodide's CI so WebKit-specific
  bugs can surface. This is **regular iPad Safari**, not a WKWebView-in-an-app context,
  and not independently re-verified by opening jupyter.org/try-jupyter this session —
  **Inferred**, sourced from a search synthesis rather than a fetched primary page.
  This is the strongest positive "Pyodide works on iOS WebKit in general" signal found,
  but it is Safari-proper, not WKWebView-hosted-by-a-native-app, so it does not fully
  transfer to the Capacitor case (no service worker, no custom scheme, no CapacitorHttp
  involved in Safari-proper).
- **No example found of a shipped Capacitor+Pyodide app** (Pythonista-alike, Jupyter
  mobile client, or open-webui-style wrapper). The closest concrete artifacts found were:
  a generic `pyodide-react` example (not mobile-specific,
  [aqemery/pyodide-react](https://github.com/aqemery/pyodide-react)), and the two Pyodide
  GitHub discussions already cited (#2188, offline-iOS-WKWebView; and
  [discussion #4764](https://github.com/pyodide/pyodide/discussions/4764), "Loading
  Pyodide locally (offline) in an Ionic/Capacitor app running on iOS failed" — now read
  in full, see "Discussion #4764" section below). This absence is itself informative:
  **this appears to be
  under-trodden ground** — nobody has published a "yes, Pyodide-in-Capacitor works,
  here's how" writeup that this research surfaced.

---

## 7. Verdict shape — concrete failure modes, by platform

**iOS WKWebView (`capacitor://` scheme):**

| Risk | Status |
|---|---|
| WASM execution blocked entirely | **Disproven** — works on iOS 16+ with `wasm-unsafe-eval` CSP (Verified, WebKit bug 197759) |
| `.wasm` MIME-type failure on local scheme | **Disproven for Capacitor ≥5.1.0** — fixed upstream (Verified, changelog) |
| `CapacitorHttp` corrupting the wasm stream | **Disproven as long as CapacitorHttp stays disabled** (default) — fixed in Capacitor ≥6.0.0-rc.1 for the case it's used anyway (Verified) |
| WebKit `wasm-gc` correctness bug crashing load | **Confirmed as a real, recent (2025) failure class**, fixed for that specific instance in Pyodide 0.27.3, but the underlying WebKit bug appears unpatched at the engine level — meaning *a future, different* WebKit WASM bug hitting iOS-only is a live, not hypothetical, risk class. **Must-monitor**, not disprovable in the abstract. |
| Per-page memory ceiling | **Unknown/unconfirmed** — two non-Apple sources disagree 5-10x (300–450MB vs 1.5–3GB); genuinely **must-device-test** |
| Pyodide's wasm32 2GB heap ceiling | **Confirmed real** and confirmed **not liftable on iOS** (Memory64 absent from WebKit) — a hard ceiling if ever approached, though ordinary page-memory limits (whichever figure is right) likely bind first |
| Worker creation under `capacitor://` | **Unknown** — no direct evidence either way; cheap to spike |
| First-hand "Pyodide + Ionic/Capacitor + iOS failed" report (discussion #4764) | **Read in full — root cause was already-fixed MIME-type bug, confirmed absent from this repo's installed Capacitor version. See "Discussion #4764" section below.** |

**Overall iOS verdict: must-spike, not blocked.** No disproof of feasibility was found;
the known historical blockers are fixed in the Capacitor version this repo uses; the
open risks (memory ceiling, worker creation under custom scheme, WebKit's history of
WASM-correctness bugs surfacing only on iOS) are exactly the kind that require an
on-device build, not further literature review.

**Android WebView (`https://localhost` scheme):**

| Risk | Status |
|---|---|
| WASM execution blocked | **Disproven** — no evidence of any restriction; Chromium-based WebView has mature WASM support |
| Custom-scheme MIME/streaming bugs | **N/A** — Android's default scheme is already `https`, sidestepping the whole bug class that required iOS-specific Capacitor fixes |
| Worker plugin access | Same caveat as iOS (plugins unreachable from workers) — **not a Pyodide blocker** |
| Memory ceiling for a Pyodide-sized heap | **Unknown** — no Pyodide-specific or Capacitor-specific report found; **must-device-test**, and must be tested across a low-end/mid-tier Android device, not just flagship, given Android's much wider device-memory spread |

**Overall Android verdict: must-spike, lower a priori risk than iOS** (no known
Capacitor-Android-specific wasm bug class found), but memory behavior on low/mid-tier
Android hardware is a genuine unknown, not merely unresearched-favorably.

---

## Gaps

- No first-party device measurement of Pyodide's runtime RSS with numpy+pandas+matplotlib
  loaded, on either platform — only download-weight figures were found.
- ~~[Discussion #4764] not opened/read~~ — **resolved, see "Discussion #4764" section
  below.**
  `pyodide.org/en/stable/usage/downloading-and-deploying.html` returned HTTP 403 to the
  default WebFetch tool (bot-blocked); content was recovered via `curl` with a browser
  User-Agent instead, but this means some of that page's content (e.g. exact
  `pyodide-core` tarball byte size) was only partially extracted.
- Real iOS-page-memory-ceiling figures conflict by 5-10x between the two non-Apple
  sources found (§3) — no Apple-published number exists to resolve this; it needs a
  device test, not more search.
- No report found either confirming or denying that Android WebView's default
  configuration in Capacitor 8.x has any wasm-specific quirk analogous to the iOS ones —
  absence of a bug report is not proof of absence, just of it being less-discussed.

---

## Discussion #4764

Full text of [pyodide/pyodide discussion #4764](https://github.com/pyodide/pyodide/discussions/4764)
("Loading Pyodide locally (offline) in an Ionic/Capacitor app running on iOS failed") and
its one linked commit were read in full this follow-up. Verified.

**What exactly failed:** Poster (Klaus-Pete, posted 2024-05-15) built an Ionic/Capacitor
app loading **Pyodide 0.25.1** fully offline from a bundled `assets/` folder
(`loadPyodide({ indexURL: "/assets/" })`), on an iPhone. It worked on Android and desktop
but failed on iOS with, verbatim:

> `wasm streaming compile failed: TypeError: Unexpected response MIME type. Expected 'application/wasm'`
> `falling back to ArrayBuffer instantiation`

(both prefixed with Capacitor's `⚡️ [warn]` log marker). This is the exact same MIME-type
bug documented in §4 of this doc (Capacitor issue #4444 / fixed by #6675). **Neither a
Capacitor core version nor an iOS version was stated in the post** — only "iPhone."

**Resolution:** Self-resolved by the poster in the discussion's only reply, same day.
Fix: add a `UTExportedTypeDeclarations` entry to the iOS project's `Info.plist`, mapping
the `wasm` file extension to the `application/wasm` MIME type, per Capacitor commit
[`7c0d58c`](https://github.com/ionic-team/capacitor/commit/7c0d58cc84472ceee26c96142122d9359efbe19c)
(2022-04-29, "Fixes WASM mimetype for static file server in a production-bundled app").
Read that commit directly: it adds a `public.data`-conforming UTI block declaring
`wasm → application/wasm` to `ios-template/App/App/Info.plist` — i.e. a **per-app config
workaround**, applied by hand to the generated iOS project.

**This Info.plist workaround is now obsolete and superseded, confirmed two ways:**

1. **A stronger, non-app-config fix landed natively in Capacitor core itself**, over a
   year after the poster's workaround and independent of it: commit
   [`d7856de`](https://github.com/ionic-team/capacitor/commit/d7856de62a4c058ac474ae91a5fd221dabf99c0a)
   (2023-06-26, Capacitor **5.1.0**, closing issue #6675) hardcodes `"wasm":
   "application/wasm"` directly into the MIME-type lookup table in
   `ios/Capacitor/Capacitor/WebViewAssetHandler.swift` — the native Swift class that
   serves all local app assets for every Capacitor iOS app. This ships inside the
   `@capacitor/ios` package itself, so it applies automatically to any app on Capacitor
   ≥5.1.0 with no per-app Info.plist edit required.
2. **The `Info.plist` `UTExportedTypeDeclarations` block from commit `7c0d58c` is gone
   from Capacitor's current iOS templates.** Verified by fetching both
   `ios-pods-template/App/App/Info.plist` and `ios-spm-template/App/App/Info.plist` from
   the `main` branch (`raw.githubusercontent.com/ionic-team/capacitor/main/...`) — neither
   contains a `UTExportedTypeDeclarations` key. (The single `ios-template/` path from 2022
   was split into `-pods-` and `-spm-` variants in October 2023; the block did not carry
   forward to either successor, consistent with it having been superseded by the native
   Swift fix rather than merely lost.)
3. **Directly confirmed present in this repo's installed dependency**, not just inferred
   from Capacitor's public repo history: `grep -n "wasm"` against
   `node_modules/.pnpm/@capacitor+ios@8.4.0_@capacitor+core@8.4.0/node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewAssetHandler.swift`
   returns `477:        "wasm": "application/wasm",`. Verified directly against this
   repo's actual installed `@capacitor/ios@8.4.0`, not inferred from a changelog date.

**Does this change the iOS verdict?** No change to must-spike-not-blocked, but it
**strengthens the "disproven" MIME-type row from a version/changelog inference to a
direct, this-repo-specific confirmation** — the exact failure discussion #4764 describes
cannot reproduce on this repo's installed Capacitor version, verified by reading the
actual shipped Swift source rather than trusting the changelog date alone.

**One practical nuance discussion #4764 surfaces that the earlier changelog-only research
did not**: the poster's fix required editing a project's own `Info.plist`/native project
files, which only take effect through `npx cap sync` (CocoaPods/SPM re-resolve) — a
`package.json` version bump alone does not update the native Swift/Pods sources already
materialized inside `apps/web/ios/`. This adds a concrete spike checklist item:

- **New spike checklist item**: before the device spike, confirm the *materialized*
  native iOS project in `apps/web/ios/` (not just `package.json`) actually contains the
  updated `WebViewAssetHandler.swift` — i.e. that `npx cap sync ios` (or a fresh `cap add
  ios`) has been run since upgrading to Capacitor ≥5.1.0, so the fix in the built app
  matches what's confirmed present in `node_modules`. A stale native project directory
  generated under an older Capacitor version, never re-synced, could still exhibit the
  discussion #4764 failure even with a current `@capacitor/core` in `package.json`.
