# In-browser code execution / artifact preview — integration map

Research only. No code changed. Repo: HushBox, apps/web + apps/api + packages/shared.

---

## 1. The document panel

**What it is**: `DocumentPanel` (`apps/web/src/components/document-panel/document-panel.tsx`) is a
resizable/fullscreen-able side panel docked in the chat layout — NOT a modal, NOT a route. It shows
exactly one "document" at a time (title, copy/download/fullscreen/close controls, and for mermaid
only, a rendered↔raw toggle).

- **Mount point**: `apps/web/src/components/chat/layout/chat-layout.tsx:52-54` lazy-imports it
  (`React.lazy`) and renders `<DocumentPanel />` at `chat-layout.tsx:388`, alongside the message list.
- **State**: `apps/web/src/stores/document.ts` — a Zustand store (`useDocumentStore`), persisted
  (only `panelWidth` is persisted via `partialize`). Fields: `isPanelOpen`, `activeDocumentId`,
  `activeDocument: Document | null`, `panelWidth`, `isFullscreen`. Actions: `openPanel`,
  `closePanel`, `togglePanel`, `setActiveDocument(document)`, `setPanelWidth`, `toggleFullscreen`.
- **The `Document` type** (`apps/web/src/lib/document-parser.ts:3-10`):
  ```ts
  interface Document {
    id: string;
    type: 'code' | 'mermaid' | 'html' | 'react';
    language?: string;
    title: string;
    content: string;
    lineCount: number;
  }
  ```
  `'html'` and `'react'` types already exist in the type union (`getDocumentType` maps
  `language === 'html'` → `'html'`, `jsx`/`tsx` → `'react'`) but **nothing renders them specially
  yet** — `DocumentContent` (document-panel.tsx:168-189) only special-cases `type === 'mermaid'`;
  everything else (including existing `'html'`/`'react'` docs) falls through to the generic
  Shiki-highlighted code view. This is the exact seam a live HTML/React preview would plug into.
- **How content gets in — the extraction pipeline**:
  1. `MarkdownRenderer`'s Streamdown `components.pre` override
     (`apps/web/src/components/chat/message/markdown-renderer.tsx:97-124`) intercepts every
     rendered `<pre>` (i.e. every fenced code block in a chat message).
  2. `extractCodeBlockMeta` (markdown-renderer.tsx:66-75) pulls `{ language, codeText, lineCount }`
     from the HAST node Streamdown handed it.
  3. `shouldExtractAsDocument(language, lineCount)` (document-parser.ts:71-75) — true for any
     `mermaid` block regardless of length, or any other language block ≥ `MIN_LINES_FOR_DOCUMENT`
     (15 lines).
  4. If true, a `Document` is built (`getDocumentType`, `extractTitle`, `generateDocumentId` — a
     content hash, so the id mutates as a still-streaming block grows) and rendered as a
     `<DocumentCard>` inline in the chat message instead of a raw code block.
  5. `DocumentCard` (`apps/web/src/components/chat/media/document-card.tsx`) is a clickable summary
     chip; `onClick` → `setActiveDocument(document)` → opens the panel. It also re-claims the active
     slot on id-churn while streaming (document-card.tsx:59-74) so a still-streaming open document
     doesn't freeze on stale content.
  6. Small code blocks (< 15 lines, non-mermaid) are NOT extracted — they render inline via
     `@streamdown/code`/Shiki as normal.

## 2. Mermaid rendering end-to-end

- **Inline chat rendering** (inside `MarkdownRenderer`, not the panel): the `@streamdown/mermaid`
  plugin is registered directly on `<Streamdown plugins={{ code: safeCode, mermaid, math }}>`
  (markdown-renderer.tsx:161) with `controls={{ code: true, mermaid: { copy: true, download: true } }}`
  — this is Streamdown's own built-in mermaid renderer, used for mermaid blocks *under* the
  15-line document-extraction threshold... but `shouldExtractAsDocument` always returns `true` for
  `mermaid` regardless of length (document-parser.ts:73), so in practice essentially all mermaid
  blocks get intercepted by the `pre` override and routed to `DocumentCard` → the panel instead;
  Streamdown's own mermaid plugin path is effectively a fallback/for streaming-partial states.
- **The founder's "rendered vs raw, defaulting to rendered" toggle IS in the document panel, not
  the inline renderer.** It's implemented per-document, only for `type === 'mermaid'`:
  - `supportsRawToggle = activeDocument.type === 'mermaid'` (document-panel.tsx:283) — this is the
    single line that would need generalizing (e.g. to `'html' | 'react'`) to reuse the same toggle
    UI for a code-execution preview.
  - State: local `showRaw` (`React.useState(false)`, document-panel.tsx:205) — defaults to
    rendered, and resets to `false` whenever `activeDocumentId` changes (`useEffect`,
    document-panel.tsx:210-212).
  - Toggle button: `PanelHeader`'s `Eye`/`Code` icon button (document-panel.tsx:117-131),
    `aria-label={showRaw ? 'Show rendered' : 'Show raw'}`, only rendered when `supportsRawToggle`.
  - Rendered branch: `<MermaidDiagram chart={document.content} />`
    (`apps/web/src/components/chat/message/mermaid-diagram.tsx`) — wraps the `mermaid` npm package
    directly (not the Streamdown plugin), `mermaid.initialize({ securityLevel: 'strict', theme })`
    re-run per render for light/dark theme sync (mermaid-diagram.tsx:16-22), async
    `mermaid.render(id, chart)` in a `useEffect`, loading/error/success states, final SVG injected
    via `dangerouslySetInnerHTML` (mermaid-diagram.tsx:88-94).
  - Raw branch: re-wraps `document.content` into a fenced code block string
    (`buildFencedCodeBlock`, document-panel.tsx:152-166 — picks a backtick fence longer than any
    backtick run inside the content) and re-renders it through a second, minimal `<Streamdown
    plugins={{ code }} controls={{ code: false }} animated={false}>` instance
    (document-panel.tsx:173-176) purely for Shiki syntax highlighting, no markdown prose chrome.
  - Non-mermaid documents (code/html/react) always render via the same
    `buildFencedCodeBlock` + highlighted-`Streamdown` path (document-panel.tsx:182-188) — there is
    no raw/rendered split for them today.
- Styling: panel and content use Tailwind utility classes only (`bg-muted`, `rounded-lg`, etc.),
  no bespoke CSS files beyond `apps/web/src/app.css` (global) and `streamdown/styles.css` /
  `katex/dist/katex.min.css` imported once in `apps/web/src/main.tsx:11,15`.

## 3. Streamdown integration

- **Two independent Streamdown call sites**, each configuring its own plugin set:
  1. `MarkdownRenderer` (markdown-renderer.tsx:160-168) — the full chat-message renderer:
     `plugins={{ code: safeCode, mermaid, math }}`, custom `components` (`pre` override for
     document extraction, `a` override for brand-red links), `controls`, `isAnimating`/`animated`
     for the streaming-cursor effect.
  2. `DocumentContent` inside the panel (document-panel.tsx:173-176, 184-186) — highlighting-only:
     `plugins={{ code }}` (bare `@streamdown/code`, not the "safe" wrapper), `controls={{ code:
     false }}`, `animated={false}`. No `mermaid`/`math` plugin here — the panel's mermaid path
     goes through the dedicated `MermaidDiagram` component instead, not Streamdown's mermaid
     plugin.
- **Code block highlighting**: `@streamdown/code` wraps Shiki. It is never used raw in
  `MarkdownRenderer` — it's wrapped by `createSafeCodePlugin`
  (`apps/web/src/components/chat/message/code-plugin.ts`), exported as `safeCode`. The wrapper
  short-circuits `highlight()` to `null` when `!supportsLanguage(options.language)`, suppressing
  Shiki's console error spam for partial/unknown language identifiers seen mid-stream (e.g. `jso`
  while `json` is still typing in). **This is the plugin registration surface where a new
  code-fence language (e.g. a sandboxed-execution marker) would be recognized/highlighted** — but
  language *support* comes from Shiki's `bundledLanguagesInfo` (also the source for
  `document-parser.ts`'s `DISPLAY_NAMES`/`FILE_EXTENSIONS` maps), not a HushBox-owned registry.
- **New plugin registration mechanism**: Streamdown's `plugins` prop is just an object literal —
  `{ code, mermaid, math }` — each key a plugin package export. Adding e.g. a `@streamdown`-style
  sandbox-preview plugin (if one existed) would mean adding an import + a key to the `plugins={{}}`
  object in `markdown-renderer.tsx:161` and probably NOT in the panel's minimal `DocumentContent`
  Streamdown instance (which is deliberately highlight-only).
- **Build-time Streamdown patch**: `apps/web/vite.config.ts:82-92` +
  `apps/web/src/lib/inline-streamdown-lazy-imports.ts` — a custom Vite `transform` plugin that
  rewrites Streamdown's internal `React.lazy(() => import('./highlighted-body-X.js'))` /
  `import('./mermaid-X.js')` dynamic imports into static imports, because those lazy chunks can
  404 after a deploy rotates old chunks off the CDN. Any new Streamdown lazy-loaded plugin chunk
  (e.g. a future sandbox/artifact plugin) would likely need the same treatment if it ships as a
  separate lazy chunk. `vite.config.ts:178-183` also manually forces all `streamdown`
  node_modules code into one `streamdown` output chunk (`manualChunks`).
- Package versions (`apps/web/package.json:36-38,53`): `@streamdown/code@^1.1.1`,
  `@streamdown/math@^1.0.2`, `@streamdown/mermaid@^1.0.2`, `streamdown@^2.5.0`.

## 4. CSP / security headers / iframe / Capacitor

- **Product API (apps/api) response headers** — `apps/api/src/middleware/security-headers.ts:8-17`:
  applies to API JSON/WS responses (not the SPA's own HTML/JS), CSP is minimal
  (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:
  blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`) — not
  the relevant policy for in-page rendering.
- **The web SPA's actual CSP** is generated, not hand-written: `scripts/generate-headers.ts`
  (`buildSpaHeaders`, lines ~95-151) emits `apps/web/dist/_headers` (Cloudflare Pages `_headers`
  format) at build time via the `headersPlugin` Vite plugin
  (`apps/web/vite.config.ts:10,171` → `scripts/lib/headers-vite-plugin`). Key directives
  (`generate-headers.ts:117-150`):
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com` —
    `'unsafe-eval'` is already present (needed by legacy globalThis-polyfill code in the streamdown
    chunk today), `'wasm-unsafe-eval'` for argon2id.
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' blob: data:`, `media-src 'self' blob:`, `font-src 'self' data:`
  - `connect-src`: `'self'` + API origin (http+ws) + R2 wildcards + Helcim host (+ local MinIO
    origin in dev/E2E)
  - `frame-ancestors 'none'` (site is never framed by others)
  - **No `frame-src` / `child-src` directive is set anywhere** — under CSP fallback rules this
    means iframes *embedded by the app* fall back to `default-src 'self'`, i.e. only same-origin
    (or `srcdoc`) iframes are currently permitted; a sandboxed preview iframe using `srcDoc` would
    be allowed under the existing policy, but any cross-origin sandbox host (a CodeSandbox/
    StackBlitz-style separate origin, or an eval-worker on a second domain) would need a new
    `frame-src`/`child-src` allowlist entry — a CSP change.
  - `X-Frame-Options: DENY` (site-wide; only relaxed for `/demo`, see below).
- **`/demo` route relaxation** — `generate-headers.ts:153-177` (`buildDemoHeaders`): the only
  route-specific CSP variant besides marketing-route script hashes. Relaxes `frame-ancestors` to
  `'self'` and `X-Frame-Options` to `SAMEORIGIN` (still never cross-origin) so the marketing
  `/welcome` page can embed the live app-in-demo-mode via a same-origin `<iframe>`
  (`apps/web/src/components/native-assets/social-banner.tsx:146-150` uses a plain `src={demoSource}`
  iframe with no `sandbox` attribute — trusted same-origin content).
- **Existing sandboxed-iframe precedent** — `apps/web/src/routes/dev.emails.tsx:76-82`: a
  dev-only email-template preview using `<iframe srcDoc={template.html} sandbox="" .../>`.
  `sandbox=""` is maximally restrictive (no scripts, no same-origin, no forms, no popups) — this is
  the closest existing pattern in the repo to "render untrusted HTML safely," though it disables
  script execution entirely, so a runnable-code preview would need a **less** restrictive sandbox
  token set (e.g. `sandbox="allow-scripts"`, deliberately omitting `allow-same-origin` to keep the
  iframe origin opaque/null and prevent it from reaching cookies/localStorage/parent DOM).
- **`apps/web/dist/_headers`** is fully generated (banner: "do not edit by hand") — any header
  change must go through `scripts/generate-headers.ts` + regenerate, verified by
  `scripts/generate-headers.test.ts`.
- **Admin SPA** (`buildAdminSpaHeaders`, `generate-headers.ts:568-594`) is unrelated — separate,
  stricter, same-origin-only CSP for `admin.hushbox.ai`; not a target for this feature.
- **Capacitor mobile WebView** — `apps/web/capacitor.config.ts`: no CSP-specific config; relevant
  fields are `webContentsDebuggingEnabled` (dev-only, `resolveWebContentsDebugging`,
  capacitor.config.ts:15-18), `androidScheme: 'http'` (capacitor.config.ts:28, for same-site
  cookie behavior against the dev API), `CapacitorHttp: { enabled: false }` (native HTTP bridge
  disabled — all requests go through the WebView's normal fetch, so the web CSP above governs the
  mobile app too), `CapacitorCookies: { enabled: true }`. No mobile-specific CSP override was found;
  the WebView presumably inherits whatever `_headers`/meta-tag policy ships with `dist/`. **Gap**:
  did not find a `<meta http-equiv="Content-Security-Policy">` tag in `index.html` — Cloudflare
  Pages `_headers` doesn't apply inside a packaged Capacitor WebView (no HTTP response headers from
  a local file load), so CSP enforcement inside the native app needs verification — worth a
  follow-up check of `apps/web/index.html` and the Android/iOS asset bundling step.

## 5. System prompt construction (apps/api / packages/shared)

- **Single system-prompt builder**, shared so client-side price preview and server-side billing
  price the *same* prompt text: `packages/shared/src/prompt/system-prompt.ts:24-36`
  (`buildTurnSystemPrompt({ now, customInstructions? })`):
  ```ts
  export function buildTurnSystemPrompt(input: SystemPromptInput): string {
    const currentDate = utcDayKey(input.now);
    const sections: string[] = [`${BASE_SYSTEM_PREAMBLE}\nCurrent date: ${currentDate}`];
    const customInstructions = input.customInstructions?.trim();
    if (customInstructions !== undefined && customInstructions.length > 0) {
      sections.push(`## User's Custom Instructions\n${customInstructions}`);
    }
    return sections.join('\n\n');
  }
  ```
- **Static base preamble**: `packages/shared/src/prompt/base-preamble.ts` — `BASE_SYSTEM_PREAMBLE`,
  a short constant string identifying HushBox, describing multi-model chat + encryption, asking for
  concise accurate answers. **No mention of documents, artifacts, code execution, or markdown
  formatting conventions today** — confirmed no existing notion of "artifacts" in the prompt.
- **Where it's invoked from a route**: `apps/api/src/slices/chat/routes.ts:295`:
  `systemPrompt: buildTurnSystemPrompt({ now: new Date(), ...runScopedInstructions(body) })` — and
  repeated at `routes.ts:1096,1186,1294,1382` for the various turn-start branches (regular turn,
  Smart Model, trial, etc.). `runScopedInstructions` (routes.ts:274-279) narrows the request body's
  optional `customInstructions` into the exact-optional shape the builder expects.
- **`customInstructions` flow**: client-supplied plaintext per request (server never decrypts the
  stored blob — E2E-encrypted at rest, per the file-header comment in system-prompt.ts:10-12),
  validated `z.string().max(5000).optional()` in the chat route's Zod schemas
  (`routes.ts:136,193,243`).
- **How you'd add "you can emit runnable code blocks / artifacts" instructions**: this is a
  `BASE_SYSTEM_PREAMBLE` edit (static, cheapest, always-on) or a new conditionally-included section
  in `buildTurnSystemPrompt` (parallel to the custom-instructions section) if it should be
  toggleable per conversation/workflow rather than global. Because `buildTurnSystemPrompt` is the
  literal single source both the client price-preview and the server request use
  (system-prompt.ts:1-6 docstring), **any prompt text change here changes billed price** and must
  stay in this one function — do not duplicate the addition elsewhere.
- Turn assembly beyond the system prompt (message history, model selection) lives in
  `apps/api/src/slices/chat/domain/turn-definition.ts` (not read in depth this pass — flagged as a
  gap below).

## 6. Package management & lint constraints

- **Adding a dependency**: no automated script found beyond plain `pnpm add` in the relevant
  package (`apps/web/package.json` deps are flat semver-caret entries, e.g.
  `apps/web/package.json:36-38,53` for the streamdown family). Per `docs/AGENT-RULES.md`, adding an
  npm package is a "Must Ask Approval" item for an implementation agent — not something to do
  silently. `packages/config/eslint.config.js` and `arch/` (ts-morph) gates would need to pass for
  any new package's usage; `pnpm lint:unused` (knip) will flag an added-but-unused dependency.
- **Lint rules that would constrain an iframe/embedded-preview feature**
  (`packages/config/eslint.config.js`):
  - `no-restricted-syntax` bans raw `<img>` (`packages/config/eslint.config.js:453,503`) and
    inline `color`/`font` styles (`:447-451,497-501`) — **no existing rule bans `<iframe>`**, so a
    raw `<iframe>` is currently unrestricted by lint (confirmed by its existing use in
    `dev.emails.tsx` and `social-banner.tsx`).
  - JS animation libs (`gsap`, `anime`, `motion-one`) are banned via `no-restricted-imports`
    (per `docs/CODE-RULES.md`, "Accessibility-friendly Conventions" section) — relevant only if a
    live-preview feature would want to animate UI chrome around the sandbox, not the sandboxed
    content itself (content inside a sandboxed iframe is a separate document, outside this repo's
    lint reach).
  - Raw `requestAnimationFrame` is banned outside `useAnimationFrame`
    (`packages/config/eslint.config.js:506-` region) — same scope caveat.
  - `jsx-a11y` plugin is active (`packages/config/eslint.config.js:6,403`) — an `<iframe>` needs a
    `title` attribute for a11y; both existing iframes (`dev.emails.tsx:78`,
    `social-banner.tsx:148`) already set one, establishing the convention.
  - Boundaries: `eslint-plugin-boundaries` (per `docs/TECH-STACK.md`) enforces the
    slice/package import graph — a new sandboxed-preview component would live under
    `apps/web/src/components/` and should not import backend/slice code; nothing sandbox-specific
    is configured against it since the feature doesn't exist yet.
- **Already-planned tech**: `docs/TECH-STACK.md` explicitly earmarks **Sandpack** for exactly this
  feature, twice:
  - Frontend table: `**Sandpack** _(planned)_ | Browser code execution. Renders HTML/React/CSS in
    iframe sandbox for artifact previews.`
  - Code Execution table: `**Sandpack** _(planned)_ | Client-side sandbox. Browser iframe for
    HTML/React/CSS preview. No server needed.`
  This means the intended mechanism (per architecture-of-record) is **client-side only**, Sandpack
  (a CodeSandbox-authored browser bundler/iframe-sandbox library), not a server-side execution
  tier — consistent with `docs/ARCHITECTURE.md`'s "Cloudflare Containers / Sandbox SDK (deferred) —
  Server-side heavy compute... when a feature forces it," implying this feature should NOT force
  that adoption; it should stay client-side.

## Gaps / not fully swept at this pass

- `apps/api/src/slices/chat/domain/turn-definition.ts` — read only via grep hits, not opened in
  depth; likely where message-history assembly composes with `systemPrompt` before the provider
  call. Worth reading before implementation to confirm there's no second prompt-assembly path.
- `apps/web/index.html` was not directly inspected for a CSP `<meta>` tag; the Capacitor
  WebView's effective CSP enforcement (native app has no HTTP response headers) is inferred, not
  verified — flagged above as a follow-up.
- Did not exhaustively check `apps/marketing` (Astro) — out of scope for a chat-panel feature, but
  the `/demo` iframe embedding pattern lives partly there (embeds the web SPA, not vice versa).
- Streamdown's own package internals (what exactly `@streamdown/mermaid`'s plugin does vs.
  `mermaid-diagram.tsx`'s hand-rolled component) were inferred from usage sites, not read from
  `node_modules` source.
