# T1 — Sandbox origin app · impl-report-1

## Objective

Stand up `apps/sandbox` — an assets-only Cloudflare Worker (the `apps/admin` pattern)
serving the sandbox origin's static renderer pages + pinned self-hosted Pyodide assets,
wired into pnpm/turbo, the env registry (`SANDBOX_ORIGIN_URL`, `HB_SANDBOX_PORT`,
`ESM_CDN_URL`), the local dev stack, and deploy config with the approved subdomain custom
domain. Includes the A7 `capacitor://localhost` embedding integration item (sandbox-side +
documented harness).

## Files changed

New package `apps/sandbox/`:

- `package.json` — `@hushbox/sandbox`, `type: module`; scripts `dev` (serve.ts), `build`
  (build.ts), `fetch-pyodide`, `lint`, `typecheck`, `test`, `test:watch`. Mirrors the
  admin/scripts package conventions.
- `tsconfig.json` — extends the shared base; node + vitest types.
- `eslint.config.js` — base + node + test + scripts + prettier configs; ignores
  `dist`/`public/pyodide`.
- `vitest.config.ts` — node env, per-file 95% gate, static `include`; excludes `serve.ts`
  (socket bootstrap); disables the shared SSR optimizer (no heavy internal deps here).
- `wrangler.toml` — assets-only Worker `hushbox-sandbox`, `[assets] directory = ./dist`,
  `not_found_handling = "none"`, custom domain route `sandbox.hushbox.ai/*` (A1).
- `.gitignore` — `dist`, `public/pyodide` (generated).
- `public/render.html`, `public/python.html` — STUBS (serving proof + config seam); each
  carries the A7 invariant note (render: classic bootstrap + import map before first
  dynamic import; python: main-thread Pyodide, teardown-stop). Real renderer logic is
  T2/T3.
- `public/_headers` — prod CORS baseline (`Access-Control-Allow-Origin: *`,
  `Cross-Origin-Resource-Policy: cross-origin`) for the opaque frame's cross-origin
  wasm/wheel fetches (A7). CSP directives are explicitly fenced to T6 (see Concerns).
- `src/mime.ts` — `contentTypeFor(pathname)`: extension→Content-Type, `.wasm` →
  `application/wasm` (load-bearing per T0).
- `src/config.ts` — `buildSandboxConfigScript(env)`: emits `/config.js` publishing
  `globalThis.__SANDBOX_CONFIG__ = { esmCdnUrl }` from `ESM_CDN_URL`; fail-fast on missing;
  `<`-escaped so it is `<script>`-safe. The env-driven import-map base seam (A2/G4) that
  T2 consumes.
- `src/dev-server.ts` — `resolveDevPort(env)` (fail-fast on `HB_SANDBOX_PORT`),
  `resolveWithinDir(dir, pathname)` (traversal guard), `createRequestListener(opts)` (static
  serving + MIME + permissive CORS + `/config.js` + OPTIONS/HEAD/405/404).
- `src/serve.ts` — `pnpm dev` bootstrap (reads env, listens on `HB_SANDBOX_PORT`).
- `src/build.ts` — `buildSandbox({publicDir, distDir, configScript})`: (re)assembles `dist`
  from `public` + writes `config.js`; guarded CLI `main`.
- `scripts/fetch-pyodide.sh` — committed pinned fetch mechanism (Pyodide 314.0.2 core from
  npm pack + numpy/matplotlib wheel baseline from the versioned CDN) → `public/pyodide/`.

Env / dev-stack wiring (in-bounds shared files):

- `scripts/worktree.ts` — `BASE_PORTS.sandbox = 7400` (window 7400..7599, disjoint from all
  neighbours).
- `scripts/generate-env.ts` — emits `HB_SANDBOX_PORT` in `.env.scripts`.
- `scripts/generate-env.test.ts` — pins `HB_SANDBOX_PORT="7400"` in both port-line blocks.
- `packages/shared/src/env.config.ts` — `SANDBOX_ORIGIN_URL` (Scripts, all modes;
  prod `https://sandbox.hushbox.ai`) and `ESM_CDN_URL` (Scripts; prod/dev `https://esm.sh`,
  test modes `.../esm-stub` per A2).
- `package.json` — `dev:clean` now kills `HB_SANDBOX_PORT`.
- `knip.jsonc` — `apps/sandbox` workspace entry (`ignoreDependencies: ["wrangler"]` — a
  deploy-time binary, not a JS import).

Not touched: `pnpm-workspace.yaml`/`turbo.json` needed no edit — `apps/*` globs already
cover the new package (dev auto-joins `turbo dev`; passThroughEnv `HB_*` already set).

## Tests added (40 total, 100% coverage)

- `mime.test.ts` — .wasm→application/wasm; html/js/mjs/json/whl/zip/css; case-insensitive;
  no-extension + unknown fallback.
- `config.test.ts` — global assignment; esm URL passthrough; stub URL; `<script>`-safe
  escaping; fail-fast on missing/empty `ESM_CDN_URL`.
- `dev-server.test.ts` — `resolveDevPort` (valid/missing/non-integer); `resolveWithinDir`
  (normal/root/interior-`..`/escape/sibling-prefix); listener via a real booted server
  (static MIME+CORS, .wasm bytes, `/config.js`, OPTIONS 204, 404 missing/root, traversal
  safe end-to-end, 405, HEAD static + config, undefined method/url defaults).
- `build.test.ts` — copies pages + nested pyodide assets; writes `config.js`; clears stale
  `dist`.

## Self-gate

- `turbo typecheck lint --filter=@hushbox/sandbox` — **pass** (2 tasks successful).
- `pnpm --filter @hushbox/sandbox test` (with-env + run-package-tests, coverage) — **pass**,
  40 tests, 100% stmts/branch/funcs/lines.
- `eslint .` (from package dir, after last edit) — **pass** (exit 0).
- `tsgo --noEmit` — **pass** (exit 0).
- `pnpm verify:env` — registry per-key completeness **pass** for all VERIFIED_MODES;
  `--mode=development` and `--mode=production` full pass. `ciVitest/e2e/ciE2E` report
  derived-flag mismatches ONLY because the on-disk env files were generated in development
  mode (`isCI`/`isLocalDev` differ) — a pre-existing property of verify:env against
  single-mode-generated files, unrelated to the new keys (no SANDBOX/ESM mismatch appears).
  Confirmed directly: `findMissingKeys(envConfig)` returns `[]`; both new keys resolve in
  every mode (dev/prod = esm.sh + sandbox.hushbox.ai; test modes = esm-stub).
- Runtime smoke (serve.ts): booted on a port, `GET /render.html` → 200 text/html + CORS;
  `GET /config.js` → `globalThis["__SANDBOX_CONFIG__"] = {"esmCdnUrl":"https://esm.sh"};`;
  `GET /python.html` → 200. Build smoke: `dist/{render,python}.html`, `dist/pyodide/*`,
  `dist/config.js` all assembled.

Repo-wide gates `pnpm lint:unused` (knip) and `pnpm arch:check` currently exit 1, but for
causes OUTSIDE this task's ownership (see Concerns): sandbox contributes zero violations to
either.

## Acceptance criteria

- `pnpm dev` serves the origin on its computed port — **met**. `dev` script starts serve.ts
  on `HB_SANDBOX_PORT` (7400 base, per-worktree offset); `turbo dev` auto-includes the
  package; smoke-tested end-to-end.
- Pages load — **met** (render.html/python.html served 200; smoke-tested).
- Pyodide assets served with correct MIME (`application/wasm`) + permissive CORS — **met**.
  Dev server sets `application/wasm` + `Access-Control-Allow-Origin: *` (unit + booted-server
  tests with a real wasm-header fixture); prod `_headers` carries the CORS/CORP baseline and
  the Cloudflare assets runtime serves `.wasm` natively.
- Production wrangler config present — **met** (assets-only, custom-domain route).
- Env verified by `pnpm verify:env` in all modes — **met** (registry completeness green all
  modes; see Self-gate for the derived-flag caveat).
- Unit tests for any logic; repo gates pass — **met** for the package (100% coverage, lint,
  typecheck); repo-wide knip/arch reds are pre-existing/concurrent, not sandbox.
- A7 capacitor embedding integration item — **partially met (sandbox side + documented
  harness)**; on-device APK proof remains for T9 (see Concerns / Carry-forward).

## Capacitor embedding harness (A7) — what is proven and what remains

The sandbox side is ready and its cross-origin embeddability is proven at the desktop proxy
level (the same fidelity T0 used — Chrome 113 == Android System WebView 113):

- The origin serves static pages over its own origin with permissive CORS + CORP, so an
  https cross-origin `sandbox="allow-scripts"` iframe can load a page and the opaque frame
  can fetch the Pyodide wasm/wheels (tested: CORS/CORP headers present; `/config.js`
  executes from a different origin in the booted-server tests).
- I could not build a real `capacitor://localhost` APK: that requires editing `apps/web`
  (T4's) and `mobile-tests/` (T9's), both out of BOUNDS. T0 hit the same wall and accepted
  it as low risk.

Harness to complete the on-device proof (records precisely what remains):

1. **T6** — the sandbox `_headers` CSP must set `frame-ancestors` to include
   `capacitor://localhost` **and** our app origins (else the iframe will not embed under the
   Capacitor scheme). The CORS/CORP baseline is already in `public/_headers`.
2. **T4** — the web app embeds the sandbox iframe with `src` from a `VITE_SANDBOX_ORIGIN_URL`
   frontend env mirror (not yet added — see Carry-forward) and ships the
   `document-render-status` app-DOM element (A4).
3. **T9** — the Maestro Android flow asserts `document-render-status` flips to rendered on
   device, which proves the `capacitor://localhost` → https sandbox iframe path end-to-end.

## Deviations

- `pnpm-workspace.yaml` / `turbo.json` not edited (listed in the plan's T1 Files) — the
  existing `apps/*` globs + `turbo dev` persistent task + `passThroughEnv: HB_*` already
  cover the new package; no edit was needed. Verified `turbo --filter=@hushbox/sandbox`
  resolves it.
- Pyodide assets are gitignored + generated by the committed pinned fetch mechanism
  (`fetch-pyodide.sh`), not vendored into git — matches the brief's "reproduce a committed,
  pinned fetch mechanism (don't vendor 26 MB blindly)" and the T0 spike's intent. Repo
  convention check: large binaries ARE committed directly elsewhere (18–21 MB PNG/GIF), and
  Git-LFS is reserved for `ads/**`; 26 MB of wasm/wheels is a new magnitude, so the
  fetch-at-build approach was chosen (self-hosting per R1 = served from our origin, not
  necessarily committed). See Concerns for the T1/T3 asset-ownership seam.

## Concerns and limitations

- **[coordination — T3] Pyodide asset ownership.** T3's Files own `apps/sandbox/public/
  pyodide/**` and `src/python/**`. I did NOT write into either (T2 owns `src/render/**`).
  The fetch MECHANISM (`scripts/fetch-pyodide.sh`) is mine and writes into the gitignored
  `public/pyodide/`; its wheel list is the spike-proven baseline (numpy/matplotlib +
  contourpy/cycler/six/fonttools). T3 owns the definitive transitive wheel closure (read
  exact pinned filenames from `pyodide-lock.json`) and appends them — I deliberately did NOT
  guess the remaining matplotlib deps (kiwisolver/pillow/etc.) to avoid committing filenames
  that would 404.
- **[coordination — T6] Header VALUES / CSP.** `public/_headers` carries only the A7 CORS +
  CORP baseline I own. All CSP directives (`frame-src`/`frame-ancestors`/`script-src`/
  `worker-src`/`connect-src`, R8) are T6's. If T6 chooses to GENERATE `dist/_headers`
  (mirroring `generateAdminHeaders`), it should hook into `build.ts` or overwrite the static
  file — flag the choice. `generate-headers.ts` was left untouched (T6's).
- **[coordination — T4] Frontend env mirror.** The web app needs a `VITE_SANDBOX_ORIGIN_URL`
  (Frontend destination) to set the iframe `src`; `SANDBOX_ORIGIN_URL` is Scripts-only
  (build-time). T4 adds the VITE_ mirror (the `ADMIN_URL` / `VITE_ADMIN_URL` precedent).
- **[coordination — T2] ESM stub fixtures.** `ESM_CDN_URL` test modes point at
  `<sandbox-origin>/esm-stub`; the dev server serves that path statically, but the fixture
  packages themselves (the tiny pinned ES modules T2/T7/T8 import) are not populated here —
  that content is T2/T7/T8's, consumed via `__SANDBOX_CONFIG__.esmCdnUrl`. Seam established;
  fixtures are carry-forward.
- **[repo gate — not mine] `pnpm lint:unused` (knip) exits 1** from pre-existing/concurrent
  unused files only: `apps/api/.../webpush/index.ts`, `packages/config/vitest.package.
  config.ts`, and the T0 spike `.mjs/.js` files. `apps/sandbox` contributes zero knip
  findings.
- **[repo gate — not mine] `pnpm arch:check` exits 1** from a concurrent db change
  (`table 'notificationPreferences' has no owning slice`). No sandbox-related violation.
- **Sandbox subdomain name** chosen as `sandbox.hushbox.ai` (SANDBOX_ORIGIN_URL prod +
  wrangler route). The plan approved "a subdomain" without pinning the label; this is a
  reasonable default — flag if the founder wants a different label.
- **`compatibility_date`** set to `2026-07-24` (assets-only worker, no runtime code, so
  inert).

## Confidence

**High** on the shipped package: TDD, 100% coverage, all named T1 gates green, dev + build
smoke-tested end-to-end, env resolves in every mode. **Medium** only on the A7 capacitor
on-device proof, which is architecturally deferred to T9 by BOUNDS (sandbox side done +
harness documented) — a pre-existing, plan-accepted risk, not a regression.
