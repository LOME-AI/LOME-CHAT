# In-browser code execution & live rendering — package landscape

Analyst research, 2026-07-23. Question: best currently-maintained package for maximally
powerful client-side code execution/rendering in the chat document panel (Artifacts/canvas
style). Prior in TECH-STACK.md: Sandpack (planned) — treated as a prior to verify.

Claim grades: **[V]** Verified (looked up this session, URL cited) · **[I]** Inferred ·
**[A]** Assumed.

---

## Option set

### A — Sandpack (`@codesandbox/sandpack-react`), classic client bundler, self-hosted

- **Current state** [V]: latest `2.20.0`, published 2025-02-14; last repo push
  2025-04-24; Apache-2.0; peer deps include React `^19`; 6.2k stars, 157 open issues.
  (npm registry JSON; `gh api repos/codesandbox/sandpack`)
- **Maintenance risk — the load-bearing caveat** [V]: CodeSandbox was acquired by
  Together AI (Dec 2024, [PR Newswire](https://www.prnewswire.com/news-releases/together-ai-acquires-codesandbox-to-launch-first-of-its-kind-code-interpreter-for-generative-ai-302330074.html));
  the microVM/SDK business is the focus. No npm publish since Feb 2025 (~17 months);
  community issue ["Is sandpack as project dead/legacy?" #1243](https://github.com/codesandbox/sandpack/issues/1243)
  is open. Sandpack is in **maintenance limbo**, not abandoned: repo not archived,
  Apache-2.0, and LibreChat maintains a
  [fork of the bundler](https://github.com/LibreChat-AI/codesandbox-client) (telemetry
  removed) proving the self-host/fork path works in production. [V]
- **Capabilities** [V, docs/FAQ]: multi-file projects; npm deps resolved at runtime from
  CDN; templates react/vanilla/vue/static/etc.; console, error overlay, tests component;
  CodeMirror editor built in. HTML/CSS/JS + React + Vue covered. Not Python.
- **Licensing** [V, [FAQ](https://sandpack.codesandbox.io/docs/resources/faq)]: Sandpack
  itself Apache-2.0; commercial use free for most templates **except** nextjs, vite
  templates, astro, node — anything running on **Nodebox** (proprietary EULA, contact
  required). ⇒ Use only classic-bundler templates (react, vanilla, static, vue)
  commercially; treat Nodebox as off-limits.
- **CSP / hosting** [V]: preview runs in an external iframe on `*.codesandbox.io` by
  default ⇒ `frame-src https://*.codesandbox.io` + telemetry to their CDN. Supported
  alternative: [self-host the bundler](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)
  (static build, pass `bundlerURL`) — LibreChat does exactly this
  (`SANDPACK_BUNDLER_URL`, [docs](https://www.librechat.ai/docs/features/artifacts)).
  Self-hosted static bundler fits Cloudflare Pages/assets-Worker: serverless, ~zero cost,
  version-pinned, no third-party telemetry, air-gappable for local dev parity. Service
  worker caches transpilers ⇒ offline after first load [V, FAQ].
- **Capacitor** [I]: classic bundler avoids SharedArrayBuffer; it is a plain cross-origin
  iframe + service worker — expected to work in WKWebView/Android WebView, but service
  worker behavior under `capacitor://` scheme must be verified at implementation. Brave
  service-worker quirk documented [V, FAQ].
- **Values**: serves serverless (static bundler), cost (free, CDN deps), local parity
  (self-host in docker/dev), minimal lock-in (Apache-2.0 + forkable), accessibility
  (we own the surrounding panel UI). Violates: none structurally; risk is upstream
  staleness (mitigated by fork-ability and pinned self-hosting).

### B — StackBlitz WebContainers (full Node.js in browser)

- **Capabilities** [V]: real Node.js, real `npm install`, terminals, any framework —
  strictly the most powerful option.
- **Disqualifiers** [V]:
  1. **Proprietary; commercial use requires a paid license** from StackBlitz
     ([webcontainer-core LICENSE](https://github.com/stackblitz/webcontainer-core/blob/main/LICENSE)).
  2. **Requires SharedArrayBuffer ⇒ cross-origin isolation**: the whole embedding page
     must send `Cross-Origin-Opener-Policy: same-origin` +
     `Cross-Origin-Embedder-Policy: require-corp|credentialless`
     ([webcontainers.io/guides/configuring-headers](https://webcontainers.io/guides/configuring-headers)).
     COEP on our SPA would break every cross-origin resource not opting in (model
     provider assets, images) app-wide — a tax on the entire product for one panel.
  3. **Capacitor**: cross-origin isolation + SAB inside WKWebView is unsupported
     territory [I]; embed-isolation bugs open as of May 2026
     ([stackblitz/sdk#37](https://github.com/stackblitz/sdk/issues/37)).
- **Values**: violates cost efficiency (license fee), minimal vendor lock-in
  (proprietary runtime, no self-host below Enterprise Server), accessibility of the
  rest of the app to cross-origin content (COEP), local-dev parity (hosted runtime).

### C — Hand-assembled sandbox: sandboxed `srcdoc` iframe + esm.sh/JSPM imports (+ babel-standalone or esbuild-wasm for JSX)

- What [open-webui does](https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/artifacts/):
  sandboxed srcdoc iframe, optional injected `<meta>` CSP per artifact [V]. React via
  ESM CDN imports; JSX transpiled client-side. Known footgun: duplicate React instances
  with esbuild-wasm bundling ([esbuild#2327](https://github.com/evanw/esbuild/issues/2327)) [V].
- **Pros**: zero external dependency, tiny, full control, no CSP beyond our own iframe
  policy, trivially Capacitor-safe [I].
- **Cons**: it *is* hand-rolling — the founder excluded this; multi-file + npm-dep
  resolution + console + HMR is exactly the iceberg Sandpack already is. New entrant
  **Renderify** ([2026 post](https://dev.to/unadlib/renderify-a-runtime-engine-for-rendering-llm-generated-ui-instantly-in-the-browser-1amf))
  packages this pattern but is months old, unproven, Preact-compat-based [V] — too
  immature to bet the panel on.

### D — Pyodide (additive, not competing)

- Python-in-browser via WASM; ~15 MB first load, browser-cached; no sockets/threads;
  package set limited to Pyodide's built distribution [V,
  [open-webui docs](https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/python/)].
  open-webui runs it in a persistent worker; note they now class Pyodide as legacy in
  favor of server-side execution [V] — irrelevant to us (no server compute exists).
- Composable with A or C behind the same document-panel abstraction: a `python`
  artifact type dispatches to a Pyodide worker; `react|html` dispatches to Sandpack.
  Defer until Python artifacts are actually wanted (Simplicity First) [I].

### E — react-runner / react-live — rejected outright

- Executes LLM-generated code **in the host page's realm** (scope injection, no iframe
  boundary, no npm resolution — libraries must be pre-bundled)
  ([react-runner](https://github.com/nihgwu/react-runner)) [V]. Untrusted-code
  execution in our origin next to plaintext messages and keys is disqualifying. Never
  acceptable for artifacts.

### F — Runno / WASI runtimes — out of scope for the panel core

- MIT, healthy, multi-language (python/ruby/quickjs) via WASI + terminal
  ([runno.dev](https://runno.dev/wasi/)) [V], but stdin/stdout snippets only, no
  package installs, no DOM/React rendering — a future "run this snippet" garnish, not
  the document panel.

---

## Cross-check: what the Artifacts clones use [V]

| Product | Mechanism |
| --- | --- |
| LibreChat | **Sandpack**, self-hostable bundler fork ([docs](https://www.librechat.ai/docs/features/artifacts)) |
| open-webui | hand-rolled srcdoc iframe (+ Pyodide for Python) |
| lobe-chat | hand-rolled sandboxed iframe renderer ([RFC 053](https://github.com/lobehub/lobe-chat/discussions/3292)) |
| big-AGI | Sandpack (code-execution branch) |
| bolt.diy | WebContainers — community actively trying to escape it over licensing ([thread](https://thinktank.ottomator.ai/t/seeking-guidance-using-codesandbox-sandpack-instead-of-webcontainer-in-bolt-diy/7196)) |

The field splits Sandpack vs hand-roll; nobody who chose WebContainers is happy about
the license.

## Capability matrix

| | HTML/CSS/JS | React | Vue | Multi-file | npm deps | Console | Python | Terminal/Node | License | Headers/CSP |
|---|---|---|---|---|---|---|---|---|---|---|
| Sandpack (classic) | ✔ | ✔ | ✔ | ✔ | ✔ CDN | ✔ | ✖ | ✖ (Nodebox = EULA) | Apache-2.0 | `frame-src` bundler origin (self-hostable) |
| WebContainers | ✔ | ✔ | ✔ | ✔ | ✔ real npm | ✔ | ✖ | ✔ | proprietary, paid commercial | app-wide COOP/COEP |
| srcdoc hand-roll | ✔ | ✔ (esm.sh) | partial | hard | partial | DIY | via Pyodide | ✖ | n/a | own iframe CSP only |
| Pyodide | ✖ | ✖ | ✖ | ✖ | Pyodide dist only | ✔ | ✔ | ✖ | MPL-2.0 [A] | worker, same-origin |
| Runno | ✖ | ✖ | ✖ | ✖ | ✖ | stdio | ✔ | WASI shell | MIT | none notable |

## Recommendation

**Sandpack (`@codesandbox/sandpack-react` 2.20.0), classic client bundler only,
self-hosted bundler from day one** — confirming the TECH-STACK prior, now with evidence.

- Wins on capability-per-cost: the only maintained *package* giving multi-file
  React/HTML/CSS/Vue + runtime npm deps + console inside a proper iframe sandbox,
  Apache-2.0, no headers tax, no license fee.
- Self-hosting the bundler (static assets on our own origin/Pages) satisfies
  local-dev parity, kills the telemetry/CDN dependency, pins the version against
  upstream limbo, and keeps CSP to one first-party `frame-src` entry.
- Design the document panel behind our own thin artifact-renderer seam (type →
  renderer dispatch), so Pyodide (Python) can be added later and Sandpack is
  swappable if upstream truly dies — the LibreChat fork is the proven escape hatch.
- **Never adopt Nodebox templates** (nextjs/vite/astro/node) without a commercial
  agreement — lint-guard the template allowlist.

What would change the call: (a) Together AI archiving the repo or license change on a
future version → fork-and-pin or fall back to Option C; (b) a hard requirement for
real `npm install`/terminals → re-open WebContainers with eyes open on license + COEP;
(c) Sandpack service worker failing under `capacitor://` in verification → C for
mobile, Sandpack on web.

## Rejected

- **WebContainers** — paid proprietary license + app-wide COOP/COEP breakage + Capacitor
  incompatibility; power we don't need at a cost the whole app pays.
- **react-runner/react-live** — untrusted code in the host realm; security disqualifier.
- **Renderify** — right shape, too new (early 2026), unproven, single-author.
- **Hand-roll (srcdoc)** — excluded by the founder's "use a package"; remains the
  documented fallback if Sandpack upstream dies.
- **Runno/WASI** — no DOM rendering; not the panel core.

## Verification items for implementation

1. Sandpack service-worker + iframe behavior inside Capacitor WKWebView (`capacitor://`
   scheme) — [A] until run on device.
2. Self-hosted bundler build (`LibreChat-AI/codesandbox-client` fork vs
   `codesandbox/sandpack-bundler` experimental) — pick and pin.
3. Exact `frame-src`/`worker-src` CSP deltas against our current headers.
4. React 19 behavior inside the react template (peer dep allows ^19 [V]; template
   runtime version pinning to confirm [A]).
