# Task T2 — Bridge contract + web renderer — impl report 1

## Objective

Deliver (1) the typed parent↔iframe bridge in `packages/shared` (Zod schemas for every
message, imported by both sides) and (2) the sandbox `/render.html` + `src/render` web
renderer: receive `init`, assemble a browser import map, transpile JSX/TSX with pinned
Sucrase, render html/js/react (react mounts the module default export), and report
ready/loading/rendered/console/error.

## Files changed

**Bridge contract (packages/shared) — fully in primary bounds**
- `packages/shared/src/documents/bridge.ts` — new. Zod schemas + inferred types for the
  whole protocol; closed enums for kinds/error-codes/loading-phases/console-streams;
  `parseParentToFrameMessage` / `parseFrameToParentMessage` safe-parse helpers.
- `packages/shared/src/documents/index.ts` — new barrel.
- `packages/shared/src/index.ts` — one line: `export * from './documents/index.js'`.

**Web renderer (apps/sandbox/src/render) — primary bounds**
- `specifier.ts` — `parseSpecifier` / `moduleUrlFor`: bare/scoped/versioned/subpath parsing
  and pinned-or-declared version resolution.
- `import-map.ts` — `scanBareImports` / `assembleImportMap`: build the browser import map
  from a module's bare imports plus renderer extras.
- `transpile.ts` — `transpileReact` (Sucrase, automatic JSX runtime) + `TranspileError`.
- `react-runtime.ts` — pinned `REACT_RUNTIME_VERSION = 19.1.0` + `REACT_PINS`.
- `bootstrap.ts` — the browser renderer entry (message listener, per-kind render, import-map
  injection, console forwarding, default-export mount). Bundled, never Node-imported.
- `build-bundle.ts` — esbuild IIFE bundler → `public/render.js`; `writeRenderBundle`.
- `public/render.js` — new. The committed, minified classic-script bundle the page serves.
- `public/render.html` — replaced the T1 stub: two classic scripts (`/config.js`, `/render.js`).

**Config edits inside apps/sandbox (T1-authored files — see Concerns/RAISED)**
- `package.json` — deps: `sucrase` pinned `3.35.1`, `esbuild` `0.25.12`, `@playwright/test`
  `1.60.0`; new `build:render` script.
- `vitest.config.ts` — added `src/render/bootstrap.ts` to coverage `exclude` (browser-only
  entry, exercised by the browser test; its logic lives in the covered helpers).
- `eslint.config.js` — ignore `public/render.js` (generated minified bundle).
- `pnpm-lock.yaml` (repo root) — the three added deps.

## Tests added

- `documents/bridge.test.ts` (shared) — 29 tests: every message round-trips; unknown
  kind/code/phase/stream rejected; empty requestId rejected; both discriminated unions
  reject the opposite direction and non-object payloads; helpers return failure (never
  throw) on garbage. → schema round-trips (valid + rejected).
- `specifier.test.ts` — 13: bare/scoped/versioned/subpath parse; pin-vs-declared version;
  trailing-slash CDN base. → import-map assembly (specifier rules).
- `import-map.test.ts` — 14: import scanning (default/named/namespace/side-effect/re-export/
  dynamic), relative/absolute/URL/blob exclusion, dedup; assembly with versioned+scoped
  packages, jsx-runtime pin, declared-version override, local stub base. → import-map assembly.
- `transpile.test.ts` — 4: JSX→runtime calls + auto jsx-runtime import; TS stripping;
  syntax-error → typed `TranspileError` with a message. → transpile error surfacing.
- `render.browser.test.ts` — 4, real headless Chromium against the committed page + bundle:
  plain HTML renders; JS with DOM + console forwarding; React component importing an npm
  fixture mounts its default export; syntax-error document → typed `error` code
  `transpile_failed`. → the integration criterion.
- `build-bundle.test.ts` — 3: bundle is a classic IIFE; committed `public/render.js` is in
  sync with source (drift guard); `writeRenderBundle` rewrites it.

## Self-gate

- `packages/shared` typecheck (`tsgo --noEmit`) — pass.
- `packages/shared` eslint (`src/documents`, `src/index.ts`) — pass (0).
- shared `bridge.ts` coverage — 22/22 statements, 0 branches (declarative) = 100%.
- `apps/sandbox` typecheck — pass.
- `apps/sandbox` eslint (`.`) — pass (0). (Full `eslint .` hangs unless `public/render.js`
  is ignored — fixed; that would otherwise hang CI too.)
- `apps/sandbox` full suite (`pnpm --filter @hushbox/sandbox test`) — 86 pass, 100%
  stmts/branch/funcs/lines. Not a pole (browser file ~6 s < 15 s).
- jscpd on both changed dirs — 0 clones.

## Acceptance criteria

- Typed bridge in packages/shared, both-sides-importable — **met** (`documents/bridge.ts`,
  exported from the barrel; T3/T4/T6 import from `@hushbox/shared`).
- Import map assembled (esm.sh, versioned/scoped per G10) — **met** (`import-map.ts` +
  `specifier.ts`; declared version wins, else pin, else latest-at-render).
- Sucrase transpile, error surfacing — **met** (`transpile.ts`, pinned 3.35.1, bundled).
- html/js/react render; react mounts default export — **met** (proven in the browser test).
- ready/loading/rendered/console/error reported — **met**.
- Classic-script bootstrap; import map injected before the first dynamic `import()` —
  **met**. The renderer is an esbuild IIFE (no top-level module load), loaded by two classic
  `<script>`s; the import map is injected synchronously before any `import()`. Pinned by the
  IIFE bundle test and the working browser render; the WebView rationale is stated in
  `render.html` and `bootstrap.ts` comments without any run-internal label.
- Parent origin never trusted/echoed — **met** (shape validation only; `postMessage('*')`
  with a documented reason; no origin string read).
- No network beyond module loads — **met** (Sucrase bundled; no fetch/XHR/WS in renderer code).
- 95% coverage — **met** (100%).

## Deviations (with reasons)

- **Test-mode stub not placed as static files under `public/esm-stub/`.** The plan (A2) has
  the sandbox dev server serve a static fixture set at `/esm-stub`. That is not workable with
  the T1 dev server as built: it serves extensionless files as `application/octet-stream`
  (browsers reject modules with a non-JS MIME), and esm.sh's URL scheme needs both
  `/pkg@ver` (a file) and `/pkg@ver/sub` (under a dir) — a collision on a real filesystem.
  T2's browser integration test therefore self-serves the stub modules (inline, correct MIME)
  via its own harness while loading the **real** committed `render.html` + `render.js`. This
  is faithful test-mode shape (a local stub instead of esm.sh) and proves the renderer, but
  the shared `/esm-stub`-served-by-dev-server path still needs T1/T6 work before T7/T8 (which
  drive the real dev server) can rely on it. RAISED.
- **Renderer served as a committed, drift-tested bundle** rather than a build-time hook in
  T1's `build.ts`. `build.ts` copies `public/` → `dist/` verbatim, so the committed
  `public/render.js` ships in both dev and prod with no change to T1's build. Regenerate with
  `pnpm --filter @hushbox/sandbox build:render`; the drift test fails if it goes stale (same
  pattern as migration-drift). `build.ts` does not auto-run it. RAISED.

## Concerns and limitations

- **Config edits to T1-authored files** (package.json, vitest.config.ts, eslint.config.js)
  and the root **pnpm-lock.yaml** were required to make the renderer build, serve, lint, and
  meet the coverage gate. All are minimal and justified in-file. RAISED as coordination.
- **Bundle size 606 KB minified** (zod + Sucrase inlined). One-time, cached; robust for
  mobile (no CDN fetch for the transpiler). Noted, not blocking.
- **LoadingPhase / DocumentErrorCode are closed enums owned here.** They include the python
  members T3 needs (`loading-runtime`, `loading-packages`, `executing`; `python_error`,
  `input_unsupported`). If T3 needs a phase/code not in the set, it is a change to this file
  (single writer), not an ad-hoc string. RAISED.
- Browser integration test is ~79% of the sandbox suite's test-time (~6 s). Under the 15 s
  pole threshold today; a watch item if it grows.

## Confidence

High for the bridge contract and the pure render logic (100% covered, clean gates). High for
the browser render pipeline (proven end-to-end in real Chromium). Medium only on the shared
`/esm-stub` serving story, which is a T1/T6 coordination gap surfaced above, not a defect in
T2's deliverables.
