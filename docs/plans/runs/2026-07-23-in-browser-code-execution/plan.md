# Plan — In-browser code execution & rendering (document panel)

Run: `docs/plans/runs/2026-07-23-in-browser-code-execution/` · Tier 2 · Status: DRAFT (awaiting approval)

## Feature in one paragraph

AI-generated code becomes live, runnable artifacts in the document panel. One in-house
renderer (the Claude/Gemini pattern — no packaged alternative exists; see
`research/oss-artifact-renderers.md`): a dedicated static **sandbox origin** hosts a
sandboxed iframe; the app postMessages code in; HTML/JS/React render via import maps →
esm.sh with in-browser JSX transpile; Python runs in a Pyodide worker spawned inside the
same sandbox iframe. No service workers anywhere — the property that makes one codepath
work on web, iOS, and Android WebViews. The panel reuses the mermaid Rendered/Raw toggle
pattern, defaulting to Rendered. The shared system-prompt builder tells the model what to
emit.

## Founder rulings (binding; do not re-litigate)

- R1 Engine self-hosting posture: all execution assets self-hosted/pinned on our origin(s).
- R2 Scope: web stack + full Python (Pyodide) in this run.
- R3 Arbitrary npm imports allowed (via esm.sh ES modules).
- R4 Must work on mobile (Capacitor Android + iOS) — one codepath.
- R5 A Maestro flow proves mobile rendering (Android; extends existing `mobile-tests/`).
- R6 **No dual implementation.** Single renderer codepath everywhere. (Killed Sandpack —
  its bundler hard-requires service workers; WKWebView has none. `research/sandpack-capacitor-compat.md`.)
- R7 In-house renderer of the sandbox-origin + import-map + in-browser-transpile pattern.
- R8 Artifact network access BLOCKED: sandbox CSP allows module loading (esm.sh, own
  origin, Pyodide/PyPI wheel hosts) and nothing else. No fetch/XHR/WS from artifact code.
- R9 Security containment tests are a deliverable, not an afterthought.
- R10 UX: html/react auto-render on panel open; python requires explicit Run; Stop kills
  the worker.
- R11 No iOS-specific testing (no iOS CI, no iOS Maestro, no iOS spike automation).
- R12 v1 = single-file artifacts; languages `html`, `js`, `jsx/react`, `python`; Vue
  dropped; multi-file is a designed-for extension, not built.

## Global constraints

- **G1 — One codepath.** No platform-conditional renderer logic. Anything that would fork
  web vs mobile behavior is a plan violation, not an implementation choice.
- **G2 — Untrusted code only ever executes inside the sandbox-origin iframe** (or workers
  it spawns). Nothing evaluates artifact code in the app origin: no `eval`, no
  `new Function`, no react-runner-style interpretation, no same-origin `srcdoc` with
  scripts enabled.
- **G3 — Sandbox iframe attributes:** `sandbox="allow-scripts"` exactly; never
  `allow-same-origin`, `allow-popups`, `allow-top-navigation`, or `allow-modals`.
- **G4 — Sandbox origin is credential-free:** static assets only; no cookies set; no
  authenticated endpoint exists there. The origin is configured via env registry entries
  (per-mode values, no fallbacks — CODE-RULES §Environment Detection).
- **G5 — Bridge protocol is typed once** in `packages/shared` (Zod schemas for every
  parent↔iframe message) and imported by both sides. No re-typed message shapes.
- **G6 — System-prompt changes go only through `buildTurnSystemPrompt`**
  (`packages/shared/src/prompt/`) — client/server price-parity depends on it.
- **G7 — TDD + 95% per-file coverage** on all new code (repo gate). Spike (T0) is the
  sole exemption: exploratory, throwaway-eligible, replaced by TDD'd real components.
- **G8 — Accessibility:** rendered/raw toggle keyboard-reachable; console output in an
  `aria-live` region; iframe carries `title`; loading/error states are announced text,
  not spinners alone. UI tasks read `docs/DESIGN.md` before building.
- **G9 — Durable naming:** final paths/names from day one; no spike/task residue in
  shipped code.
- **G10 — Pinned versions:** Pyodide 314.x pinned; transpiler pinned; esm.sh URLs pin
  package versions at import-map build time where the artifact names one, else latest-at-render (document the choice in the seam).
- **G11 — Streamdown/Vite:** any new lazy-loaded chunk joins the inline-lazy-imports
  transform (`vite.config.ts:82-92`) — see `research/codebase-integration.md` §3.

## Interfaces (authoritative)

- **Terminology: these are "documents"** (repo vocabulary: `Document`, document panel).
  `RunnableDocumentKind = 'html' | 'js' | 'react' | 'python'` — extends the existing
  `Document` type union (`apps/web/src/lib/document-parser.ts`); mermaid unchanged. No
  "artifact" naming anywhere in shipped code.
- `document-render-status`: a stable app-DOM status element (HTML `id`) in the panel
  that reflects the bridge lifecycle (`loading` → `rendered`/`error`). Serves a11y
  (status text), Playwright, and Maestro (programmatic on-device proof — no screenshots).
- Bridge messages (Zod, `packages/shared/src/documents/bridge.ts`, exact shapes owned by
  T2 and consumed everywhere):
  - parent→frame: `init {kind, code, requestId}`, `run {requestId}` (python),
    `stop {requestId}`.
  - frame→parent: `ready`, `rendered {requestId}`, `console {requestId, stream: 'stdout'|'stderr', text}`,
    `result {requestId, outputs: Array<{type: 'image/png'|'text', data}>}`,
    `error {requestId, code, message}`, `loading {requestId, phase}`.
- Sandbox origin env entries: `SANDBOX_ORIGIN_URL` (per-mode), dev port `HB_SANDBOX_PORT`.
- Renderer pages: `/render.html` (web renderer), `/python.html` (Pyodide host) on the
  sandbox origin. Pyodide assets under `/pyodide/`. (No "artifact" naming — R14/A5.)

## Dependency graph

```
T0 (spike: proves stack on Android emulator + desktop)  ← gates everything
T1 (sandbox origin app + env + local dev)               ← after T0
T2 (bridge contract + web renderer page)                ← after T1
T3 (Pyodide runtime page + worker)                      ← after T1 (parallel with T2)
T4 (web app: dispatch seam, panel UI, toggle, console)  ← after T2 & T3 (contract from T2)
T5 (system prompt)                                      ← after T2 (needs final capability facts; parallel with T4)
T6 (CSP/headers both origins)                           ← after T1 (parallel; owns generate-headers)
T7 (security containment tests)                         ← after T4 & T6
T8 (Playwright E2E)                                     ← after T4
T9 (Maestro Android flow)                               ← after T4
```

## Tasks

### T0 — Vertical-slice spike (gate)

- **Objective:** prove the architecture end-to-end on desktop browsers and the Android
  emulator before any real task runs.
- **Design context:** the founder's directive — establish compatibility definitively
  before building; research verdicts were "must-spike" (`research/pyodide-capacitor-compat.md`,
  `research/sandpack-capacitor-compat.md` §Android). iOS is excluded by R11.
- **Deliverable:** a minimal static page pair (thrown-away or evolved, implementer's
  call, G9 applies if kept): (a) sandboxed iframe rendering a React component imported
  from esm.sh via import map, JSX transpiled in-browser; (b) Pyodide worker spawned from
  the https iframe running `numpy` hello + matplotlib PNG round-trip. Served locally;
  loaded inside the dev Capacitor Android build via the existing `mobile-tests` harness.
- **Acceptance criteria:** screenshots/logs in `task-00/` proving all of: React render on
  desktop Chromium + Android WebView; Pyodide numpy result + PNG on both; worker spawn
  from iframe works on Android; approximate Pyodide load time + memory noted. A FAILURE
  on any point halts the run and goes to the founder.
- **Files:** scratch/spike only (`task-00/` artifacts); no production paths.
- **Checks:** none (exploratory; G7 exemption).

### T1 — Sandbox origin app

- **Objective:** stand up `apps/sandbox` (assets-only Cloudflare Worker, `apps/admin`
  pattern) serving the renderer pages + pinned Pyodide assets, wired into pnpm/turbo,
  env registry (`SANDBOX_ORIGIN_URL` per mode, `HB_SANDBOX_PORT`), local dev stack, and
  deploy config. **Includes the T0 unproven-by-test item (A7):** prove an https
  cross-origin sandbox iframe loads and runs inside the real `capacitor://localhost`
  app shell (frame-src CSP + cross-scheme) — an integration check here, not left to T9.
  Assets served with `application/wasm` MIME + permissive CORS (Pyodide fetches from the
  opaque frame need it). T0's `fetch-pyodide.sh` in `task-00/spike/` is the asset
  provenance reference.
- **Design context:** dedicated origin = the security boundary (G2/G4); assets-only
  Worker keeps it serverless/zero-idle-cost. Pyodide self-hosted per R1 (largest asset
  9.6 MB < Pages 25 MiB limit — `research/pyodide-renderer-design.md`).
- **Acceptance criteria:** `pnpm dev` serves the origin on its computed port; pages load;
  Pyodide assets served with correct MIME (`application/wasm`); production wrangler
  config present; env verified by `pnpm verify:env` in all modes; unit tests for any
  logic; repo gates pass.
- **Files:** `apps/sandbox/**`, `pnpm-workspace.yaml`, `turbo.json`, env registry +
  `scripts/` env/dev-stack wiring (not `generate-headers.ts` — T6 owns it).
- **Checks:** new-package equivalents: `turbo typecheck lint --filter=@hushbox/sandbox`,
  its vitest suite, `pnpm verify:env`.

### T2 — Bridge contract + web renderer

- **Objective:** the typed bridge (`packages/shared/src/documents/bridge.ts`) and
  `/render.html`: receive `init`, assemble import map (esm.sh, versioned per G10),
  transpile JSX with **Sucrase** (pinned), render html/js/react, report
  `rendered`/`console`/`error`.
- **Design context:** the Claude/Gemini pattern (`research/claude-artifacts-mechanism.md`,
  `research/gemini-grok-mechanisms.md`); parent origin never trusted or echoed; no
  network beyond module loads (R8 — enforcement itself lives in T6's CSP, but renderer
  code must not depend on network). **T0 hard requirements (A7):** (1) the renderer
  bootstrap MUST be a **classic script**, and the import map MUST be injected before the
  first dynamic `import()` — Android WebView 113 ignores an import map added after any
  inline `type="module"` runs (Chromium 150 masked this; real Android breaks). (2)
  **Sucrase over Babel-standalone** — T0 measured 40 KB gz / ~4 ms vs 637 KB / ~16 ms,
  both correct; Babel is the fallback only if a JSX/TS syntax gap surfaces. React
  documents mount the module's **default export**.
- **Acceptance criteria:** unit tests (schema round-trips, import-map assembly incl.
  versioned/scoped packages, transpile error surfacing); integration test driving the
  real page in a browser context rendering: plain HTML; JS with DOM; React component
  importing an npm package; a syntax-error artifact → typed `error`. 95% coverage.
- **Files:** `packages/shared/src/documents/**`, `apps/sandbox/src/render/**`.
- **Checks:** `pnpm test:shared`, sandbox suite, `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/sandbox`.

### T3 — Pyodide runtime

- **Objective:** `/python.html`: lazy-load pinned Pyodide **on the iframe main thread**
  (NOT a worker — see Design context / A7), `loadPackagesFromImports` + micropip
  fallback, stdout/stderr streaming, matplotlib Agg→PNG via `result`, tracebacks as
  `error`, `stop` = **parent tears down / reloads the sandbox iframe** (the parent owns
  the element and can kill even a main-thread-spinning frame), fresh globals per run,
  `input()` fails fast with a clear error.
- **Design context (AMENDED A7 by T0 spike — supersedes `research/pyodide-renderer-design.md`
  design 1c):** Pyodide runs main-thread inside the sandbox iframe, not in a worker. A
  module worker (Pyodide 314 mandates one; it rejects classic workers) cannot be spawned
  from a `blob:null` URL in an opaque-origin (`allow-scripts`-only, G3) iframe — proven
  in T0's probe. Keeping the strong sandbox (no `allow-same-origin`, invariant 2) forces
  main-thread. Security is unchanged (origin isolation is the wall, not the worker); G1
  intact (one codepath both surfaces). **UX consequence to handle:** during a long
  synchronous run the main thread is blocked, so console output cannot stream live and
  Stop-via-teardown is the responsiveness escape — chunk execution / pump between
  statements where feasible, and treat teardown (not `terminate`) as the one stop
  mechanism (no SAB interrupt; COOP/COEP rejected). Assets self-hosted, served with
  `application/wasm` MIME + permissive CORS (T1/T6); the `.wasm`/wheel fetches from the
  opaque frame use CORS (works — T0 confirmed; `importScripts` of cross-origin from a
  null-origin worker does NOT, but that path is gone).
- **Acceptance criteria:** integration tests in a real browser context: print round-trip;
  numpy compute; matplotlib PNG output; micropip install of a pure-Python package;
  traceback surfacing; **stop mid-infinite-loop: parent teardown kills the frame and no
  further `console`/`result` messages arrive**; second run (fresh frame) has fresh
  globals. Loading phases emitted (`loading {phase}`). 95% coverage on orchestration code.
- **Files:** `apps/sandbox/src/python/**`, `apps/sandbox/public/pyodide/**` (assets).
- **Checks:** sandbox suite, `turbo typecheck lint --filter=@hushbox/sandbox`.

### T4 — App integration (panel UX)

- **Objective:** make runnable documents live in the web app: extend the parser/type
  union (consume `RunnableDocumentKind` from `@hushbox/shared/documents` — no "artifact"
  naming, R14/A5), dispatch seam (mermaid → MermaidDiagram; html/js/react/python →
  sandbox iframe embed), generalize the Rendered/Raw toggle
  (`document-panel.tsx:283`) with Rendered default, auto-render html/js/react on open
  (R10), python Run/Stop buttons + console strip (`aria-live`) + PNG output via `<Img>`,
  loading and error cards, teardown on document switch/panel close.
- **Design context:** mirror the mermaid UX exactly (founder's directive);
  `research/codebase-integration.md` maps every seam; G8 accessibility; read
  `docs/DESIGN.md` first.
- **Acceptance criteria:** unit/component tests: dispatch per kind; toggle default +
  reset on document change; run/stop lifecycle; console rendering; error card on bridge
  `error`; iframe carries `title` + G3 sandbox attrs (attribute-pinning test:
  `allow-scripts` exactly, NO `allow-same-origin`/`allow-popups`/`allow-top-navigation`/
  `allow-modals`); the `document-render-status` element flips only on bridge `rendered`
  (A4); **stop tears down the iframe and no further `console`/`result` messages arrive
  from a killed run** (the assertion T3's top-level harness could not make — needs a real
  iframe here); python drive is `init`(stash)→`run`(execute), terminal success is
  `result{outputs}` (not `rendered`), `input_unsupported` maps to a friendly message.
  Mobile app-origin CSP (A8) delivered + child self-navigation to an off-allowlist host
  VERIFIED blocked on the WebView. 95% coverage. `pnpm test:web` green.
- **Files:** `apps/web/src/components/document-panel/**`,
  `apps/web/src/lib/document-parser.ts`, `apps/web/src/components/markdown-renderer/**`
  (card affordance only if needed), `apps/web/src/stores/document.ts`.
- **Checks:** `pnpm test:web`, `turbo typecheck lint --filter=@hushbox/web`.

### T5 — System prompt

- **Objective:** extend `buildTurnSystemPrompt` (G6): artifact capability description —
  when to emit (substantial/self-contained/visual/interactive), how (fenced block with
  `html`/`jsx`/`python` language tag, single-file), constraints (no runtime network,
  npm imports allowed for react/js via bare specifiers, python imports auto-install,
  matplotlib renders, no `input()`), bias toward runnable artifacts for visual asks.
- **Design context:** single shared builder = price-parity guarantee
  (`research/codebase-integration.md` §5). Copy tone per `docs/PRODUCT.md` conventions
  for model-facing text (match existing preamble style).
- **Acceptance criteria:** unit tests pin presence + key constraint phrases; existing
  prompt tests (all call sites) stay green; token-count delta noted in report. 95%.
- **Files:** `packages/shared/src/prompt/**`.
- **Checks:** `pnpm test:shared`, `pnpm test:api` (prompt consumers),
  `turbo typecheck lint --filter=@hushbox/shared`.

### T6 — Headers & CSP (both origins)

- **Objective:** app origin: add `frame-src <sandbox-origin>` to the generated `_headers`
  (`scripts/generate-headers.ts`) — per-mode value from env registry. Sandbox origin:
  serve its own CSP allowing `script-src`/module loads from self + esm.sh, worker-src
  self, connect-src ONLY the Pyodide/PyPI wheel hosts needed by micropip (R8: no other
  network), `frame-ancestors` limited to our app origins; correct wasm/worker MIME.
- **Design context:** R8 is enforced here — this CSP *is* the security posture; T7 pins
  it. `research/sandpack-selfhost.md` §CSP for current header state.
- **Acceptance criteria:** unit tests on generated header output per mode (app + sandbox);
  headers verified in dev stack (integration assertion); no directive loosening existing
  policy. 95% on changed script code.
- **Files:** `scripts/generate-headers.ts` + its tests, `apps/sandbox/` header config
  (coordinate: T1 creates the file, T6 owns header values — T6 runs after T1).
- **Micro-item (from T1 audit):** `apps/sandbox/wrangler.toml:4` comment ends with a
  dangling doc pointer to a nonexistent "ARCHITECTURE §sandbox" section — drop the
  parenthetical (state the security-boundary fact without a doc-section reference; do not
  add a path that may move).
- **Checks:** script tests, `pnpm verify:env`, sandbox suite.

### T7 — Security containment tests (Sensitive)

- **Objective:** an automated suite proving the containment properties (R9), pinning G2/G3/R8:
  artifact code cannot (a) reach the app origin DOM/storage/IndexedDB, (b) fetch/XHR/WS
  to any non-allowlisted host (incl. exfil-via-URL to esm.sh being limited to module
  loads — document what is/isn't closed), (c) open popups / navigate top / show modals,
  (d) keep running after Stop/teardown (python worker truly dead), (e) sandbox iframe
  attrs and both CSPs match the exact approved strings (regression pins).
- **Design context:** these tests are the wall's alarm system; a future edit weakening
  the CSP or sandbox attrs must fail loudly. Sensitive-flagged → 3-lens audit panel.
- **Acceptance criteria:** Playwright spec(s) exercising a real malicious-artifact corpus
  (fetch attempt, top-nav attempt, popup attempt, parent-probe, post-stop beacon) all
  blocked; unit pins on header/attr strings; suite green at retries=0.
- **Files:** `e2e/**` (new spec + fixtures), small test-only helpers.
- **Checks:** the new spec via `pnpm e2e:<suite>`, `turbo typecheck lint` on e2e.

### T8 — Playwright E2E (product flow)

- **Objective:** extend the chat E2E: assistant message with an HTML artifact → card →
  panel renders (assert inside iframe); React artifact renders; python artifact Run →
  console output + PNG; Rendered/Raw toggle; raw shows highlighted source.
- **Design context:** CODE-RULES "When to Write an E2E Test" — new user-facing
  cross-client/server flow. Model output arrives via existing mock/cassette patterns
  (see `e2e/CLAUDE.md` before writing). Prefer extending existing suites.
- **Acceptance criteria:** specs green at retries=0 across the suite's browsers; no
  settled-waits (E2E doctrine); runtime within suite budget.
- **Files:** `e2e/**` (chat/document suites).
- **Checks:** relevant `pnpm e2e:<suite>`.

### T9 — Maestro Android flow (R5)

- **Objective:** one new flow in `mobile-tests/flows/`: login persona → open/seed a
  conversation containing an HTML document → open panel → programmatic proof on-device
  (`androidWebViewHierarchy: devtools`): `extendedWaitUntil` on the
  `document-render-status` element's rendered state (stable literal `id`, app-origin DOM
  — visible to the devtools hierarchy; set only when the sandbox iframe posts
  `rendered`, so it proves actual execution, not just panel-open). NO screenshots (R13).
- **Design context:** suite conventions in `research/maestro-capacitor.md` §Existing
  Maestro suite (inputText cost, assert-on-buttons, sharding weights in `config.ts`).
- **Acceptance criteria:** flow passes locally via `pnpm mobile:test` (sharded run) and
  is registered/weighted; no flakiness across 3 consecutive runs.
- **Files:** `mobile-tests/flows/**`, `mobile-tests/config.ts`.
- **Checks:** `pnpm mobile:test` (scoped to the flow where the harness allows).

### T10 — E2E/CI test infrastructure for the sandbox origin (prereq for T7 + T8)

- **Objective:** the shared harness both E2E suites need, so neither depends on live
  network and both exercise the REAL policy. Emerged from T2/T3 carry-forwards; consolidated
  here instead of duplicated across T7/T8.
- **Scope:**
  1. **Sandbox served with its real CSP** in dev/CI (T1's Node dev-server sends none) —
     via wrangler-serve or a CSP-injecting middleware — so E2E exercises the deployed
     policy, not a permissive one.
  2. **Single-source the sandbox CSP** (T3-audit Minor): one exported constant is the
     authoritative sandbox policy; the served `_headers`/middleware AND T3's browser test
     harness both reference it — no hardcoded copies. Preserve the exact current policy
     (default-src **'self'** — the real T6-shipped value, NOT 'none'; the earlier 'none'
     in this plan's text was imprecise. script-src self+wasm-unsafe-eval+blob:+esm.sh,
     connect-src self+pypi+pythonhosted, webrtc 'block',
     frame-ancestors web+capacitor+http-localhost, the X-DNS-Prefetch-Control header).
  3. **esm-stub** (T2 carry-forward): dev-server serves `/esm-stub` module content with a
     JS MIME and routes esm.sh's `/pkg@ver` + `/pkg@ver/subpath` scheme, for a fixture
     package set (at least react, react-dom, canvas-confetti) the E2E imports — no live
     esm.sh in CI (ESM_CDN_URL test mode already points here per A2).
  4. **micropip determinism** (T3 carry-forward): the micropip path must not hit live PyPI
     in CI — either a local wheel stub served + connect-src-allowed in the TEST CSP only,
     or restructure the demo to a package already in the self-hosted Pyodide dist. Pick the
     simpler; document which.
  5. **Pyodide asset fetch in CI**: wire `fetch-pyodide` into the turbo/CI graph so the
     sandbox suite + E2E have `public/pyodide/**` before running.
- **Acceptance criteria:** the sandbox origin serves under its real CSP locally; a test
  proves the served CSP === the single constant; esm-stub serves the fixture set as
  modules; micropip demo runs with zero live-network; `fetch-pyodide` runs in the CI graph
  before dependent suites; existing sandbox + web suites stay green. 95% on any new logic.
- **Files:** `apps/sandbox/**` (dev-server, the CSP constant, `_headers` refactor to
  reference it, fixtures), `turbo.json` / `.github/workflows/ci.yml` (fetch wiring). Coordinate:
  touches the sandbox CSP T6 authored — preserve policy byte-for-byte, only refactor to a
  shared constant.
- **Depends on:** T2 + T3 (done). Independent of T4. **Blocks:** T7, T8.

## Related E2E (declared per skill Phase 4)

- Existing: chat/document-panel Playwright suites (whichever specs T4 touches — named at
  dispatch), full `pnpm mobile:test` Android suite.
- New: T7 security spec, T8 artifact-flow spec, T9 Maestro flow.

## Doc changes (close-phase proposals, founder-approved individually)

- `docs/TECH-STACK.md`: replace both Sandpack "(planned)" entries with the in-house
  sandbox-renderer + Pyodide reality; add `pyodide` + transpiler rows.
- `docs/ARCHITECTURE.md`: sandbox origin in the system map; artifact rendering paragraph.
- `docs/DEVELOPMENT.md`: sandbox origin in the local-stack list.
- New-dep approvals consumed: `pyodide`, one JSX transpiler (Babel-standalone or
  Sucrase), `apps/sandbox` workspace. (Founder pre-approval requested in digest.)

## Accepted risks (founder-acknowledged)

- esm.sh is a runtime third-party dependency for npm-importing artifacts (self-hostable
  later; Google precedent `aistudiocdn.com`). PyPI/CDN hosts likewise for micropip.
- iOS ships unverified-by-test (R11); research-based confidence: renderer high, Pyodide
  memory medium (`research/pyodide-capacitor-compat.md`). First signal = field usage.
- Multi-file projects + bundler console (Sandpack capabilities) are not in v1 (R6/R12).
- Sandbox origin domain: SUBDOMAIN APPROVED by founder (2026-07-24). Mitigation:
  host-only session cookies verified in T7 (test asserts no credentialed request reaches
  the sandbox origin).

## Amendments

- A1 (2026-07-24): Sandbox subdomain approved. Deploy via wrangler custom-domain config
  on `apps/sandbox` (admin.hushbox.ai assets-worker precedent) — no manual Cloudflare
  steps expected (Inferred from admin precedent; verify token/zone scope at first deploy,
  escalate to founder if the CI token lacks the route permission).
- A2 (2026-07-24): **Module-CDN endpoint is env-driven** (`ESM_CDN_URL` per mode):
  production/dev-default = `https://esm.sh`; CI E2E + local test mode = a local static
  stub served by the sandbox dev server carrying a tiny pinned package set (the fixture
  packages T2/T7/T8 use). Rationale: deterministic tests, no live-network flake in CI,
  local-dev parity; mirrors the cassette doctrine (mock at the true external seam).
  Owned: stub assets in T1's dev server, consumed by T2's import-map assembly (base URL
  from env, never hard-coded).
- A3 (2026-07-24, superseded by A5): new on-demand doc — see A5 for final name/timing.
- A4 (2026-07-24): R13 — Maestro proof is PROGRAMMATIC, no screenshots: T4 ships the
  `document-render-status` app-DOM element (stable HTML `id`, driven by bridge
  lifecycle); T9 asserts on it via the devtools hierarchy. T4 acceptance criteria
  include this element + a test pinning it flips only on bridge `rendered`.
- A5 (2026-07-24): Repo terminology is **documents**, not artifacts (founder-confirmed;
  matches `Document`/document panel). Doc = `docs/DOCUMENTS.md`, written NOW
  (founder-directed, ahead of implementation as spec-of-record) + indexed in
  `docs/DEVELOPMENT.md`; reconciled against reality at close. Shared code lives under
  `packages/shared/src/documents/`.
- A9 (2026-07-24, from T2 security audit — applies to T2 fix AND T3): code bundled to the
  **public sandbox origin must import from narrow module paths, never the top-level
  `@hushbox/shared` barrel** — the barrel `export *`s the backend env-config registry, and
  esbuild does not tree-shake it, so the served bundle would embed every production var
  name plus dev-mode secret-shaped values (a credential-free origin must stay
  credential-free). Import the bridge from a narrow `@hushbox/shared/documents` subpath (add
  the export to packages/shared) or the bridge module directly. Pin with a **bundle-content
  assertion** beside the drift test: the built `render.js`/`python.html` bundle must contain
  no backend env-var names / `to:["backend"]` markers. T3's Pyodide bundle carries the same
  requirement.
- A12 (2026-07-24, from the WebRTC-fix mandated re-verification — BLOCKER + root-cause test gap):
  the renderer does NOT run under the real sandbox `script-src` — a `html` document's inline
  `<script>` and the React path's inline `<script type="importmap">` are blocked without
  `'unsafe-inline'`. Verified identical under the old `default-src 'self'`, so pre-existing,
  not a regression; hidden because the render browser test never served a CSP (T3's python
  test did — this is the asymmetry). **Fix:** add `'unsafe-inline'` to the sandbox
  `script-src`. SAFE and forced: the `html` kind IS inline scripts (a static CSP cannot nonce
  arbitrary user inline scripts); containment is origin isolation + network lockdown
  (connect-src, frame/worker/object `'none'`, WebRTC neutralization), NOT script-src — the
  sandbox exists to run the document's scripts, so inline execution grants no new capability
  and exfil stays blocked. This is the Claude/Gemini artifact-sandbox posture. **Root-cause
  fix:** the render browser test MUST serve the real CSP (via T10's harness) and prove
  html-with-inline-script + js + react-with-importmap render under it — so a renderer-under-CSP
  break can never slip again. `'unsafe-inline'` composes with the WebRTC neutralization
  (globals are deleted regardless of how a script runs). Founder informed; forced+safe →
  proceed, veto available.
- A11 (2026-07-24, from T7 RUNTIME probe — CRITICAL, supersedes the T6 `webrtc 'block'`
  approach): `webrtc 'block'` is NOT enforced by Chromium (draft directive, no real
  support) — T7 observed a real srflx ICE candidate reaching stun.l.google.com over UDP.
  WebRTC exfil is OPEN; config alone cannot close it. **Robust fix (two layers):**
  (1) the sandbox bootstrap (render.html + python.html) deletes/neutralizes
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `mozRTCPeerConnection`, `RTCDataChannel`
  from the frame global BEFORE any untrusted code runs (classic-script bootstrap already
  runs first); (2) the sandbox CSP tightens `default-src 'self'` → **`'none'`** and sets
  `frame-src 'none'`/`child-src 'none'`/`worker-src 'none'`/`object-src 'none'` so untrusted
  code cannot spawn a child frame/worker/object to obtain a fresh realm and recover the
  deleted globals. Keep `webrtc 'block'` too (harmless, helps any engine that later honors
  it). Re-verify Pyodide (main-thread, no worker) + renderer (no frames/workers) still run
  under `default-src 'none'`. This RESOLVES the earlier default-src question: 'none' is now
  REQUIRED, not optional. iOS WKWebView (no `webrtc 'block'` support anyway) is covered by
  the JS-neutralization layer, not the CSP.
  Also (T7 finding 2): `frame-ancestors http://localhost` (portless = port 80 only) blocks
  the ported dev/e2e app origin from embedding the sandbox → change to `http://localhost:*`
  (matches Android port 80, web-dev computed ports; negligible added surface — localhost
  only, credential-free sandbox).
- A7 (2026-07-24, from T0 spike — three findings, folded into T1/T2/T3 task bodies):
  (1) **Pyodide runs main-thread in the sandbox iframe, not a worker** — a module worker
  (Pyodide 314 mandates one) cannot spawn from a `blob:null` URL in the opaque
  `allow-scripts` sandbox; keeping the strong sandbox (no `allow-same-origin`) forces
  main-thread; Stop = parent tears down the iframe. Supersedes
  `research/pyodide-renderer-design.md` design 1c. Security unchanged (origin isolation is
  the wall); G1 intact. (2) **Renderer bootstrap MUST be a classic script and the import
  map injected before the first dynamic `import()`** — older Android WebView ignores a
  late import map (desktop Chromium masks it). (3) **Transpiler = Sucrase** (40 KB/~4 ms vs
  Babel 637 KB/~16 ms; Babel is the fallback). React documents mount the module's default
  export. The `capacitor://localhost` shell embedding was proven only via Chrome
  113==WebView 113 (T0 couldn't build the real APK under bounds) → T1 integration + T9.
- A8 (2026-07-24, from T6 adversarial audit — three validated exfil findings): the R8
  no-network posture had gaps beyond fetch/XHR/WS. Fixes distributed by ownership:
  - **T6 (fix now):** add `webrtc 'block'` to the sandbox CSP (connect-src does NOT cover
    WebRTC — RTCPeerConnection to an attacker STUN/TURN is unbounded exfil), and add
    `X-DNS-Prefetch-Control: off` to the sandbox `_headers` (closes dns-prefetch hostname
    leak). Pin both with tests.
  - **T4 (new criterion):** the APP origin must ship its CSP `frame-src 'self'
    <sandbox-origin>` on MOBILE too. `_headers`/Cloudflare does not serve the bundled
    Capacitor assets, so on Android/iOS there is currently no parent `frame-src` — which
    means a sandboxed document can self-navigate its own frame to an arbitrary host and
    exfiltrate in the URL (contained on web by the parent frame-src, uncontained on
    mobile). Deliver it via a `<meta http-equiv="Content-Security-Policy">` in
    apps/web/index.html (meta CSP honors frame-src) OR an equivalent that reaches the
    Capacitor bundle; T4 must VERIFY on the WebView that child self-navigation to an
    off-allowlist host is actually blocked. Same per-mode sandbox origin value (no
    hard-coded domain). This is required for R8 to hold on mobile (R4).
  - **T7 (corpus expansion):** the malicious-document corpus MUST include, beyond
    fetch/top-nav/popup/parent-probe/post-stop-beacon: (a) WebRTC `RTCPeerConnection`
    exfil attempt (probe it actually blocked under the real CSP — converts the WebRTC
    finding from PLAUSIBLE to CONFIRMED-closed), (b) dns-prefetch attempt, (c) child
    self-navigation to an off-allowlist host — and (c) must be exercised under the
    MOBILE app-origin CSP config, not only web. T7 also must serve the sandbox with its
    real CSP applied (via wrangler or CSP injection) — the T1 Node dev-server sends no
    CSP, so tests against it would pass without exercising the policy. **Single-source the
    sandbox CSP:** T7's served CSP and T3's test-harness copy must both reference ONE
    shared CSP constant (the authoritative sandbox policy), never hardcoded copies — a
    drifting copy would validate against a stale policy (One Implementation Shared).
    Establish that constant here and repoint T3's harness.
- A10 (2026-07-24, from T3 security audit — optional, founder-call): the self-hosted
  Pyodide wheels are fetched from jsdelivr versioned (immutable) paths with exact version
  pins but NO per-file SRI/sha256 integrity. Requirement (exact pin, trustworthy source,
  no floating tag) is met; SRI is defense-in-depth hardening only. Recorded as an accepted
  residual unless the founder wants integrity pinning added.
- A6 (2026-07-24): Close-phase ordering — Phase 4 runs the unscoped gates (typecheck,
  lint, test suites, duplication, unused) and everything else, but **PAUSES for the
  founder before running the related E2E tests** (Playwright + Maestro). E2E authored
  and audited as tasks; execution of the suites at close awaits founder go.
