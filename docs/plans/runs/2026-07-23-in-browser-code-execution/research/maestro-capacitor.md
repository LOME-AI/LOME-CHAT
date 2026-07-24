# Maestro for a Capacitor in-app WebView / nested-iframe proof — research (2026-07-23)

## Context (repo grounding — Verified)

- `apps/web` is a Capacitor app: `apps/web/capacitor.config.ts` exists, `appId: 'ai.hushbox.app'`,
  and both `apps/web/ios/` and `apps/web/android/` platform directories are present in the
  checkout — file paths verified by directory listing this session.
  (`/workspace/popper-mobile/.superset/projects/HushBox/apps/web/capacitor.config.ts`)
- No `sandpack` usage exists yet in `apps/web/src` (grep found nothing); `TECH-STACK.md` lists
  Sandpack as **planned**, not built — so the "sandboxed iframe preview" target of this proof is a
  feature that does not exist in the codebase yet. The only current `iframe` reference in
  `apps/web/src` is unrelated (`components/native-assets/social-banner.tsx`). — Verified (grep,
  this session).

---

## 1. Maestro version, health, install, license

- **Latest release (Verified):** `cli-2.7.0`, tagged July 20, 2026, per the GitHub releases page.
  Recent line: 2.7.0 → 2.6.1 → 2.6.0 → 2.5.1 → 2.5.0 → 2.4.0.
  https://github.com/mobile-dev-inc/maestro/releases
- **Notable recent changes (Inferred, from maestro.dev blog posts surfaced in search, not
  individually fetched):**
  - CLI 2.4.0 (Apr 3, 2026): iOS 26 device support (`--device-os=iOS-26`); deprecated
    `--os-version` / `--android-api-level` / `--ios-version` in favor of `--device-model` /
    `--device-os`. https://maestro.dev/blog/maestro-cli-2-4-0
  - CLI 2.6.0 (~May 2026): "Maestro Viewer" (live device view for coding agents); Rhino JS engine
    fully removed, GraalJS is now the only `evalScript`/`runScript` engine.
    https://maestro.dev/blog/maestro-cli-v2-6-0
  - CLI 2.7.0 (Jul 20, 2026): title/details not independently fetched — flagged as a gap below.
- **Maintenance health (Verified):** GitHub org `mobile-dev-inc`, repo `maestro` — ~15,000 stars,
  ~890 forks, ~389 open issues, 1,708+ commits on main, last push July 21, 2026 at the time of the
  search snapshot; releases every ~10 days on average over 4 years. Actively triaged (issues opened
  and answered within days). https://github.com/mobile-dev-inc/maestro
- **Branding note (Verified):** the project now brands as **Maestro.dev** (docs at
  `docs.maestro.dev`, marketing at `maestro.dev`, commercial "Maestro Cloud" + "Maestro Studio"),
  evolved from the original "mobile.dev" identity — the CLI install URL still lives under
  `get.maestro.mobile.dev`. GitHub org name (`mobile-dev-inc`) is unchanged.
- **License (Verified):** Apache-2.0. CLI and framework are fully open source and free to use
  locally/in your own CI at no cost; **Maestro Cloud** and **Maestro Studio Desktop** are separate
  commercial/closed-source offerings layered on top.
- **Install (Verified):**
  ```
  curl -fsSL "https://get.maestro.mobile.dev" | bash
  ```
  Requires Java 17+. macOS/Linux/WSL via the script; a separate docs page covers native Windows.
  https://github.com/mobile-dev-inc/maestro

---

## 2. Driving WebView content in Capacitor/hybrid apps, and nested iframes

**Official position (Verified):** the docs' Web Views page states Maestro supports mobile apps
using WebViews on **both Android and iOS**, including embedded WebViews as well as standalone
browser apps, "no special configuration required." Under the hood the Web Driver uses Chrome
DevTools Protocol for browser communication and JS injection for DOM manipulation, for both
standalone browsers and embedded WebViews. (Summarized via search snippets of
`docs.maestro.dev/platform-support/web-views`; the doc page itself 404'd when fetched directly at
one candidate URL this session, so this claim is graded Inferred, not Verified, pending a direct
fetch.) Direct fetch of `docs.maestro.dev/get-started/supported-platform/web-browser` (Verified,
fetched this session) covers only **desktop-browser** automation via a managed Chromium — it does
not mention Capacitor/Cordova/Ionic or iframes at all, and its "Known limitations" section is
silent on iframe support.

**iframe support is real but was built for Maestro's Web (Chromium) driver, not confirmed for
native embedded WebViews (Verified via GitHub issue/PR history, fetched this session):**
- `#3009` "Web: cannot access elements inside an iFrame on a web page" — closed Mar 18, 2026,
  same day PR `#3067` "Read hierarchy from iFrames" merged.
- `#3079` "Add cross-domain iframe support" — merged Apr 2, 2026.
- `#3098` "fix: handle inputText, eraseText, and pressKey inside cross-origin iframes" — merged
  Apr 1, 2026.
- `#3289` "fix: skip broken cross-origin iframe hierarchy reads" (draft) and `#3314` "fix(web):
  handle stale iframe in fetchCrossOriginIframeContent" (merged May 27, 2026) show the
  cross-origin-iframe path was still being hardened through May 2026.
- `#3271` "Looped flow fails when 'coming back' to the main window" — open, labeled
  `platform: web`, opened May 8, 2026.
- All of the above are labeled/scoped to Maestro's **web** platform (the standalone-browser /
  Chromium driver), not the mobile embedded-WebView driver. There is no issue in this set that
  confirms iframe traversal inside a native app's embedded WebView on iOS or Android.
  https://github.com/mobile-dev-inc/maestro/issues (search: "iframe")

**Embedded-WebView-specific issues (Verified, fetched this session):**
- `#2293` "Maestro does not recognize ids inside a WebView" — **open** since Feb 7, 2025. Reporter:
  a Flutter app embedding a WebView (loading a React web app); Maestro Studio cannot locate an
  element by HTML `id` **on iOS** (iPhone 12/15 simulators), while the **identical** component
  **is** found on Android (Pixel API 33 emulator). No maintainer reply is present in the issue.
  This is a same-origin, non-iframe WebView case and it's still broken/open on iOS.
- `#1126` "[v1.28.0] Not able to inspect elements in WebView (android, emulator, API 33)" — closed,
  labeled "waiting for customer response" (i.e., closed for staleness, not a confirmed fix).
- A third-party account ("Another day another fight with Maestro", theweeklyedition.xyz, fetched
  this session) describes an 8+ hour debugging session that root-caused persistent flakiness to
  "Maestro unreliably traversing iframes in WebViews," citing
  `github.com/mobile-dev-inc/maestro/issues/1126#issuecomment-2616951274`. The author's workaround
  was **not** to fix it — they made the iframe-traversal failure mode reliably *identifiable* so it
  could be filtered out of flake statistics, i.e., they gave up on deterministic iframe assertions
  and treated that failure class as expected noise.
  https://theweeklyedition.xyz/posts/another-day-another-fight-with-maestro/

**Net assessment (Inferred from the above):** Maestro's DOM-level selectors (`tapOn: id:`, text
selectors, etc.) are documented to reach into embedded WebViews on both platforms, but real-world
reports show this is unreliable specifically on iOS and specifically for nested content (plain
WebView `id` lookup on iOS: open bug; iframe traversal inside a WebView: reported flaky by an
independent user, no fix confirmed). No source found — official docs, issues, or blog posts —
that confirms Maestro can deterministically assert on content inside a **sandboxed/cross-origin
iframe nested inside a native embedded WebView** (as opposed to Maestro's own browser/web-platform
driver, where iframe support was explicitly built in 2026). This is the closest analog to the
target proof (sandboxed iframe preview inside the app's WebView) and is the weakest-evidenced
capability found.

**What hybrid-app teams actually do (Verified, from comparison articles fetched/searched this
session):** third-party comparisons (Testsigma, Pie, Revyl, QA Wolf — vendor and independent blog
content, not primary sources, so graded Inferred as facts about the ecosystem rather than about
Maestro itself) consistently describe Maestro's WebView testing as "limited" for hybrid apps and
recommend **Appium** for hybrid/WebView-heavy flows, with some teams pairing both — Maestro for
native flows, Appium for the WebView/hybrid portions. One comparison explicitly states some teams
"even pair Maestro (simple native flows) with Appium (complex hybrid/WebView scenarios)."
Sources: https://testsigma.com/blog/maestro-vs-appium/ ,
https://revyl.com/blog/maestro-vs-appium/ , https://pie.inc/blog/maestro-vs-appium/ (vendor
content, not independently fetched line-by-line — Assumed/Inferred, weigh accordingly).

**Screenshot-only fallback:** no explicit statement was found that Maestro users fall back to
pure visual/screenshot assertions for iframe content, but Maestro does support screenshot-based
assertions (`assertVisible` operates on the accessibility hierarchy, and Maestro separately
supports `takeScreenshot` / visual regression via other flow commands per general docs) — this
is a documented general capability of the tool, not something specific to iframe workarounds
found in sources this session. Graded Assumed as an iframe-specific workaround; not directly
evidenced.

---

## 3. Infrastructure a Maestro run needs

**Local (Verified/Inferred from official CLI docs and general knowledge of the tool's model):**
Maestro drives whatever simulator/emulator or physical device is already booted and visible to
`adb`/`simctl` — it does not manage device provisioning itself beyond selecting/booting one via
`maestro test --device`. So locally you still need Xcode + an iOS Simulator, and/or Android Studio
SDK + an Android emulator (or a connected physical device), exactly as for any other on-device
Capacitor test.

**GitHub Actions CI (Verified):**
- A dedicated third-party action, `dniHze/maestro-test-action`, installs/caches the Maestro CLI
  and runs flows against an iOS/iPadOS Simulator or Android Emulator; **only macOS and Linux
  hosted runners are supported** (no native Windows Maestro-CLI action support flagged).
  https://github.com/dniHze/maestro-test-action
- **iOS** requires a **macOS** GitHub-hosted runner (Apple's Simulator only runs on macOS) —
  there is no way around this on GitHub Actions; self-hosted Mac hardware is the only escape from
  GitHub's macOS-minute cost.
- **Android** can run on GitHub-hosted **Ubuntu** runners with hardware acceleration: GitHub
  enabled KVM ("hardware-accelerated Android virtualization") on **standard** GitHub-hosted Linux
  runners in April 2024 (previously limited to "larger" runners since Feb 2023). The
  `reactivecircus/android-emulator-runner` action's README shows the required setup: add the
  runner user to the `kvm` group via a udev rule before invoking the emulator step, on
  `ubuntu-latest`. https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/
  https://github.com/ReactiveCircus/android-emulator-runner
- **Cost (Verified, GitHub's own 2026 repricing; exact per-minute figures vary slightly by
  source):** as of Jan 1, 2026, GitHub cut hosted-runner prices — Linux x86 ≈ $0.006/min, Windows
  ≈ $0.010/min, macOS ≈ $0.048–0.062/min depending on source (two slightly different published
  figures found; not reconciled — flagged as a gap). **Minute multipliers against the included
  free-minute quota are unchanged: macOS jobs consume free minutes at 10×, Windows at 2×, Linux at
  1×** — so a 10-minute macOS job burns 100 minutes of quota. Public repos get unlimited free CI
  minutes on all plans; private repos get 2,000–50,000 minutes/month depending on plan, which
  nets to far fewer effective macOS minutes once the 10× multiplier applies.
  https://docs.github.com/en/billing/reference/actions-runner-pricing (referenced by search
  summary; not independently fetched — Inferred) and multiple secondary cost-analysis posts found
  in search (cicdpipelinecost.com, stacktrack.com) corroborating the multiplier mechanic.
- Official Maestro docs describe a **Maestro Cloud**-based GitHub Actions pattern instead of local
  simulators: build the `.app` (iOS, via `xcodebuild ... -destination 'generic/platform=iOS
  Simulator'`) or debug `.apk` (Android, via Gradle), then upload to Maestro Cloud with
  `mobile-dev-inc/action-maestro-cloud@v1` (API key + project ID) rather than booting a local
  emulator in the runner. https://docs.maestro.dev/cloud/ci-integration/github-actions/maestro-github-action-for-ios

**Maestro Cloud necessity/pricing (Verified for the mechanism, Inferred for exact numbers):**
Maestro CLI itself is free and fully usable against your own local/CI-managed
simulators/emulators — **Maestro Cloud is not required** to run flows in CI, only to get managed
device farms + parallelism without maintaining emulators yourself. Official pricing
(`maestro.dev/pricing`, not independently fetched — Inferred from search summary) is
concurrency-based ("price per month based on max concurrent executions"); a third-party
aggregator (SaaSworthy) cites a starting figure of **$125/month** for a Cloud plan alongside a
free tier and enterprise tier — this figure is Assumed/unverified since it wasn't confirmed
against the primary pricing page. G2 reviews (not independently fetched) reportedly note Cloud
pricing is a pain point for small/non-profit teams.

---

## 4. Maestro vs. alternatives for this one proof — facts only

| Tool | WebView/iframe fact found | Source status |
|---|---|---|
| **Maestro** | Embedded-WebView selector support is documented as automatic on both platforms, but a same-origin WebView `id`-lookup bug is open on iOS (#2293) and an independent user reports iframe traversal inside WebViews as unreliable, with no confirmed fix, on a since-superseded version. Cross-origin/iframe engineering effort visible in the repo (2026 PRs) targets Maestro's **own web/Chromium driver**, not confirmed for native embedded WebViews. | Verified (repo issues/PRs, one blog account) |
| **Appium** | Established, documented context-switch model: `GET session/:sessionId/contexts` → `POST session/:sessionId/context` to move from `NATIVE_APP` into a `WEBVIEW_n` context, after which standard Selenium-style DOM finders operate inside the WebView. On Android requires `setWebContentsDebuggingEnabled(true)`; on iOS, Appium automates `WKWebView`/`UIWebView` but explicitly **cannot** handle `SafariViewController`. A live forum thread reports a hybrid app's in-page iframe worked via WebView context + XPath on **Android** but the same approach **failed on iOS**, and native XCUITest accessibility IDs didn't reach it either — i.e., iframe-in-WebView is a known pain point on iOS for Appium too, not a solved problem, just a differently-documented one. Independent comparison articles (vendor content, not primary) consistently call Appium the more mature choice for hybrid/WebView-heavy flows in 2026. | Verified for the context-switch mechanism (Appium's own docs); Verified for the iOS iframe pain point (forum thread fetched via search); comparison verdicts are Inferred/vendor-content |
| **Native XCUITest / Espresso screenshot test** | Not independently researched beyond general knowledge — this drives the native shell reliably but has the same WebView-content-visibility limits as any native automation framework unless it falls back to pixel/visual assertion rather than DOM assertion inside the iframe. | Assumed (not searched this session) |
| **Playwright + real-device cloud (BrowserStack/Sauce Labs)** | BrowserStack and Sauce Labs' hybrid-app/WebView tooling is built on **Appium**, not Playwright — Playwright itself does not drive native mobile app shells. A Capacitor-specific GitHub discussion reports that on BrowserStack, `@capacitor/core@5.7.6` + WebdriverIO 8.39 sessions only ever exposed a `NATIVE_APP` context (no `WEBVIEW_n`), so `switchToWeb` failed — meaning WebView-context detection for Capacitor apps has been an active problem on at least one real-device cloud. | Verified (GitHub discussion found and summarized via search); not independently fetched line-by-line |

No source found this session states a definitive "yes" or "no" for asserting on a
sandboxed/cross-origin iframe nested inside a Capacitor WebView with any of these four tools —
every option has at least one documented or independently-reported gap specifically around
iframe/WebView content, concentrated on iOS.

---

## 5. Typical Maestro flow-file shape (Verified — official docs pattern, via search-summarized
`docs.maestro.dev/maestro-flows` content; not independently fetched line-by-line)

A flow file is YAML: a `---`-delimited config header (`appId:` is mandatory; optional `name`,
`tags`, `env`) followed by a command list.

```yaml
appId: ai.hushbox.app
---
- launchApp
- tapOn: "Sign In"
- tapOn:
    id: "email_field"
- inputText: "qa@example.com"
- tapOn:
    id: "password_field"
- inputText: "Sup3rSecret!"
- tapOn: "Log In"
- assertVisible: "Welcome back"
```

- `launchApp` targets the app by the `appId` declared in the header (would be
  `ai.hushbox.app` per this repo's `capacitor.config.ts`, Verified this session).
- Selectors prioritize user-visible text; `id:` selectors are the documented alternative for
  non-text elements, subject to the WebView-`id`-visibility caveats in §2.
- Login/setup is commonly factored into a reusable subflow invoked via `- runFlow: Login.yaml`
  (optionally parameterized with an `env:` block and `${VAR}` interpolation), so multiple test
  flows share one login implementation.
- `assertVisible` waits/retries automatically against the current view hierarchy (no explicit
  waits needed) — this is the general Maestro model; whether it can reach into a nested iframe
  inside a WebView is exactly the unresolved question from §2, so a flow asserting on that
  specific target should be prototyped and verified locally before being relied on for CI signal.

Sources: https://docs.maestro.dev/maestro-flows ,
https://docs.maestro.dev/reference/commands-available/runflow

---

## Gaps / unresolved

- Could not independently fetch `docs.maestro.dev/platform-support/web-views` (404 on the
  candidate raw-docs URL tried) — the "no special configuration required" WebView claim rests on
  a search-engine summary of that page, not a direct fetch. Should be re-verified before
  depending on it.
- CLI 2.7.0's specific changelog content (July 20, 2026) was not fetched — only that it is the
  current latest tag.
- Exact current macOS/Linux/Windows GitHub Actions per-minute pricing has two slightly divergent
  published figures ($0.048 vs $0.062/min for macOS); not reconciled against GitHub's own docs
  page directly.
- Maestro Cloud's official per-seat/per-concurrency pricing was not fetched from
  `maestro.dev/pricing` directly; only a third-party aggregator's "$125/month starting" figure was
  found, unverified.
- No source located that tests the *specific* scenario asked about — a **sandboxed** (as opposed
  to same-origin or generically cross-origin) iframe, which may behave differently again under
  browser `sandbox` attribute restrictions — with any of the four tools compared. This is a real
  evidentiary gap, not just an unresolved detail.
- The "what hybrid-app teams actually do" conclusions lean on vendor/comparison blog content
  (Testsigma, Pie, Revyl, QA Wolf) rather than primary practitioner sources beyond the one
  first-person blog post found (`theweeklyedition.xyz`) and the one Capacitor/BrowserStack GitHub
  discussion.

---

## Existing Maestro suite

### 1. Where flows live, naming, coverage

- Flows: `mobile-tests/flows/*.yaml`, 13 files, numeric-prefixed kebab-case (`NN-topic.yaml`):
  `01-app-launch.yaml`, `02-splash-screen.yaml`, `03-webview-renders.yaml`,
  `04-back-button.yaml`, `05-deep-links.yaml`, `06-network-status.yaml`,
  `07-push-notification-prompt.yaml`, `08-app-lifecycle.yaml`, `09-status-bar.yaml`,
  `10-core-user-flow.yaml`, `11-keyboard-behavior.yaml`, `12-scroll-behavior.yaml`,
  `13-ota-update.yaml`.
- Coverage: cold launch/crash check, splash-screen dismissal, WebView React-app render,
  Android hardware back button, deep-link route allowlisting, network/offline overlay
  detection, push-notification prompt, app background/foreground lifecycle, status-bar
  styling (screenshot-only), a full login→send-message chat flow, on-screen keyboard
  behavior, message-list scroll, and OTA update download/apply (Capgo).
- Each flow declares `tags` (`smoke`, `must`, `should`) — `scripts/mobile-test.ts:688-694`
  (`smokeFlows()`) hardcodes the 3 smoke flows (`01`, `02`, `03`); the tags in YAML are
  otherwise descriptive, not consumed by a runner filter.
- No per-flow README; `mobile-tests/config.ts:1-9` is the only prose doc, and it only covers
  shard count (`SHARDS = 2`).

### 2. How they're run

- **Local/CI entrypoint**: `pnpm mobile:test` → `package.json:95` →
  `pnpm ensure-stack && tsx scripts/with-env.ts tsx scripts/mobile-test.ts`;
  `pnpm mobile:test:smoke` (`package.json:96`) passes `--smoke`. `pnpm mobile:bake`
  (`package.json:97`) bakes/pushes the emulator Docker image; `pnpm mobile:studio`
  (`package.json:98`) is a thin wrapper for `maestro studio` (interactive flow authoring),
  not part of the automated run.
- **Config files**:
  - `mobile-tests/.maestro/config.yaml:1-3` — Maestro workspace config:
    `appId: ai.hushbox.app`, `flows: ['../flows/*']`.
  - `mobile-tests/config.ts:9` — `export const SHARDS = 2` (parallel emulator containers;
    CI runner tops out ~2).
  - `mobile-tests/docker/Dockerfile:19` — `FROM budtmo/docker-android:emulator_14.0`,
    deliberately empty otherwise; the Dockerfile's content hash is the image tag
    (`scripts/lib/mobile-image.ts`, referenced at `scripts/mobile-test.ts:15,938`), so any
    change invalidates the cached image everywhere.
- **Orchestrator script**: `scripts/mobile-test.ts` (995 lines) drives everything:
  - `assertLinux()` (`:99-105`) — Linux-only (KVM + Docker host networking required).
  - `checkPrerequisites()` (`:107-117`) — Docker daemon + `/dev/kvm` present.
  - `installMaestro()` (`:119-131`) — installs Maestro CLI via `curl | bash` if not on PATH.
  - `installAndroidSdk()` (`:141-186`) — installs Android cmdline-tools + `platform-tools`
    + `platforms;android-36` if missing.
  - `startEmulators()`/`startEmulator()` (`:286-332`) — launches N `budtmo/docker-android`
    containers via `runEmulatorContainer()` (`scripts/lib/mobile-image.ts`), polls
    `adb`/`sys.boot_completed` up to `BOOT_TIMEOUT_POLLS=300` × `2s` (`:27-28`), then
    `adb reverse` for the API port (`:280-284`).
  - `buildApk()` (`:473-528`) — builds the web app for `VITE_PLATFORM=android-direct`,
    `npx cap sync android`, then `./gradlew clean assembleDebug` in `apps/web/android`.
  - `installApks()` / `configureAllAppLinks()` (`:530-588`) — installs the debug APK per
    shard, allows app-link verification, disables Chrome so deep links route to the app.
  - `runMaestroShards()` (`:765-813`) — partitions flows across shards by an estimated
    per-flow weight (`flowWeight()` / `partitionByWeight()`, `:590-686`, weighting
    `inputText` chars heavily because Capacitor WebView `inputText` is ~10s/char on
    docker-android — Maestro issue #2718), runs
    `maestro test --device <host> --debug-output <dir> --flatten-debug-output <flows...>`
    per shard, retries failed flows serially on shard 0.
  - `runMaestroOta()` / `setupOtaUpdate()` (`:846-923`) — OTA flow (`13-ota-update.yaml`)
    runs separately, single-shard only (mutates global server state via
    `/dev/set-version`), after building/uploading a second OTA-versioned web bundle to
    local R2.
  - `main()` (`:925-995`) — ties it all together; results/logs land in `maestro-results/`
    (`RESULTS_DIR`, `:35`), including a sliced wrangler API log per run
    (`withMobileTestRun`/`writeApiSlice`, `:416-451`) and `dumpApiLogTail()` (`:458-471`)
    on failure.
- **Device/emulator setup**: Android emulator only, via Docker (`budtmo/docker-android`),
  not a local AVD/simulator and not iOS — no Maestro flow targets `apps/web/ios` (grep for
  `ios`/`iOS` in `scripts/mobile-test.ts` returns nothing).
- **CI wiring**: `.github/workflows/ci.yml`
  - `mobile-test` job (`:580-687`): `runs-on: blacksmith-8vcpu-ubuntu-2404`,
    `timeout-minutes: 20`, needs `[gitleaks]`; caches Turbo, Android SDK, Gradle, and
    `~/.maestro`; logs into GHCR (to pull the prebaked emulator image pushed by
    `push-mobile-emulator-image` on `main`); starts DB, runs migrations, seeds
    (`pnpm db:seed` — CI comment: "the unified seed mints `MOBILE_TEST_PERSONA`"); runs
    `pnpm mobile:test`; on failure dumps emulator container logs/inspect and cancels the
    workflow run; always uploads `maestro-results/` + emulator logs as the
    `maestro-results` artifact.
  - `push-mobile-emulator-image` job (`:695-715`, `needs: [..., mobile-test, ...]`):
    bakes/pushes `mobile-tests/docker/` to GHCR via
    `pnpm tsx scripts/bake-mobile-image.ts --push`, content-hash tagged.
  - No docs/CLAUDE.md file mentions Maestro or `mobile-tests/` (checked every `CLAUDE.md`
    in the repo and `docs/DEVELOPMENT.md`'s doc index) — the orchestrator script's own
    comments are the only guidance that exists.

### 3. Flow conventions

- **Launch**: every flow starts `- launchApp: { clearState: true }` (fresh install state)
  and waits for stabilization, either `waitForAnimationToEnd`
  (`mobile-tests/flows/01-app-launch.yaml:13-14`) or
  `extendedWaitUntil: { visible: 'Sign up', timeout: 45000 }` (most others, e.g.
  `mobile-tests/flows/03-webview-renders.yaml:12-14`). Resume-from-background flows
  instead use `launchApp: { stopApp: false }`
  (`mobile-tests/flows/04-back-button.yaml`, `08-app-lifecycle.yaml`, `13-ota-update.yaml`).
- **Auth/seed**: no OPAQUE registration flow in Maestro — login uses a pre-seeded persona.
  `mobile-tests/flows/10-core-user-flow.yaml:6-17` declares flow-level
  `env: { TEST_USERNAME: tmu, TEST_PASSWORD: pass1234 }`, documented as
  `MOBILE_TEST_PERSONA` seeded by `scripts/seed.ts` and referenced by CI's `pnpm db:seed`
  step comment (`.github/workflows/ci.yml:653-655`). Username (not email) is used
  deliberately — `inputText` costs ~10s/char on docker-android WebViews (Maestro #2718),
  capping practical `inputText` length; `tmu` keeps the login step fast. OPAQUE
  login-by-username hits the same server path as by-email (`resolveIdentifierCondition`
  in `opaque-auth.ts`, per the flow's own comment).
- **Element selection**: two selector styles, both resolved against the WebView DOM (not
  native Android views):
  - Visible text, e.g. `tapOn: 'Sign up'`, `assertVisible: 'Regenerate'`.
  - `id:` selector matching a literal HTML `id` attribute on the DOM element, e.g.
    `tapOn: { id: 'model-selector-button' }`
    (`mobile-tests/flows/10-core-user-flow.yaml:53,61-62`), `id: 'send-button'`,
    `id: 'prompt-input'` (`mobile-tests/flows/11-keyboard-behavior.yaml:17`). These ids are
    real `id="..."` props on React components (e.g.
    `apps/web/src/components/chat/model-selector/model-selector-button.tsx:87` has both
    `id="model-selector-button"` for Maestro and a separate
    `data-testid={TEST_IDS.modelSelectorButton}` for Vitest/RTL — two independent selector
    mechanisms maintained side by side, not shared).
- **Assertions**: `assertVisible`/`assertNotVisible` on text or `id`;
  `mobile-tests/flows/10-core-user-flow.yaml:64-74` explicitly asserts on the post-stream
  "Regenerate" button rather than message body text, because "Maestro's Android text
  matcher fails to surface WebView TextView nodes nested in large parent containers, even
  when the text is present in the hierarchy dump."
- **Representative flow** (`mobile-tests/flows/10-core-user-flow.yaml`, full text):
  ```yaml
  appId: ai.hushbox.app
  name: Core user flow — login and send message
  tags:
    - should
  androidWebViewHierarchy: devtools
  env:
    TEST_USERNAME: tmu
    TEST_PASSWORD: pass1234
  ---
  - launchApp:
      clearState: true
  - extendedWaitUntil:
      visible: 'Sign up'
      timeout: 45000
  - tapOn: 'Sign up'
  - extendedWaitUntil:
      visible: 'Create your account'
      timeout: 10000
  - tapOn: 'Log in'
  - extendedWaitUntil:
      visible: 'Welcome back'
      timeout: 10000
  - tapOn: 'Email or Username'
  - inputText: ${TEST_USERNAME}
  - hideKeyboard
  - tapOn: 'Password'
  - inputText: ${TEST_PASSWORD}
  - hideKeyboard
  - tapOn: 'Log in'
  - extendedWaitUntil:
      visible:
        id: 'model-selector-button'
      timeout: 15000
  - tapOn: 'Explain a concept'
  - tapOn:
      id: 'send-button'
  - extendedWaitUntil:
      visible: 'Regenerate'
      timeout: 30000
  ```

### 4. WebView DOM interaction

- All flows except `01-app-launch.yaml` set the flow-level flag
  `androidWebViewHierarchy: devtools` (e.g. `mobile-tests/flows/03-webview-renders.yaml:6`,
  `10-core-user-flow.yaml:5`). This tells Maestro to enumerate the Capacitor WebView's DOM
  via the Chrome DevTools Protocol rather than relying solely on the native Android
  accessibility/UI-automation hierarchy, which is what makes text- and `id`-based selectors
  resolve against React-rendered DOM nodes at all in this repo's flows.
- No flow uses `evalScript:` — confirmed via repo-wide grep
  (`grep -rl evalScript mobile-tests/flows/` → no matches). All interaction is declarative
  Maestro commands (`tapOn`, `inputText`, `assertVisible`, `extendedWaitUntil`) against the
  devtools-derived hierarchy; there is no flow that runs arbitrary JS in the WebView or
  reads back a JS return value.
- Screenshots are used for cases Maestro can't assert programmatically:
  `mobile-tests/flows/09-status-bar.yaml` takes
  `takeScreenshot: maestro-results/status-bar-dark-theme` because "Maestro cannot
  programmatically inspect status bar color."
- One documented WebView-interaction workaround:
  `mobile-tests/flows/10-core-user-flow.yaml:56-58` taps a suggestion chip instead of
  typing into the prompt textarea directly, because "Direct `inputText` via IME doesn't
  reliably trigger React `onChange` in WebViews" — i.e. native key injection into the
  WebView doesn't always reach React's controlled-input state.
- This suite never asserts on iframe-nested content (no `sandpack`/iframe feature exists
  yet in `apps/web/src` per the Context section above) — it is same-origin WebView DOM
  only, consistent with the open questions raised in §2 of this doc about nested/sandboxed
  iframes specifically.

### 5. Capacitor platform dirs & build for Maestro runs

- `apps/web/android/` — Android platform project (Gradle), including
  `apps/web/android/app/`, `gradlew`, `fastlane/`. This is the only platform Maestro
  actually exercises in this repo.
- `apps/web/ios/` — iOS platform project (`apps/web/ios/App`, `fastlane/`, `Gemfile`)
  exists but is not referenced anywhere in `scripts/mobile-test.ts` — no
  Maestro/iOS-simulator run is wired up locally or in CI.
- `apps/web/capacitor.config.ts` — Capacitor config (single file at the app root, both
  platforms sync from it).
- **Build path for a Maestro run** (`scripts/mobile-test.ts:473-528`, `buildApk()`):
  1. `pnpm --filter web build` with `VITE_PLATFORM=android-direct`, `VITE_API_URL`,
     `VITE_APP_VERSION=local-mobile-test` (`APK_APP_VERSION`, `:412`),
     `VITE_OPAQUE_SERVER_ID` derived from `FRONTEND_URL`'s host.
  2. `npx cap sync android` (cwd `apps/web`) — copies the built web bundle + Capacitor
     plugin config into the Android project.
  3. `./gradlew clean assembleDebug` (cwd `apps/web/android`) with `VERSION_CODE=1`,
     `VERSION_NAME=local-mobile-test`, and a fixed debug keystore
     (`ANDROID_KEYSTORE_*=debug`). `clean` is required because AGP's incremental
     `mergeDebugAssets` retains stale content-hashed web assets from the previous run,
     which then collide in `compressDebugAssets`.
  4. Output APK: `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`
     (`APK_PATH`, `:20`), installed per shard via `adb install -r`
     (`installApk()`, `:530-534`).
  - `google-services.json` (`apps/web/android/app/google-services.json`) is written from
    `GOOGLE_SERVICES_JSON_BASE64` if not already present (`:479-488`).
  - The OTA flow (`13-ota-update.yaml`) additionally builds a second, separately-versioned
    web-only bundle (`VITE_APP_VERSION=ota-v2`) with plain `vite build --outDir dist-ota`
    (no Gradle/APK rebuild), zips it, and uploads to local R2 so the already-installed APK
    can fetch it as a live update (`setupOtaUpdate()`, `:852-902`).
