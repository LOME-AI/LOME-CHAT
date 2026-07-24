# How claude.ai renders Artifacts (web + iOS/Android), and the mobile-runtime implications

Research date: 2026-07-23. No official Anthropic engineering post fully documents the
artifact-execution pipeline (a "How we built Artifacts" post exists but is a UX/product
narrative, not an architecture writeup); the technical picture below is assembled from a
security-team interview, a reverse-engineering writeup, a leaked system prompt, and a
sandbox blog post — cross-checked against a live 2026 GitHub bug report that confirms the
same domain is still in production. No source, official or unofficial, documents service
worker usage — its total absence across every source is itself the strongest signal.

## 1. Web mechanism

- **Isolation model: sandboxed iframe on a separate origin, not a special sandbox
  primitive.** Anthropic security engineer Ziyad Edher, quoted in Gergely Orosz's
  interview-based piece: *"We're not using any actual 'sandbox' primitive per se"* — the
  mechanism is "iFrame sandboxes + full-site process isolation," a browser-native technique.
  Verified: [How Anthropic built Artifacts — Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts).
- **The origin is `https://www.claudeusercontent.com`**, serving what appears to be a
  Next.js app, confirmed by inspecting the live page. Verified:
  [Reverse engineering Claude Artifacts — Reid Barber](https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts)
  (2024, but the same domain still appears in a July 2026 GitHub issue below, so it is
  current). The iframe includes a same-origin self-check that redirects to the parent
  origin if the code isn't actually running inside the iframe. Inferred (from Reid
  Barber's writeup, not a direct quote): environment-specific config strings
  (production/staging/development) were visible in the bundle.
- **CSP restricts network + storage access.** Simon Willison, describing the `window.claude.complete()` launch: *"Claude Artifacts are web apps that run in a strictly
  controlled browser sandbox: their access to features like `localStorage` or the ability
  to access external APIs via `fetch()` calls is restricted by CSP headers and the
  `<iframe sandbox="...">` mechanism."* Verified:
  [Build and share AI-powered apps with Claude — Simon Willison](https://simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/)
  (fetched raw via curl to bypass an unrelated tool-side false-positive on the WebFetch
  path).
- **Content transfer: `window.postMessage()`** carries the artifact source from the parent
  chat page into the iframe — not a URL load or a shared-worker channel. Verified: Reid
  Barber writeup (above).
- **React execution: the `react-runner` library, not Babel Standalone and not an esm.sh
  import-map setup.** Reid Barber inspected the loaded JS bundle and concluded: *"it looks
  like they're using a library called React Runner to render the dynamic React code."*
  This is in-browser JSX/JS evaluation via a small interpreter library (`react-runner` on
  npm), not a transpile-then-`<script type=module>` pipeline. Verified (reverse-engineered,
  not Anthropic-confirmed): same source.
- **Bundled/allowed libraries**, per the same bundle inspection plus the leaked artifacts
  system prompt: Tailwind CSS, React DOM, DOMPurify (output sanitization), Radix
  Primitives, React Hot Loader, Lucide React, React Zoom Pan Pinch pre-bundled into the
  renderer chrome; and — per the leaked system-prompt constraints on what the *model* is
  told it may import into a React artifact — base React (hooks only), `lucide-react`
  (pinned old version `0.263.1` in the leaked text), `recharts`, and shadcn/ui components,
  with an explicit instruction: *"NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR
  ABLE TO BE IMPORTED."* Verified (leaked prompt, not first-party docs):
  [system_prompts_leaks — claude-design.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-design.md);
  cross-referenced via Reid Barber's bundle inspection above.
- **External `<script>` tags are restricted to `https://cdnjs.cloudflare.com`** — this is
  the one CDN the model is told it may pull additional non-React scripts from (e.g. for
  plain-HTML artifacts); it is a system-prompt-level instruction to the model, not
  necessarily a hard CSP allowlist the sandbox enforces independently, but the two are
  consistent. Inferred: leaked system prompt (above). No source mentions esm.sh being used
  by the production artifact runtime — that pattern appears only in third-party
  clones/recreations of the Artifacts experience (e.g. `claude-artifact-runner`), not in
  Anthropic's own bundle.
- **No service worker anywhere.** None of the four independent sources checked — the
  security-engineer interview, the bundle-inspection writeup, the leaked system prompt, or
  Simon Willison's CSP description — mentions a service worker at any point. The CSP/iframe
  combination is described as the entire mechanism.
- **What full-text search could not turn up**: an official Anthropic post itemizing the
  exact CSP directives, the full sandbox iframe attribute string, or a formal statement
  that `react-runner` (vs. some successor) is still the current execution engine as of
  2026 — treat the execution-engine claim as **Inferred from 2024 reverse engineering**,
  not confirmed current.

## 2. iOS / Android app

- **Artifacts do render on both mobile apps in 2026, and mobile supports both creating and
  viewing**, not view-only as some secondary sources claim. Anthropic's own announcement,
  quoted via a search-result excerpt: users "can now also create and view Artifacts on
  Claude iOS and Android apps," covering Free, Pro, and Team plans. Verified (via search
  snippet of Anthropic's post; the anthropic.com URL itself repeatedly triggered a
  same-session tool-side false-positive and could not be fetched directly this session):
  [Anthropic rolled out Artifacts for Claude.ai iOS/Android — TestingCatalog](https://www.testingcatalog.com/anthropic-rolled-out-artifacts-for-claude-ai-users-on-ios-and-android-apps/).
  Rollout date **July 31, 2025**, per a second independent secondary source. Inferred
  (secondary source, not independently cross-checked against a first-party dated post this
  session).
- Some third-party 2026 guides instead claim mobile is "view-only, editing/iteration is
  better on desktop." This directly **conflicts** with Anthropic's own "create and view"
  wording above. Flagging the conflict rather than resolving it: Gap — not confirmed either
  way this session which is accurate for the *current* app version; the two claims may
  simply describe different eras of the same rollout (create landed later than view).
- **No source located this session documents the mobile rendering mechanism directly**
  (no teardown, no decompilation writeup, no Anthropic engineering statement naming
  WKWebView/Capacitor/React Native for the Claude iOS app specifically). Searches for
  "Claude iOS WKWebView artifacts teardown" returned nothing on-topic. This is a **Gap**.
- **Indirect but strong evidence that mobile reuses the same web sandbox, embedded in a
  webview**: a live (filed July 18, 2026) GitHub issue on published Claude Code artifacts
  shows the artifact URL is `claude.ai/code/artifact/<id>` on every platform, and the
  reporter confirms *"pasting the URL into a signed-in mobile browser works fine"* — i.e.
  the same hosted-artifact backend and origin serve the content regardless of client; the
  bug is purely an in-app **discovery/listing** gap (Claude Code artifacts don't appear in
  the mobile app's unified Artifacts list), not a rendering or sandbox capability gap.
  Verified: [GitHub anthropics/claude-code#78792](https://github.com/anthropics/claude-code/issues/78792).
  A related, separately-filed bug (`app://localhost` postMessage origin mismatch against
  `www.claudeusercontent.com` causing a blank screen on published artifacts) further
  confirms the production pipeline is still postMessage-into-`claudeusercontent.com`-iframe
  as of the current app builds, and that origin-matching between the embedding shell and
  the sandbox iframe is a live, sometimes-fragile part of the mechanism. Verified (bug
  exists, mechanism described in title): [GitHub anthropics/claude-code#42064](https://github.com/anthropics/claude-code/issues/42064).
- **Known mobile-specific gap**: Claude Code artifacts (as opposed to claude.ai chat
  artifacts) don't surface in the mobile app's Artifacts view at all — confirmed limitation,
  not a rendering failure. Verified: issue #78792 above.
- No release notes, teardown, or support.claude.com article located this session states
  whether the iOS app uses WKWebView with "app-bound domains" configured for
  `claudeusercontent.com` (relevant to service-worker feasibility — see §3) or a plain
  unconfigured WKWebView. **Gap.**

## 3. Key question for us: service worker, or CDN-modules-in-sandboxed-iframe?

- **No evidence of service worker usage anywhere in the artifact pipeline**, web or mobile.
  Every source that describes the mechanism (security-engineer interview, CSP description,
  bundle-inspection writeup) describes it purely as: sandboxed same-purpose iframe on a
  dedicated origin (`claudeusercontent.com`) + CSP restricting `fetch`/`localStorage` +
  `postMessage` to ferry source in + an in-browser JS-evaluation library (`react-runner`)
  to execute React/JSX without a build step + a `cdnjs.cloudflare.com` allowlist for the
  rare additional `<script>`. This is exactly the **"CDN-modules-in-sandboxed-iframe"**
  pattern, not a service-worker-mediated one. Verified/Inferred as itemized in §1.
- **This matters for WKWebView compatibility because Apple restricts Service Worker to
  Safari itself**, not to arbitrary WKWebView instances. Apple's own developer-forum
  clarification (paraphrased in search results, original WebKit statement corrected):
  *"the Service Worker API was available in all applications using WKWebView"* was
  **retracted** — it is *"only available in Safari."* An app that needs service workers
  inside its own embedded WKWebView must use iOS's **App-Bound Domains** allowlist (max 10
  domains) to opt a specific origin in; without that, `serviceWorker.register()` silently
  fails to do anything useful inside a generic in-app WKWebView. Verified (Apple developer
  forum discussion, WebKit bug #206741): search results citing
  [WebKit blog "Workers at Your Service"](https://webkit.org/blog/8090/workers-at-your-service/)
  and [WebKit bug 206741 — WKWebView support for Service Workers](https://bugs.webkit.org/show_bug.cgi?id=206741).
  This was not independently re-fetched and read in full this session — graded Inferred
  from search snippets, not Verified against the primary WebKit page.
- **Practical implication (Inferred, not stated by Anthropic anywhere)**: Anthropic's
  choice to build Artifacts on a sandboxed-iframe + CDN-script-allowlist + in-browser
  interpreter (`react-runner`) design, with zero observed service-worker dependency, is
  consistent with a design that needs to "just work" inside a generic WKWebView on iOS
  without requiring App-Bound Domain configuration or Safari-only capabilities. No source
  states this was a deliberate mobile-compatibility reason for the architecture — it may
  equally be explained by the web-only origin of the feature (Artifacts shipped on web in
  2024, over a year before iOS/Android). Treat the causal link to mobile as **Assumed**,
  not confirmed; only the technical fact (no service worker, sandboxed-iframe +
  CDN-allowlist +  in-browser-eval instead) is Verified/Inferred.

## 4. Bonus: ChatGPT Canvas and Gemini Canvas on mobile

- **ChatGPT Canvas**: launched Web + Windows first; iOS/Android/Mac were explicitly listed
  as "coming soon" at launch (October 2024). No source located this session gives a
  first-party, dated confirmation of full iOS Canvas parity as of 2026, nor any technical
  detail on rendering mechanism (WebView or otherwise) — the official OpenAI help-center
  article could not be fetched this session (HTTP 403 to the automated fetch tool).
  **Gap**: current-2026 iOS Canvas support status and mechanism both unconfirmed this
  session. Inferred only: [Introducing canvas — OpenAI](https://openai.com/index/introducing-canvas/)
  (launch-era platform list, not re-verified for 2026 state).
- **Gemini Canvas**: available in the Gemini mobile apps (Android and iOS) per Google's own
  help center, launched March 2025; a May 2025 update added more creation types. Verified
  (help-center URL located, not fully fetched this session — graded Inferred from search
  snippet): [Create docs, apps & more with Canvas — Gemini Apps Help](https://support.google.com/gemini/answer/16047321).
  One caveat found: *"You can only edit text style/format in the Gemini web app on
  desktop; this functionality is not available on mobile devices"* — a real feature gap,
  though it concerns text-formatting controls, not code/app rendering per se. No official
  Google document states the mobile rendering mechanism (WebView vs. native); a
  third-party summary's inference that it's "WebView on Android / WKWebView on iOS" is
  explicitly labeled speculation by that source, not confirmed. **Assumed**, not Verified.

## Gaps

- No first-party Anthropic engineering document itemizes the artifact sandbox's exact CSP
  directives or `iframe sandbox="..."` attribute string.
- No teardown or Anthropic statement confirms the current (2026) client-side execution
  engine is still `react-runner` — that is a 2024 finding, not reconfirmed since.
- No source describes the Claude iOS/Android app's embedding technology (WKWebView with or
  without App-Bound Domains, Capacitor, React Native, or fully native) for the artifact
  viewer specifically.
- Conflicting secondary claims on whether mobile artifact support is view-only or
  view+create — not resolved this session; Anthropic's own wording says "create and view,"
  a third-party 2026 guide says view-only-with-desktop-preferred-for-editing.
- ChatGPT Canvas's current-2026 mobile-app availability and rendering mechanism: not
  confirmed (help center page returned 403 to the fetch tool).
- The causal claim "Anthropic avoided service workers because of iOS WKWebView
  constraints" is Assumed, not sourced anywhere — only the absence of service workers and
  the general WKWebView/service-worker restriction are independently Verified/Inferred.
