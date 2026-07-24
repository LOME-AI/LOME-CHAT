# How open-source AI-chat products render/execute code artifacts — and what works in a stock WKWebView (no Service Worker)

Research date: 2026-07-24. All source reads are against each project's default branch at that date; pin commits/dates are noted where it matters.

## Distilled summary (read this first)

| Product | HTML/SVG mechanism | React mechanism | Python mechanism | Service Worker? |
|---|---|---|---|---|
| **open-webui** | `<iframe srcdoc>`, sandboxed, own CSP (`IFRAME_CSP`) | **Not supported** — docs say React is explicitly excluded from Artifacts | Pyodide (npm `pyodide` pkg) inside a **Web Worker**, vendored locally at build time | **No**, anywhere in the artifact/Python path |
| **LibreChat** | Sandpack `static` template (CodeSandbox bundler) | Sandpack `react-ts` template, fixed dep allowlist (shadcn/radix/recharts/mermaid) | Not in artifacts (separate code-interpreter API, not client-side) | **Yes** — Sandpack's bundler is SW-based; LibreChat forks/self-hosts it (`static-browser-server`) but SW remains load-bearing |
| **lobe-chat** | `<HtmlPreview>` (own `@lobehub/ui` component, iframe-based) | Sandpack `vite-react-ts`, fixed dep set (no arbitrary npm) | Displayed as a code block only — **no execution runtime** | **Yes** for React (Sandpack); **No** for HTML/SVG/Mermaid |
| **big-AGI** | Own `RenderCodeHtmlIFrame` — raw `iframe.contentDocument.write()`, no `srcdoc`, CSP explicitly disabled in code | **Not shipped** — Sandpack existed only on an abandoned 2023 branch (`variant-code-execution`), never merged | **No client-side Python** — Python runs via each vendor's server-side hosted "code execution" container (Anthropic/OpenAI/Gemini/xAI), not in-browser | **No** on the shipped code path |
| **Vercel Chatbot** (`vercel/chatbot`, ex `ai-chatbot`) | Plain HTML text/code artifact, editor-only (no execution) | **Not supported** as a runnable artifact kind (kinds are `text`, `code`, `image`, `sheet`) | Pyodide loaded from **jsdelivr CDN** (`loadPyodide` on `globalThis`) directly in the **main thread**, matplotlib output captured as base64 PNG | **No** |
| **assistant-ui** (`with-artifacts` example) | Plain `iframe srcDoc` + `sandbox="allow-scripts allow-forms"`, single HTML file only | Not in the example (would need a separate renderer) | N/A | **No** |
| **CopilotKit** (MCP-Apps / generative-ui-playground) | Agent-generated HTML/SVG/Canvas in a themed sandboxed iframe, iframe→parent via `postMessage` | N/A shown | N/A shown | **No** evidence found; author docs flag the whole approach as "iframe-only," explicitly **not yet a good fit for mobile** |

**Packaged "no-SW pattern" libraries found:**
- **`webllm/renderify`** (MIT, npm `renderify`) — the closest match to "packaged, one-codepath, no-SW artifact renderer." Babel-standalone in-browser transpile, npm deps resolved via JSPM CDN (fallback esm.sh/jsdelivr) with a runtime module-graph → blob-URL loader (no import-maps, no SW). Despite naming three "sandbox profiles" (`sandbox-worker`/`sandbox-iframe`/`sandbox-shadowrealm`), all three actually execute on a **Web Worker** boundary today — Worker, not SW, not real iframe/ShadowRealm isolation. React runs via a **Preact-compat shim**, not real React; single-source-block input, no true multi-file project support. Small and young: 23 stars, created Feb 2026, last push 2026-07-22 (1 day before this research) — active but unproven at scale.
- **`react-runner`** (nihgwu, MIT, npm `react-runner`, latest 1.0.5 published 2024-06-05) — in-process (same-document, no iframe/worker/SW at all) JSX evaluator; supports a real multi-file `import`/`importCode` graph and an arbitrary `scope` object you inject (so "arbitrary npm deps" = whatever you hand it in scope, not fetched by the library). No sandboxing of its own — you'd have to run it *inside* an iframe yourself for isolation. Lower activity than renderify but a stable, long-lived, dependency-free primitive.
- **`layershifter/react-source-render`** — same idea, explicitly **archived**, author-recommended replacement is `react-view` (not itself a sandboxed-iframe artifact renderer, more a docs/playground tool) — not a live option.
- **`13point5/open-artifacts` + `open-artifacts-renderer`** — a full Claude-Artifacts clone using the sandboxed-`iframe`+`postMessage`, `sandbox="allow-scripts"` (no `allow-same-origin`) pattern. **Archived, unmaintained** since mid-2024 (both repos `archived: true`, last push 2024-07-22/24) — reference-quality only, not something to depend on.
- **`claudio-silva/claude-artifact-runner`** and **`IntranetFactory/claude-artifacts-runner`** — not renderer *libraries*, they're scaffolds you `git clone` and run as your own local Vite app (paste the artifact source into a file, `npm run dev`). Not embeddable at runtime; out of scope for "packaged library."

**Bottom line for a mobile WKWebView (no Service Worker) target:** the only mechanism that is actually deployed and battle-tested by more than one of these projects, and that structurally cannot need a Service Worker, is **`<iframe srcdoc>` + `sandbox` attribute** for single-file HTML/SVG/JS artifacts (open-webui, big-AGI, lobe-chat's HTML path, assistant-ui's example), with **Pyodide inside a Web Worker (or even the main thread)** for Python. Nobody in this survey ships a production, SW-free, arbitrary-npm-deps **React** artifact renderer — every product that supports arbitrary/rich React artifacts (LibreChat, lobe-chat) does it via Sandpack, which is SW-based and documented (LibreChat's own self-host guide) as requiring HTTPS + wildcard-subdomain origin isolation, i.e. not WKWebView-viable as-is. The closest thing to a packaged answer for React-without-SW is `renderify` (Worker-based, Preact-compat, young) or rolling your own `react-runner`/Babel-standalone + `iframe sandbox` + esm.sh/import-maps stack, which is the pattern several 2025–2026 write-ups converge on as the modern no-SW, no-WebContainer approach.

---

## 1. open-webui

**Artifacts (HTML/SVG/JS):** rendered in a sandboxed `<iframe srcdoc>`. Verified by reading `src/lib/components/chat/Artifacts.svelte`:
```
<iframe
  bind:this={iframeElement}
  srcdoc={injectCsp(contents[selectedContentIdx].content, $config?.ui?.iframe_csp ?? '')}
  sandbox="allow-scripts allow-downloads{...allow-forms?...}{...allow-same-origin?...}"
  on:load={iframeLoadHandler}
></iframe>
```
(https://raw.githubusercontent.com/open-webui/open-webui/main/src/lib/components/chat/Artifacts.svelte, read directly, 2026-07-24). `allow-same-origin` and `allow-forms` are opt-in via settings, off by default — a stricter default sandbox than most peers. Verified.

The official docs are explicit that this is HTML/SVG/code-snippet only: *"React components... not rendered as Artifacts by Open WebUI."* (https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/artifacts/, fetched and read verbatim, 2026-07-24). Verified. No Sandpack, Babel, or bundler dependency exists in `package.json` (grepped for `sandpack`/`babel`, zero hits — https://raw.githubusercontent.com/open-webui/open-webui/main/package.json). Verified.

**CSP:** `IFRAME_CSP` env var (empty by default; the sandbox attribute alone provides baseline isolation) is injected as a `<meta>` CSP tag into every `srcdoc` iframe (artifacts, code/HTML previews, file preview modals) — same doc source. Verified.

**Pyodide (Python execution):** real dependency, `"pyodide": "^0.28.2"` in `package.json`, fetched/vendored at build time via `scripts/prepare-pyodide.js` (`pyodide:fetch` runs before `dev`/`build`) into `static/pyodide/`, then loaded and run inside a **Web Worker** — `src/lib/workers/pyodide.worker.ts` and `src/lib/pyodide/pyodideSandboxHost.ts` / `createPyodideWorker.ts` (all read directly from GitHub, 2026-07-24). This is a *separate* feature from Artifacts — the "Python Code Execution" chat feature, invoked on fenced Python code blocks — not a React-in-artifact runtime. Verified. Note: docs (https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/) call the in-browser Pyodide engine "legacy" and note it "may be deprecated" in favor of a server-side "Open Terminal" (Docker container) execution path for real workloads/full package support — Verified from docs text, though the search-summarized fetch (not full page read) means treat the exact wording as Inferred rather than a verbatim quote.

**Service Worker:** none found anywhere in the artifact or Pyodide path — the iframe uses `srcdoc` (data, not fetch-intercepted) and Pyodide runs from vendored static files loaded by a Web Worker. Verified (absence, via source read + package.json grep).

**Mobile/WebView story:** no explicit mobile app; open-webui is a self-hosted web app. Not researched further — out of scope of the question's per-product list, and no evidence surfaced of an app wrapper.

---

## 2. LibreChat

**Mechanism:** Sandpack (`@codesandbox/sandpack-react`), confirmed as a live dependency and used throughout `client/src/components/Artifacts/` (`ArtifactPreview.tsx`, `ArtifactTabs.tsx`) and `client/src/utils/artifacts.ts` (all grepped/read directly from `danny-avila/LibreChat` main branch, 2026-07-24). Verified.

Two Sandpack templates are used depending on artifact MIME type (read from `client/src/utils/artifacts.ts`):
- `text/html`, `application/vnd.code-html`, and LibreChat's own docx/spreadsheet/presentation-preview MIME types → Sandpack `static` template.
- `application/vnd.react` / `application/vnd.ant.react` / `application/vnd.mermaid` → Sandpack `react-ts` template.
Verified.

**React dependency depth:** fixed, curated allowlist baked into `artifacts.ts` — `@radix-ui/*` primitives, `embla-carousel-react`, `react-day-picker`, `dat.gui`, `vaul`, plus a separate `mermaidDependencies` set (`mermaid`, `react-zoom-pan-pinch`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`) for Mermaid artifacts. Not arbitrary npm — Verified from source, though whether *any* npm package can be requested at runtime (Sandpack does support ad-hoc `customSetup.dependencies`) vs. only this curated set actually being wired up in the UI was not fully traced end-to-end — Inferred that it's effectively the curated set based on what's imported into the template config.

**Bundler/origin:** by default LibreChat points Sandpack at CodeSandbox's public CDN bundler; the docs discussion (danny-avila/LibreChat discussion #9112, "how to host Artifacts sandbox locally") and LibreChat's own forks — `LibreChat-AI/codesandbox-client` and `LibreChat-AI/static-browser-server` — exist specifically to let self-hosters run the bundler themselves. Verified via `gh search code` hits for `SANDPACK_BUNDLER_URL` / `SANDPACK_STATIC_BUNDLER_URL` in `packages/api/src/shared-links/config.ts` and `api/server/routes/config.js`.

**Service Worker — confirmed required:** `LibreChat-AI/static-browser-server`'s own README states the static-bundler mechanism works by *"leveraging Service Workers to intercept network requests and serve the virtual files"*, that HTTPS is mandatory because service workers require a secure context, and that the architecture needs a hidden relay iframe plus **wildcard-subdomain origin isolation** (`RANDOMID-preview.yourdomain.com` + wildcard DNS/TLS) so each preview session gets its own browser origin and its own SW registration (read via WebFetch of https://github.com/LibreChat-AI/static-browser-server, 2026-07-24). Verified. This applies to *both* Sandpack templates LibreChat uses (`static` and `react-ts` share the same Sandpack bundler infrastructure) — Inferred, since the README documents the static-preview server specifically but Sandpack's bundler protocol (SW-intercepted virtual filesystem) is documented as the same mechanism for all its templates per Sandpack's own docs (https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler, https://sandpack.codesandbox.io/docs/advanced-usage/bundlers).

**Python:** not part of the Artifacts renderer at all (search of the same files found no Pyodide/Python execution wiring in the artifact path). LibreChat's Python/code-interpreter feature is a separate server-side API tool, not client-browser execution — Inferred from absence in the artifacts source plus general LibreChat docs describing "Code Interpreter API" as a paid/hosted tool, not researched in depth (out of the artifact-rendering scope).

**Mobile app:** no official LibreChat mobile app. GitHub Discussion #695 ("LibreChat Apps (iOS, Android, Mac, Windows)") shows only community exploration of wrapping the web frontend (Capacitor/React Native), no shipped product — Verified via WebSearch result summary of that discussion thread (not independently fetched in full). Given the SW+wildcard-subdomain dependency above, an unmodified LibreChat artifacts panel would not function inside a stock WKWebView-based wrapper.

---

## 3. lobe-chat

**Split mechanism by artifact type** — confirmed by reading the actual renderer components under `src/features/Portal/Artifacts/Body/Renderer/` on `lobehub/lobe-chat` main (2026-07-24):

- **HTML** (`Renderer/HTML.tsx`) → wraps `InlineHtmlPreview` (`src/components/HtmlPreview/InlinePreview.tsx`) which renders lobe-chat's own `@lobehub/ui` `<HtmlPreview>` component — an iframe-based preview (component internals live in the separate `@lobehub/ui` package and weren't independently fetched, so "iframe, no SW" for this specific leaf is **Inferred** from the component's role and naming, not read at the byte level).
- **React** (`Renderer/React/index.tsx`) → **Sandpack**, verified verbatim:
  ```
  import { SandpackLayout, SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react';
  ...
  <SandpackProvider customSetup={{ dependencies: project.dependencies }} files={project.files}
    template="vite-react-ts" theme="auto" ...>
    <SandpackLayout><SandpackPreview /></SandpackLayout>
  </SandpackProvider>
  ```
  Project files/deps are built by `buildReactArtifactProject()` from a separate `@lobechat/artifact-template` package (not independently fetched). Verified for the Sandpack usage itself.
- **SVG**, **Mermaid** → separate small renderer files (`SVG.tsx`, plus Mermaid handled elsewhere per the RFC) — not deep-read, but same family as HTML (Inferred non-Sandpack).

**React dependency depth:** per the original RFC (`lobehub/lobe-chat` Discussion #3292, fetched via WebFetch 2026-07-24) the `lobeArtifact` React type ships a **fixed** import set — base React, `lucide-react@0.263.1`, `recharts`, shadcn/ui, Tailwind — with the prompt explicitly stating *"NO OTHER LIBRARIES (e.g. zod, hookform) ARE INSTALLED OR ABLE TO BE IMPORTED."* Verified (RFC text), though the RFC itself flags that whether this exact restriction survived into the shipped Sandpack-based renderer (vs. Sandpack's own `customSetup.dependencies` allowing more) wasn't confirmed in the RFC and wasn't independently re-verified against `@lobechat/artifact-template`'s current dependency list — treat the "fixed set" claim as **Inferred** for the current build, **Verified** only for the original design intent.

**Python:** the top-level `ArtifactsUI` component (`Body/index.tsx`, read directly) has an `ArtifactType.Python` case that only selects the `python` syntax-highlighting language for the code view — Verified there is no execution wiring visible in that file, and the RFC explicitly says Python is *"example code text rendered as a code artifact — there's no code-execution runtime."* Verified/Inferred combined: the absence-of-execution claim is Verified from source; the RFC's characterization corroborates it.

**Service Worker:** **Yes**, for the React path — identical Sandpack/CodeSandbox-bundler mechanism as LibreChat (see §2), same SW dependency. **No** for HTML/SVG/Mermaid, which route through lobe-chat's own iframe-based `HtmlPreview` component (Inferred, not fully verified at the `@lobehub/ui` implementation level).

**Mobile app / WebView:** not researched — out of the question's explicit per-product list for lobe-chat, and no strong signal surfaced in searches of a shipped lobe-chat mobile app.

---

## 4. big-AGI

**HTML/JS code blocks:** big-AGI's own component, `src/modules/blocks/code/code-renderers/RenderCodeHtmlIFrame.tsx` (read in full from `enricoros/big-AGI` main, 2026-07-24). Notably it does **not** use `srcdoc` — it grabs `iframeDoc = iframe.contentDocument`, calls `iframeDoc.open()` / `iframeDoc.write(modifiedHtml)` / `iframeDoc.close()` directly, injecting a small CSS reset by string-replacing the first `<style` tag. The file's own comments show CSP and `DOMPurify` sanitization were both **considered and explicitly disabled**: *"Enhanced Security with Content Security Policy // NOTE: 2024-06-15 disabled until [we] understand exactly all implications"* and a similarly commented-out `DOMPurify.sanitize()` call. Verified — this is a materially weaker sandboxing posture than open-webui's `srcdoc` + `sandbox` + CSP approach (the iframe presumably still has an implicit `sandbox` from being cross-document-written, but no explicit `sandbox` attribute was visible in the fetched snippet, and no CSP meta is injected). Should be flagged as a real security-posture difference, not just a mechanism difference.

**React artifacts:** **not shipped.** The only trace of Sandpack in the repo is in `docs/changelog.md`, describing an old *"Code Execution: Sandpack"* changelog entry pointing at a since-abandoned branch `variant-code-execution` (2023-era commit), and one comment in `ChatMessage.tsx` mentioning Sandpack conceptually. `package.json` has **zero** `sandpack`/`pyodide` entries (grepped directly). Verified: big-AGI never shipped a bundler-based React-artifact renderer on `main`.

**Python / code execution:** big-AGI's actual, current code-execution story is **server-side, vendor-hosted containers** — Anthropic's `code_execution_20260120` tool, plus equivalent OpenAI/Gemini/xAI server-side code-interpreter tools — unified under a "Code Sandbox" UI label, per `kb/modules/AIX-anthropic-code-execution.md` (fetched in full, 2026-07-24, an internal design doc dated "Status (2026-06)"). This is **not** in-browser execution at all; it's a remote container the model drives via tool calls. The same doc lists a **forward-looking, not-yet-built** `client-browser` locus — *"in-page isolate (iframe/Worker/Pyodide), app-bound, OPFS for file persistence"* — explicitly under a section titled "Forward direction... partly open," so this is a **design note about a future option**, not a shipped feature. Verified (doc read in full) that this is aspirational/undecided, not implemented.

**Service Worker:** none found on the shipped HTML-preview path. N/A for the (unshipped) React path. N/A for Python (server-side, not browser).

**Mobile app / WebView:** not researched — big-AGI is a Next.js PWA-style web app; no evidence surfaced in this session of a dedicated native wrapper.

---

## 5. Vercel AI Chatbot / v0

The current canonical open-source repo is `vercel/chatbot` (the renamed/current form of the older `vercel/ai-chatbot`; confirmed by browsing its live `components/chat/` tree, 2026-07-24). `v0` itself (the hosted product) has no public source — only the open template was inspected. Treat any "v0" claim below as **not verified** (excluded).

**Artifact kinds:** exactly four, defined in `components/chat/artifact.tsx`: `textArtifact`, `codeArtifact`, `imageArtifact`, `sheetArtifact` (`artifacts/*/client.tsx`). There is **no** `reactArtifact`/HTML-preview kind — Verified by reading the file's `artifactDefinitions` array directly.

**Python execution — client-side Pyodide, main thread, CDN-loaded:** `artifacts/code/client.tsx` (read in full) does:
```js
// @ts-expect-error - loadPyodide is not defined
const currentPyodideInstance = await globalThis.loadPyodide({
  indexURL: "https://cdn.jsdelivr.net/pyodide/v0.23.4/full/",
});
currentPyodideInstance.setStdout({...});
await currentPyodideInstance.loadPackagesFromImports(content, {...});
...
await currentPyodideInstance.runPythonAsync(content);
```
This runs directly on `globalThis` in whatever execution context `client.tsx` is loaded in (the main React app, not a Worker or iframe) — Verified from source. `matplotlib` support is special-cased: a Python "output handler" template switches the backend to `agg`, captures the figure as a base64 PNG data URI printed to stdout, and the console UI (`components/chat/console.tsx`) renders it (Verified: the `matplotlib` handler string was read in full and shows exactly this `io.BytesIO()`/`base64.b64encode` pipeline).

**Code artifact for other languages:** the `codeArtifact` is really a Python-only "run" experience (`OUTPUT_HANDLERS` are Python-specific); other languages just get a Monaco/CodeMirror-style editor with syntax highlighting, no execution — Inferred from the file's structure (only `basic`/`matplotlib` Python handlers were defined; no JS/TS execution path was found in the fetched portion of the file).

**HTML preview / React execution:** not present as an artifact kind at all in this template. Any "code preview" story for arbitrary HTML/React in the *hosted* v0 product is unverified (no public source).

**Service Worker:** none — Pyodide loads from a CDN script and runs in-page. Verified (absence) from the source read.

**Mobile app:** no mobile app; Vercel Chatbot is a Next.js web app template. Not applicable.

---

## 6. Packaged "no-SW, Claude-artifacts-pattern" renderer libraries

This was the key open question — is there a maintained, drop-in library implementing sandboxed-iframe + in-browser-transpile/interpret with **no Service Worker dependency**? Findings, ranked by how close each comes:

### `webllm/renderify` (npm: `renderify`) — closest match found
- Source: README fetched via WebFetch (https://raw.githubusercontent.com/webllm/renderify/main/README.md), repo metadata via GitHub API (2026-07-24).
- **Mechanism (Verified from README):** in-browser transpilation via `@babel/standalone`; npm dependency resolution through a **JSPM CDN** primary path with configurable esm.sh/jsdelivr fallback CDNs (`RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS`); module graph resolved at runtime via fetch → import-specifier rewrite (using `es-module-lexer`) → **blob URL**, not classic `<script type="importmap">`.
- **Sandbox:** three named profiles (`sandbox-worker`, `sandbox-iframe`, `sandbox-shadowrealm`) but the README itself states the iframe/shadowrealm names are **"compatibility names"** — all three currently execute on a **Web Worker** boundary; a display iframe exists only as "a presentation boundary, not a security boundary." A fourth `isolated-vm` profile is reserved for the future and currently fails closed. Verified from README text as summarized by WebFetch (not read byte-for-byte by me, so treat exact wording as high-confidence Inferred rather than a direct quote).
- **No Service Worker anywhere** — Verified (README states module loading uses fetch+blob URLs, explicitly not SW interception).
- **React support:** runs on **Preact via a `react`/`react-dom`/`react-dom/client`/`react/jsx-runtime` compat shim**, not real React — meaning React-specific internals/devtools/some ecosystem packages that assume real React may not work, though common consumer libraries like `recharts`/`@mui/material` are named as working. No explicit multi-file project support (single source block per RuntimePlan). This is a real limitation versus "arbitrary React app."
- **Maintenance:** MIT license, `webllm` GitHub org, 23 stars, created 2026-02-11, **last push 2026-07-22** (Verified via GitHub API `pushed_at`) — actively maintained but very young and small; no evidence of production adoption found.
- **Mobile/WebView:** no explicit mention found in the README extraction of iOS/WKWebView/Safari compatibility either way.

### `react-runner` (nihgwu/react-runner, npm `react-runner`)
- Verified via npm registry (`latest: 1.0.5`, published `2024-06-05`) and README (fetched raw from GitHub).
- **Mechanism:** in-process JSX/JS evaluator — no iframe, no worker, no SW by default; you embed it directly in your React tree via `<Runner code={code} scope={scope} />` or the `useRunner` hook.
- **Multi-file:** real support via `importCode()` — you build a `scope.import` map of virtual modules (including nested `importCode()` calls for local files), and live code can `import` from them.
- **Arbitrary npm deps:** supported only in the sense that *you* supply them in `scope` (e.g. `scope.import['your-pkg'] = YourPkg` after your own bundler/CDN-fetch has resolved it) — the library itself does no dependency resolution or CDN fetching.
- **Sandboxing:** none built in — it evaluates in the same JS realm as your host app, so any isolation (the actual "artifacts" security requirement) has to be layered on by putting the whole `Runner` inside your own sandboxed iframe.
- Declared browser support floor: Chrome 61+, Edge 16+, Firefox 60+, Safari 10.1+ — no WKWebView-specific statement, but this floor implies no dependency on Service Workers or other iOS-14+-only APIs.

### `layershifter/react-source-render` — dead end
Explicitly **archived**; author recommends `react-view` instead (a docs/playground tool, not itself a sandboxed artifact renderer). Not viable. Verified via WebSearch result summary.

### `13point5/open-artifacts` + `open-artifacts-renderer` — unmaintained reference
Full Claude-Artifacts clone (Next.js/Supabase/shadcn/Vercel AI SDK) with a dedicated "Open Artifacts Renderer" served at a configurable origin (`NEXT_PUBLIC_ARTIFACT_RENDERER_URL`) and communicated with via the standard `sandbox="allow-scripts"` (deliberately **no** `allow-same-origin`) + `postMessage` pattern — the textbook no-SW isolation model, same family as CodePen/JSFiddle. Verified: both `13point5/open-artifacts` and `13point5/open-artifacts-renderer` are **archived** on GitHub (`archived: true`), last pushed 2024-07-22/24 — over two years stale as of this research, not something to adopt as a dependency, but a clean architecture reference.

### `claudio-silva/claude-artifact-runner`, `IntranetFactory/claude-artifacts-runner`
Not runtime libraries — they're local-dev scaffolds (Vite + React + TS + Tailwind + shadcn) you clone, paste an artifact's source into, and `npm run dev`. Useful for a developer previewing one artifact at a time, structurally inapplicable to "render arbitrary user-facing artifacts at runtime in an app," and definitely inapplicable to a WKWebView (`file://`/dev-server-only). Verified from README descriptions (WebSearch summaries), not independently fetched byte-for-byte.

### Modern DIY pattern (not a packaged library, but converged-on in 2025–2026 write-ups)
Multiple sources (Sandpack's own "experimental bundler (beta)" docs, esm.sh's own docs, and a `esm.sh`/import-maps overview fetched via WebSearch) converge on: **`<iframe srcdoc>` + `sandbox` + in-browser transpile (Babel-standalone or esbuild-wasm) + `esm.sh` CDN resolution via native `<script type="importmap">` (with `es-module-shims` as a polyfill for the ~5% of browsers lacking native import-map support)** as the modern, SW-free way to get npm-dependency React previews in a sandboxed iframe. This is architecturally exactly what `renderify` and `react-runner`+iframe-wrapper approximate, but no single well-known, actively-maintained **packaged** library that combines *all* of (a) sandboxed iframe isolation, (b) in-browser transpile, (c) esm.sh/import-map npm resolution, and (d) zero SW dependency into one drop-in component was found beyond `renderify` (young/small) and DIY assembly. **Gap, not a finding** — see below.

---

## Mobile WebView (WKWebView, no Service Worker) analysis

- **Service-Worker-in-WKWebView is fundamentally unreliable/unavailable for this use case.** WebSearch of Apple developer forum threads and StackBlitz's own docs (https://developer.stackblitz.com/platform/webcontainers/browser-support, https://developer.apple.com/forums/thread/773539, https://developer.apple.com/forums/thread/770366) confirms: WKWebView only supports Service Workers via the **App-Bound Domains** mechanism (iOS 14+), which (a) caps you at a small fixed list of allowed domains, (b) is documented to conflict with `WKUserScript`/`addUserScript` injection that most hybrid frameworks (including Capacitor, per this project's stack) rely on, and (c) has reported reliability problems (blank screens, navigation lockdown outside the app-bound list). This was reported as a WebSearch synthesis, not independently re-verified against each individual forum thread — **Inferred**, but corroborated by StackBlitz's own documented conclusion that **WebContainers (and by extension any SW-hard-dependent runtime like Sandpack's default bundler) cannot run inside WKWebView-based apps.**
- **Consequence for this survey:** every mechanism that depends on a Service Worker — LibreChat's and lobe-chat's Sandpack-based React artifacts, and Sandpack generally — is **not viable unmodified** inside a Capacitor/WKWebView shell. This directly matches the architecture already documented in this project's own `docs/history` around Sandpack (planned, not yet built per `TECH-STACK.md`'s "Sandpack _(planned)_" entries) — worth flagging to whoever owns that decision.
- **What *is* mobile-viable, verified as already shipping:** `<iframe srcdoc>` + `sandbox` attribute for single-file HTML/SVG/JS (open-webui, big-AGI, lobe-chat's HTML path, assistant-ui's example) — `srcdoc` is a same-document attribute, not a network fetch, so it has no SW dependency and works in any WebView that supports iframes and the `sandbox` attribute (universal since iOS Safari/WKWebView's earliest sandboxed-iframe support). Pyodide **inside a Web Worker** (open-webui) or even the **main thread** (Vercel Chatbot) is likewise SW-free — Web Workers are fully supported in WKWebView without any app-bound-domain dance.
- **No product surveyed ships a production, SW-free, arbitrary-npm React artifact renderer.** The two candidates for that gap are (a) `renderify` (Worker-sandboxed, Preact-compat, young/small — real risk profile) or (b) assembling `react-runner`/Babel-standalone + your own `iframe sandbox` + `esm.sh`+import-maps, which is exactly the DIY pattern several practitioner write-ups now recommend as the SW-free 2025–2026 replacement for WebContainers/Sandpack.

---

## Gaps / not independently verified

- `@lobehub/ui`'s `<HtmlPreview>` component internals (does it use `srcdoc`? explicit `sandbox` attribute? own CSP?) were not fetched — the "no SW" claim for lobe-chat's HTML path is Inferred from its role, not read at the source level.
- `@lobechat/artifact-template`'s *current* dependency allowlist for the Sandpack `react-ts` template was not independently fetched — the "fixed dependency set, no arbitrary npm" claim for lobe-chat's React artifacts rests on the 2024 RFC's stated design intent, not a live read of today's template package.
- Whether LibreChat's Sandpack `react-ts` template (vs. just the `static` HTML template) is documented as SW-dependent was corroborated only via Sandpack's own general bundler docs, not a LibreChat-specific statement — treated as Inferred, flagged inline above.
- v0 (the hosted Vercel product) has no public source; nothing here should be read as describing v0's actual runtime, only the open `vercel/chatbot` template.
- CopilotKit's actual artifact-iframe implementation source was not fetched directly — findings for it rest entirely on WebSearch summaries of its docs/demo repos, including the explicit "not yet a good fit for mobile" caveat, which was not traced to a specific doc URL beyond the search snippet.
- `renderify`'s README was read via WebFetch's summarization, not a raw byte-for-byte fetch — treat exact phrasing (e.g. "compatibility names") as paraphrase-accurate rather than verbatim-quoted.
- No product in this survey was checked for a WKWebView-specific compatibility statement in its own docs/issues (i.e., none of them document "does/doesn't work in Capacitor/WKWebView" themselves) — the WKWebView analysis above is derived from general Service-Worker-in-WKWebView constraints, applied to each mechanism, not from product-specific mobile testing reports.
