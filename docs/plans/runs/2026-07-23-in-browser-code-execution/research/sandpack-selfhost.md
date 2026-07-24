# Sandpack self-hosted bundler — implementation research

Researched 2026-07-23 for @codesandbox/sandpack-react 2.20.0 (decision: self-hosted bundler).
Note: sandpack-react is **not yet installed** in this repo (`node_modules/@codesandbox` absent; no imports in `apps/web`) — all version-specific claims below are pinned to the published 2.20.0 npm tarball, inspected locally. [Verified]

## 1. Self-hosting the bundler

### What the bundler is

The classic Sandpack bundler is a static site (HTML + JS + workers) that sandpack-client loads
in an iframe; by default it points at `https://{sandpack-client-version}-sandpack.codesandbox.io`
(e.g. `2-19-8-sandpack.codesandbox.io` for the client that ships with react 2.20.0). Custom
`bundlerURL` is used verbatim and skips the version/teamId/service-worker-suffix URL rewriting.
[Verified — `dist/clients/runtime/index.js` in @codesandbox/sandpack-client@2.19.8:
`createBundlerURL()`: `var bundlerURL = this.options.bundlerURL || BUNDLER_URL; if (this.options.bundlerURL) { return bundlerURL; }`]

### Option (a) — LibreChat-AI/codesandbox-client fork (recommended)

- Repo: https://github.com/LibreChat-AI/codesandbox-client — a fork of codesandbox/codesandbox-client
  whose sole purpose is prebuilt self-hostable bundler artifacts. [Verified — fork README]
- **Prebuilt artifacts** (no yarn/lerna build needed):
  - Docker image: `ghcr.io/librechat-ai/codesandbox-client/bundler:latest` (nginx:alpine serving
    the prebuilt `www/`), `docker run -p 8080:80 …`. [Verified — fork README + `Dockerfile.bundler`]
  - `bundler.zip` from GitHub Releases: latest is **bundler-v12** (published 2025-03-07),
    **29.6 MB zipped**; serve extracted files with any static server.
    [Verified — https://github.com/LibreChat-AI/codesandbox-client/releases/tag/bundler-v12]
- **Fork deltas vs upstream**: removes CodeSandbox metrics beacon on first load
  (`fix: remove codesandbox metrics on first load`, 2025-03-06), adds a build workflow +
  Dockerfile + a missing babel source map. Upstream synced through ~Jan 2025 (last upstream
  commit merged: `fix: starting ~ in style paths #8694`, 2025-01-31). [Verified — commit log]
- **Production serving config** (their nginx, `.github/nginx/default.conf`): [Verified]
  - `Access-Control-Allow-Origin: *` (+ Methods GET,POST,OPTIONS; standard headers) on everything
  - SPA fallback `try_files $uri $uri/ /index.html`
  - `Cache-Control: public, max-age=86400, immutable`, gzip on
  - `location ~ \.worker\.js$`: forced `Content-Type: application/javascript` +
    `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`
- **LibreChat app-side wiring**: env `SANDPACK_BUNDLER_URL` (and `SANDPACK_STATIC_BUNDLER_URL`
  for the `static` template) is exposed via their startup-config endpoint and passed as
  `options.bundlerURL`; the static template gets `staticBundlerURL`, everything else gets
  `bundlerURL`. [Verified — danny-avila/LibreChat `api/server/routes/config.js`,
  `client/src/utils/artifacts.ts`]

### Option (b) — build from source (codesandbox/codesandbox-client)

Official docs: clone codesandbox-client → `yarn install` → `yarn build:deps` → `yarn build:sandpack`
→ serve the produced root **`www/`** folder; point `bundlerURL` at it.
[Verified — https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler]
The fork's README warns the documented steps are stale: Node 16 (`.nvmrc`), and
`codesandbox-browserfs` must be built first (via `yarn start` once, or
`lerna run build --scope @codesandbox/common --scope @codesandbox/components --scope app`)
or `build:deps`/`build:sandpack` error. [Verified — fork README "Building From Source"]
This is a heavy legacy yarn/lerna monorepo build — prefer (a).

### Option (c) — codesandbox/sandpack-bundler (the rewrite)

https://github.com/codesandbox/sandpack-bundler — a from-scratch, smaller/faster bundler
(TypeScript + Parcel dev tooling; `yarn build` → static output, `_headers` file included;
main auto-deploys to `https://sandpack-bundler.codesandbox.io`). Apache-2.0-length LICENSE
(~10.9 KB). [Verified — repo README + file listing]
It is positioned as "aims to eventually replace the current sandpack" and is NOT what
`sandpack.codesandbox.io` production uses for the CRA template; feature coverage vs the classic
bundler (transpiler breadth, envs) is narrower. [Inferred from README wording; feature-parity
not verified] Treat as experimental; do not adopt for launch.

### Pinning / updating

- Pin by Docker image digest or by the release tag's `bundler.zip` (bundler-v12). Updates are
  manual: new fork release → redeploy. The bundler protocol between sandpack-client 2.x and the
  classic bundler is stable across these versions (LibreChat runs current sandpack-react against
  bundler-v12). [Inferred — LibreChat ships this combination in production]
- For us: serving the extracted `bundler.zip` as an assets-only Cloudflare Worker/Pages project on
  a dedicated subdomain (e.g. `sandpack.hushbox.ai`) with the headers from §5 replicates the nginx
  config without adding a container. [Inferred — file set is purely static; verified static]

### `bundlerURL` constraints

- Any origin works; the value is used as the iframe `src` verbatim. [Verified — createBundlerURL]
- **Must be a different origin from the app** — official docs: the iframe on a separate
  (sub)domain "prevents attackers from tampering with cookies of the host domain" when user code
  runs. Same-origin hosting would let sandboxed code touch app cookies/storage. [Verified — docs
  guide; the security consequence is Inferred but standard]
- The bundler registers a service worker on its own origin for offline transpiler caching; SW
  scope is the bundler origin, so it never collides with the app's own SW. A custom `bundlerURL`
  also bypasses the `experimental_enableServiceWorker` per-client SW-id subdomain scheme (that
  scheme only applies to codesandbox.io-hosted bundlers with `teamId`). [Verified — docs guide +
  createBundlerURL early-return]

## 2. Where npm packages come from at runtime

**Self-hosting the bundler does NOT remove third-party runtime fetches for dependencies.**
The classic bundler resolves sandbox `dependencies` in two tiers
[Verified — codesandbox/codesandbox-client `packages/sandpack-core/src/npm/preloaded/fetch-dependencies.ts`
and `.../npm/dynamic/fetch-protocols/index.ts`]:

1. **Packager service (preloaded deps)**: GET
   `https://prod-packager-packages.codesandbox.io/v2/packages/<dep>/<version>.json`
   (CodeSandbox S3 bucket of pre-bundled dependency manifests); on miss, POST to the packager
   lambda `https://aiwi8rnkp5.execute-api.eu-west-1.amazonaws.com/prod/packages` to generate it,
   then re-fetch. URLs are **hard-coded** (`const URLS = PROD_URLS`) — changing them requires
   patching the fork and rebuilding; the LibreChat fork does NOT change them. [Verified]
2. **Dynamic fetch protocols (per-file fallback and non-registry versions)**: jsDelivr
   (`JSDelivrNPMFetcher`, default `condition: () => true`), unpkg (fallback), tarball URLs,
   `gist:`, GitHub-ref via jsDelivr. [Verified — fetch-protocols/index.ts]
3. **Configurable registries exist only as an additive runtime option**: `customSetup.npmRegistries`
   (`registryUrl`, `enabledScopes`, `limitToScopes`, auth token) routes matching scopes to your
   own registry/proxy (Verdaccio recommended) — designed for private packages, and can direct
   scoped deps away from the public path. [Verified — hosting-the-bundler docs]

So: runtime third-party dependency = CodeSandbox's packager bucket + jsDelivr/unpkg CDNs, fetched
**from inside the bundler iframe** (bundler origin's connect targets, not the host page's).
Fully air-gapped operation would require patching `fetch-dependencies.ts`/fetch-protocols and
standing up a packager mirror — out of scope unless required. [Inferred from the above]

## 3. React 19

- The `react` template in sandpack-react 2.20.0 ships `/package.json` with
  `react: ^19.0.0`, `react-dom: ^19.0.0`, `react-scripts: ^5.0.0` (environment
  `create-react-app`). So yes — sandboxes run React 19 by default. [Verified — extracted
  npm tarball `dist/index.js`, `REACT_TEMPLATE`]
- Host-page peer deps: `react`/`react-dom` `^16.8 || ^17 || ^18 || ^19` — fine with our React 19
  app. [Verified — sandpack-react 2.20.0 package.json]
- **Version selection**: sandbox dependency versions come from the sandbox's `/package.json` file
  (template-provided, overridable by passing your own `files['/package.json']`) merged with
  `customSetup.dependencies`. To pin per-sandbox: pass
  `customSetup: { dependencies: { react: "19.0.0", "react-dom": "19.0.0" } }` or supply your own
  `/package.json`. Exact semver pins avoid packager range-resolution drift. [Verified for the
  template-file mechanism (REACT_TEMPLATE embeds deps in `/package.json`); customSetup merge
  behavior Verified via docs https://sandpack.codesandbox.io/docs/getting-started/custom-content]

## 4. Templates: classic bundler vs Nodebox

In sandpack-react 2.20.0, `SANDBOX_TEMPLATES` maps each template to an `environment`; the client
picks the runtime from it. [Verified — extracted dist]

- **Classic bundler** (self-hostable; codesandbox-client bundler; the bundler-relevant packages
  `packages/common`, `packages/sandpack-core`, `packages/app/src/sandbox` are **Apache-2.0**,
  rest of that repo GPLv3 — Verified, codesandbox-client LICENSE):
  `react` + `react-ts` (create-react-app) · `vanilla` + `vanilla-ts` + `test-ts` (parcel) ·
  `vue` + `vue-ts` (vue-cli) · `angular` (angular-cli) · `solid` (solid) · `svelte` (svelte).
- **`static`** (environment `static`): NOT the classic bundler — served by the static preview
  server, default `https://preview.sandpack-static-server.codesandbox.io` (own `bundlerURL`
  override supported; LibreChat self-hosts it separately as `SANDPACK_STATIC_BUNDLER_URL`).
  [Verified — sandpack-client 2.19.8 `dist/index-5796fa85.js`; LibreChat config.js]
- **Nodebox** (environment `node`; `@codesandbox/nodebox` 0.1.8, **commercial/proprietary EULA**,
  runtime fetched from CodeSandbox — not self-hostable): `node`, `nextjs`, `astro`, `vite`,
  `vite-react`, `vite-react-ts`, `vite-preact(-ts)`, `vite-vue(-ts)`, `vite-svelte(-ts)`.
  [Verified — environment map in extracted dist; nodebox dep in sandpack-client package.json.
  EULA claim: Assumed from Nodebox's published licensing — re-verify at
  https://github.com/codesandbox/nodebox-runtime before shipping.]
- **Restriction mechanism**: nothing in the library blocks Nodebox templates — restrict by only
  ever passing an allowlisted `template` prop (type `SandpackPredefinedTemplate`) from our own
  code, e.g. a closed union `'react' | 'react-ts' | 'static' | 'vanilla' | 'vanilla-ts'`.
  LibreChat does exactly this (artifact type → react-ts/static). [Verified — LibreChat
  artifacts.ts; restriction-by-construction Inferred/design]

## 5. CSP / headers

**Host page (app CSP — ours is `apps/api/src/middleware/security-headers.ts`, currently
`default-src 'self'` with no `frame-src`, i.e. framing any external origin is blocked today):**
[Verified — file read]

- `frame-src https://<bundler-origin>` — required; the preview iframe's `src` is the bundler URL.
  (Without an explicit `frame-src`, it falls back to `default-src 'self'` and the iframe is
  blocked.) [Verified mechanism; directive requirement Inferred from CSP spec — standard]
- No host-page `worker-src`/`connect-src` additions needed for the bundler itself: workers, the
  SW, and all npm/CDN fetches happen inside the iframe under the **bundler origin's** browsing
  context, governed by the bundler origin's (absent) CSP, not ours. [Inferred — CSP is
  per-document; nginx conf serves no CSP header]
- Our `frame-ancestors 'none'` / `X-Frame-Options: DENY` are unaffected (they control who frames
  US, not who we frame). [Verified — file + spec semantics]

**Bundler origin (what we must serve):**

- CORS `Access-Control-Allow-Origin` for the app origin (LibreChat uses `*`) — the sandpack
  client fetches some bundler assets cross-origin. [Verified — fork README + nginx conf]
- `.worker.js` files with a JavaScript MIME type (nginx conf forces
  `Content-Type: application/javascript`; misserved workers are the #1 reported failure).
  [Verified — fork README Troubleshooting + nginx conf]
- Fork also sets COEP `require-corp` + COOP `same-origin` on worker files. [Verified — nginx conf]
- Do NOT put a restrictive CSP on the bundler origin — it must eval/execute arbitrary user code
  and fetch from `prod-packager-packages.codesandbox.io`, jsDelivr, unpkg. If we do add one,
  `connect-src` must include those hosts plus data:/blob:, and `script-src` needs
  `'unsafe-eval'`. [Inferred from §2 endpoints]
- SPA fallback to `/index.html`; long-cache immutable assets. [Verified — nginx conf]

## 6. Local dev

- Simplest: run the fork's Docker image in our dev stack
  (`docker run -p <port>:80 ghcr.io/librechat-ai/codesandbox-client/bundler:latest`) or serve the
  extracted `bundler.zip` with any static server; set `bundlerURL: 'http://localhost:<port>'`.
  [Verified — fork README quick start]
- `localhost` is a secure context, so the bundler's service worker works over plain http in dev.
  [Assumed — standard browser behavior, not re-tested]
- Use a different port than Vite = different origin, so the cookie-isolation property holds in
  dev too; no Vite proxy needed (the iframe just points at the other port). [Inferred]
- Dev machines still need outbound network for packager/jsDelivr fetches (§2) — the "self-hosted"
  bundler is not offline-capable for arbitrary deps. First load of a dep is slower (packager
  generation on miss, with retry/backoff up to 60 tries). [Verified — fetch-dependencies.ts retry
  logic; offline limitation Inferred]
- Repo-specific: this monorepo computes per-worktree ports via `.env.scripts` (`HB_*_PORT`) and
  containers via `docker-compose.yml` (single source of truth for CI parity) — adding the bundler
  as a compose service + an `env.config` entry for the bundler URL fits the existing pattern.
  [Verified — docs/DEVELOPMENT.md; integration approach is a suggestion]

## Sources

- https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler — official self-host guide
- https://github.com/LibreChat-AI/codesandbox-client — fork README, Dockerfile.bundler, .github/nginx/default.conf, commit log, releases (bundler-v12, bundler.zip 29.6 MB)
- https://github.com/danny-avila/LibreChat — api/server/routes/config.js, client/src/utils/artifacts.ts, packages/api/src/shared-links/config.ts (SANDPACK_BUNDLER_URL / SANDPACK_STATIC_BUNDLER_URL wiring)
- https://github.com/codesandbox/codesandbox-client — LICENSE (GPLv3 + Apache-2.0 carve-outs), packages/sandpack-core/src/npm/preloaded/fetch-dependencies.ts (packager URLs), packages/sandpack-core/src/npm/dynamic/fetch-protocols/index.ts (jsDelivr/unpkg/tar protocols)
- https://github.com/codesandbox/sandpack-bundler — rewrite bundler README
- npm tarballs @codesandbox/sandpack-react@2.20.0 + @codesandbox/sandpack-client@2.19.8 (extracted in scratchpad; template map, REACT_TEMPLATE deps, createBundlerURL, static-server default, nodebox dep)
- /workspace/popper-mobile/.superset/projects/HushBox/apps/api/src/middleware/security-headers.ts — current app CSP
