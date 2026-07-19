#!/usr/bin/env tsx
/**
 * Generate `apps/web/dist/_headers` for the merged Cloudflare Pages deploy.
 *
 * For each prefix in `MARKETING_ROUTES`, walks `apps/web/dist/<prefix>/` for
 * built `index.html` files, computes the SHA-256 of every inline `<script>`
 * body, and emits a per-path `_headers` block whose `script-src` carries
 * those hashes inline. The SPA `/*` block is emitted FIRST; each per-path
 * block then unsets and re-sets every header so Cloudflare serves exactly one
 * (hashed) CSP per marketing path instead of appending a second policy.
 *
 * Why hash from HTML directly (not from Astro's meta tag): Astro's
 * `experimental.csp` only hashes scripts Astro itself emits and skips
 * `<script is:inline>` blocks authored in `.astro` files — see the comment
 * in `apps/marketing/astro.config.mjs`. Hashing every inline script in the
 * built HTML catches both classes uniformly.
 *
 * Style hashes are NOT emitted: that would invalidate `'unsafe-inline'`,
 * which is required for Tailwind's runtime style insertion and for inline
 * `style="..."` attributes (e.g. ThemeToggle SVG transitions, plus the
 * Shiki incompatibility documented in `apps/marketing/astro.config.mjs`).
 *
 * Single source of truth for the marketing route list:
 *   packages/shared/src/routes.ts → MARKETING_ROUTES
 *
 * Called from:
 *   - `.github/workflows/ci.yml`        (after merge-marketing-into-web)
 *   - `.github/workflows/release.yml`   (after merge-marketing-into-web)
 *   - `playwright.config.ts`            (web server command chain)
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKETING_ROUTES, ROUTES } from '../packages/shared/src/routes.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import type { Dirent } from 'node:fs';

export interface GenerateHeadersOptions {
  readonly repoRoot: string;
  /** Override the dist directory (defaults to `apps/web/dist`). For tests. */
  readonly distRelativePath?: string;
  /** Override the output file (defaults to `<dist>/_headers`). For tests. */
  readonly outputRelativePath?: string;
  /**
   * The API origin the marketing app was built against (the value of
   * VITE_API_URL at build time). Defaults to `process.env.VITE_API_URL`.
   * Must match the URL the client bundles will actually fetch from, or the
   * generated CSP will block those fetches.
   */
  readonly apiUrl?: string;
  /**
   * Local MinIO/R2 emulator port for dev + E2E builds. Defaults to
   * `process.env.HB_MINIO_API_PORT` (written to .env.scripts by
   * `scripts/generate-env.ts`, slot-offset for worktrees per
   * `scripts/worktree.ts` → `BASE_PORTS.minioApi`). When omitted *and* the
   * env var is unset, no MinIO origin is added — that's the production
   * path, where R2 reads go through the `https://*.r2.cloudflarestorage.com`
   * wildcard already baked into connect-src.
   */
  readonly minioApiPort?: string;
}

export interface GenerateHeadersResult {
  readonly outputPath: string;
  readonly pagesProcessed: number;
  readonly blocksEmitted: number;
}

interface MarketingPage {
  readonly urlPath: string;
  readonly htmlFile: string;
}

interface PageCsp {
  readonly scriptHashes: readonly string[];
}

const DEFAULT_DIST = 'apps/web/dist';
const DEFAULT_OUTPUT = `${DEFAULT_DIST}/_headers`;

/**
 * Header block applied to every SPA route. Mirrors what lived in
 * `apps/web/public/_headers` before this generator replaced it, with the
 * API origin templated so dev/preview builds (localhost) and production
 * builds (api.hushbox.ai) both produce a CSP that matches their built
 * VITE_API_URL. Without this, e2e under vite preview fails on the
 * marketing /roadmap fetch — the page targets localhost:8788 but the
 * hardcoded CSP only allows api.hushbox.ai.
 *
 * Marketing routes get their own per-path block with hashes inlined into
 * `script-src` — see `formatMarketingBlock`.
 */
function buildSpaHeaders(
  apiOrigin: ApiOrigin,
  localR2Origin: string | null
): readonly { name: string; value: string }[] {
  // Local MinIO emulator (dev/E2E only — see deriveLocalR2Origin). Prod R2
  // reads are covered by the `*.r2.cloudflarestorage.com` wildcard below;
  // localR2Origin is null on prod builds and contributes nothing.
  //
  // `https://secure.myhelcim.com` is the host for Helcim.js v2 — the
  // billing modal loads `version2.js` from it and the script POSTs the
  // card-tokenization request back to the same origin. Both directives
  // need the host or the payment form fails at mount (script-src) or at
  // submit (connect-src). See apps/web/src/lib/helcim-loader.ts.
  const connectSource = [
    "'self'",
    apiOrigin.http,
    'https://*.r2.cloudflarestorage.com',
    'https://*.r2.dev',
    'https://secure.myhelcim.com',
    apiOrigin.ws,
    ...(localR2Origin === null ? [] : [localR2Origin]),
  ].join(' ');
  return [
    {
      name: 'Content-Security-Policy',
      value:
        "default-src 'self'; " +
        // 'wasm-unsafe-eval' is REQUIRED — packages/crypto's key-derivation
        // (signup, recovery-phrase verify, password change) calls argon2id
        // from hash-wasm, which loads via WebAssembly.compile/instantiate.
        // Same in prod as in dev: every account-creation flow needs WASM.
        //
        // 'unsafe-eval' is REQUIRED — transitive deps in the streamdown and
        // marketing chunks evaluate `Function("return this")` at module init
        // (the legacy global-this polyfill from lodash/d3-era libs). Without
        // this token, every page that loads those chunks throws CSP violations
        // and the marketing site's astro-island hydration fails outright.
        //
        // `https://secure.myhelcim.com` is the only third-party script host
        // we allow. It serves Helcim.js v2 (loaded lazily by the billing
        // modal). No wildcard — the host is named explicitly so the policy
        // can't drift into accepting arbitrary external scripts.
        "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://secure.myhelcim.com; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' blob: data:; " +
        "media-src 'self' blob:; " +
        `connect-src ${connectSource}; ` +
        "font-src 'self' data:; " +
        "frame-ancestors 'none'; " +
        "base-uri 'self'; " +
        "form-action 'self'",
    },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
  ];
}

/**
 * Frame headers for the `/demo` route(s), which host the interactive product
 * demo — the real SPA running in "demo mode" — inside a same-origin <iframe>
 * embedded on the marketing `/welcome` page. The strict SPA policy
 * (`frame-ancestors 'none'` + `X-Frame-Options: DENY`) blocks ALL framing,
 * including same-origin, so the demo route relaxes both to same-origin only:
 * cross-origin framing stays denied. Every other directive is inherited from
 * the SPA policy unchanged.
 */
function buildDemoHeaders(
  spaHeaders: readonly { name: string; value: string }[]
): readonly { name: string; value: string }[] {
  return spaHeaders.map((header) => {
    if (header.name === 'Content-Security-Policy') {
      return {
        name: header.name,
        value: header.value.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
      };
    }
    if (header.name === 'X-Frame-Options') {
      return { name: header.name, value: 'SAMEORIGIN' };
    }
    return header;
  });
}

interface ApiOrigin {
  /** HTTP origin (e.g. `https://api.hushbox.ai`, `http://localhost:8788`). */
  readonly http: string;
  /** WebSocket origin (e.g. `wss://api.hushbox.ai`, `ws://localhost:8788`). */
  readonly ws: string;
}

export function deriveApiOrigin(apiUrl: string): ApiOrigin {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(
      `VITE_API_URL is not a valid URL: "${apiUrl}". Set it in the build env or .env.development.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`VITE_API_URL must use http or https, got "${parsed.protocol}"`);
  }
  const wsScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    http: parsed.origin,
    ws: `${wsScheme}//${parsed.host}`,
  };
}

/**
 * Resolve the local MinIO/R2 emulator origin for dev + E2E CSP, or null
 * when no local origin should be allowlisted (production path).
 *
 * Two gates, both must pass:
 *   1. `apiOrigin.http` is a localhost URL — prod sets VITE_API_URL to
 *      `https://api.hushbox.ai`, so this trips on every prod build and
 *      prevents a stray HB_MINIO_API_PORT from leaking localhost into a
 *      production CSP.
 *   2. `minioApiPort` is a numeric string — present in dev/E2E via
 *      `.env.scripts` (worktree-offset; see `scripts/worktree.ts`),
 *      absent in prod CI/CD which injects only the GitHub Secrets it needs.
 *
 * Throws on malformed port values rather than silently producing a broken
 * URL — the build chain should fail loud, not ship a CSP that allows
 * `http://localhost:NaN`.
 */
export function deriveLocalR2Origin(apiOrigin: ApiOrigin, minioApiPort?: string): string | null {
  if (!apiOrigin.http.startsWith('http://localhost:')) return null;
  if (minioApiPort === undefined || minioApiPort === '') return null;
  if (!/^\d+$/.test(minioApiPort)) {
    throw new Error(
      `HB_MINIO_API_PORT must be a numeric port string, got "${minioApiPort}". ` +
        `It is written to .env.scripts by scripts/generate-env.ts and loaded by ` +
        `scripts/ensure-stack-cli.ts before invoking the headers generator.`
    );
  }
  return `http://localhost:${minioApiPort}`;
}

const FILE_BANNER = `# Auto-generated from scripts/generate-headers.ts — do not edit by hand.
# Source of truth for marketing route list: packages/shared/src/routes.ts → MARKETING_ROUTES
# Source of truth for SPA policy: scripts/generate-headers.ts → SPA_HEADERS
#
# Marketing routes get a per-path block whose script-src lists the SHA-256 of every inline
# <script> body in the built HTML for that path. Cloudflare applies rules top-to-bottom and
# appends repeated headers, so the strict (hashless) /* block comes FIRST and each marketing
# block unsets every header before re-setting it — its hashed CSP replaces /*, not stacks on
# it. Hashing happens at the HTML level (not
# via Astro's experimental.csp) so that <script is:inline> blocks authored in .astro files
# are covered alongside Astro-emitted runtime scripts.
#
# Directive notes
#  - default-src 'self': fall-through deny for anything not enumerated below.
#  - script-src: 'self' + 'wasm-unsafe-eval' + 'unsafe-eval' + secure.myhelcim.com plus
#    per-page SHA-256 hashes on marketing routes, plus the SPA shell's own inline-script
#    hashes on the /* block (inherited by the /demo blocks). 'wasm-unsafe-eval' is required by
#    hash-wasm/argon2id, called from packages/crypto's key-derivation during signup,
#    recovery-phrase verify, and password change. Without it, WebAssembly.compile is
#    blocked and signUpEmail's catch swallows the failure silently. secure.myhelcim.com
#    is the only third-party script host — the billing modal lazy-loads Helcim.js v2
#    from it for client-side card tokenization.
#  - style-src 'self' 'unsafe-inline': required by Tailwind's runtime style insertion and
#    by inline style="..." attributes (e.g. ThemeToggle SVG transitions). Shiki output —
#    if/when blog posts add code fences — also lands here and is the main reason this
#    can't be tightened today.
#  - img-src 'self' blob: data:: 'blob:' is REQUIRED — decrypted media bytes are exposed
#    to <img> tags through URL.createObjectURL(...). 'data:' covers small inline icons.
#  - media-src 'self' blob:: same reason for <video>/<audio> elements with Object URLs.
#  - connect-src 'self' + api origin + R2 hosts + secure.myhelcim.com + wss: front-end
#    fetches encrypted blobs directly from R2 via presigned URLs, posts card tokenization
#    requests to Helcim from version2.js, and opens a WebSocket to the API. The local
#    MinIO emulator at http://localhost:<HB_MINIO_API_PORT> is appended for dev/E2E
#    builds (the port is slot-offset for worktrees; see scripts/worktree.ts); prod builds
#    skip it since the *.r2.cloudflarestorage.com wildcard already covers prod reads.
#  - frame-ancestors 'none': belt-and-suspenders with X-Frame-Options: DENY.
#    Exception: /demo and /demo/* relax to frame-ancestors 'self' + X-Frame-Options
#    SAMEORIGIN so the marketing /welcome page can embed the demo SPA in a
#    same-origin iframe. Cross-origin framing stays denied. See buildDemoHeaders.
#  - base-uri 'self', form-action 'self': close the usual base-tag and form-hijack avenues.
#  - font-src 'self' data:: locally hosted fonts plus inline data: glyphs.
`;

export async function generateHeaders(
  options: GenerateHeadersOptions
): Promise<GenerateHeadersResult> {
  const distributionDir = path.resolve(options.repoRoot, options.distRelativePath ?? DEFAULT_DIST);
  const outputPath = path.resolve(options.repoRoot, options.outputRelativePath ?? DEFAULT_OUTPUT);
  // Option-over-env layering, not a fallback default: an explicit option wins,
  // the env var is the normal source, and absence fail-fasts (apiUrl) or is a
  // designed legal state (minioApiPort — prod builds omit the MinIO origin).
  const envApiUrl = process.env['VITE_API_URL'];
  const apiUrl = options.apiUrl ?? envApiUrl;
  if (!apiUrl) {
    throw new Error(
      `VITE_API_URL must be set (got undefined). The generated CSP's connect-src ` +
        `must match the API origin the marketing app was built against.`
    );
  }
  const apiOrigin = deriveApiOrigin(apiUrl);
  const envMinioApiPort = process.env['HB_MINIO_API_PORT'];
  const minioApiPort = options.minioApiPort ?? envMinioApiPort;
  const localR2Origin = deriveLocalR2Origin(apiOrigin, minioApiPort);

  await assertDirectory(distributionDir);
  const pages = await findMarketingPages(distributionDir);
  /* v8 ignore next 6 -- defensive: MARKETING_ROUTES is non-empty, so findMarketingPages either throws or returns ≥1 page */
  if (pages.length === 0) {
    throw new Error(
      `No marketing pages found under ${distributionDir} for routes ${MARKETING_ROUTES.join(', ')}. ` +
        `Did the marketing build run before this script?`
    );
  }

  // The SPA shell (dist/index.html) ships its own pre-paint inline scripts
  // (theme-flash + a11y-init); the /* block — and the /demo blocks derived from
  // it — must carry their SHA-256 hashes or the strict hashless script-src
  // blocks them on every SPA route. Folded in after the marketing-page
  // validation above so a missing/broken build fails on the clearer
  // dist/marketing errors first.
  const spaHeaders = await inlineSpaShellHashes(
    distributionDir,
    buildSpaHeaders(apiOrigin, localR2Origin)
  );

  // `/*` first: Cloudflare applies rules top-to-bottom, and a per-path
  // `! Content-Security-Policy` only deletes a CSP an earlier rule set. With
  // `/*` last, its hashless CSP would append after the per-path block and the
  // browser's intersection of the two policies blocks every inline script.
  const blocks: string[] = [formatSpaBlock(spaHeaders)];
  // The interactive product demo runs the SPA in an <iframe> on the
  // same-origin marketing /welcome page; /demo + /demo/* relax the strict
  // frame headers to same-origin only. Emitted right after `/*` so their
  // unsets strip the strict values before re-setting the relaxed ones.
  const demoHeaders = buildDemoHeaders(spaHeaders);
  blocks.push(
    formatDemoBlock(ROUTES.DEMO, spaHeaders, demoHeaders),
    formatDemoBlock(`${ROUTES.DEMO}/*`, spaHeaders, demoHeaders)
  );
  for (const page of pages) {
    const html = await fs.readFile(page.htmlFile, 'utf8');
    const csp = computePageCsp(html);
    // Cloudflare Pages serves Astro's `<route>/index.html` at `/route/`
    // (trailing slash, after a 308 from `/route`); its `_headers` matcher
    // is exact-match per path. Emit blocks at BOTH forms — otherwise the
    // hashed CSP attaches only to the 308 redirect and the HTML response
    // falls through to the SPA `/*` block with no script-src hashes,
    // blocking every inline Astro hydration script.
    blocks.push(
      formatMarketingBlock(page.urlPath, csp, spaHeaders),
      formatMarketingBlock(`${page.urlPath}/`, csp, spaHeaders)
    );
  }

  const fileContent = `${FILE_BANNER}\n${blocks.join('\n')}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, fileContent, 'utf8');

  return { outputPath, pagesProcessed: pages.length, blocksEmitted: blocks.length };
}

async function assertDirectory(directory: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Web dist directory does not exist at ${directory}. ` +
          `Build apps before generating headers (pnpm build && tsx scripts/merge-marketing-into-web.ts).`
      );
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Expected ${directory} to be a directory`);
  }
}

async function readRouteEntries(routeDir: string, route: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(routeDir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Marketing route ${route} has no built directory at ${routeDir}.\n` +
          `Run the build + merge chain first:\n` +
          `  pnpm --filter @hushbox/marketing build\n` +
          `  pnpm --filter @hushbox/web build\n` +
          `  pnpm tsx scripts/merge-marketing-into-web.ts\n` +
          `  pnpm generate:headers\n` +
          `(If you only changed marketing content, the marketing build + merge is enough.)`
      );
    }
    throw error;
  }
}

function entryToPage(entry: Dirent, distributionDir: string): MarketingPage {
  const directoryOfIndex = entry.parentPath;
  const relativePath = path.relative(distributionDir, directoryOfIndex).split(path.sep).join('/');
  return {
    urlPath: `/${relativePath}`,
    htmlFile: path.join(directoryOfIndex, entry.name),
  };
}

async function findMarketingPages(distributionDir: string): Promise<MarketingPage[]> {
  const pages: MarketingPage[] = [];
  for (const route of MARKETING_ROUTES) {
    const prefix = route.replace(/^\//, '');
    const routeDir = path.join(distributionDir, prefix);
    const entries = await readRouteEntries(routeDir, route);
    const indexEntries = entries.filter((e) => e.isFile() && e.name === 'index.html');
    if (indexEntries.length === 0) {
      throw new Error(
        `Marketing route ${route} produced no index.html under ${routeDir}. ` +
          `Did the Astro build complete?`
      );
    }
    for (const entry of indexEntries) {
      pages.push(entryToPage(entry, distributionDir));
    }
  }
  return pages;
}

// Match each `<script>` element that does NOT have a `src=` attribute on the
// opening tag. The content is the (possibly empty) body up to `</script>`.
// `[\s\S]` lets `.` match newlines without the `s` flag.
const INLINE_SCRIPT_REGEX = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

export function computePageCsp(html: string): PageCsp {
  const scriptHashes: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT_REGEX)) {
    /* v8 ignore next -- the regex's capture group always matches (possibly empty) script body text */
    const body = match[1] ?? '';
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    const token = `'sha256-${digest}'`;
    if (!seen.has(token)) {
      seen.add(token);
      scriptHashes.push(token);
    }
  }
  return { scriptHashes };
}

/**
 * Fold the SPA shell's inline-script SHA-256 hashes into the `/*` CSP. The shell
 * (dist/index.html) serves theme-flash + a11y-init inline scripts that must run
 * before first paint; without their hashes the strict script-src blocks them on
 * every SPA route. Returns headers unchanged when the shell has no inline
 * scripts. The /demo blocks derive from the returned headers and inherit them.
 */
async function readShellHtml(distributionDir: string, appLabel: string): Promise<string> {
  const shellPath = path.join(distributionDir, 'index.html');
  try {
    return await fs.readFile(shellPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `SPA shell not found at ${shellPath}. The ${appLabel} build must emit index.html before headers are generated.`
      );
    }
    throw error;
  }
}

async function inlineSpaShellHashes(
  distributionDir: string,
  headers: readonly { name: string; value: string }[]
): Promise<readonly { name: string; value: string }[]> {
  const shellHtml = await readShellHtml(distributionDir, 'web');
  const csp = computePageCsp(shellHtml);
  return headers.map((header) =>
    header.name === 'Content-Security-Policy'
      ? { name: header.name, value: inlineHashesIntoSpaCsp(header.value, csp) }
      : header
  );
}

function formatMarketingBlock(
  urlPath: string,
  csp: PageCsp,
  spaHeaders: readonly { name: string; value: string }[]
): string {
  // `/*` (emitted first) already set these headers, and Cloudflare appends a
  // repeat rather than replacing — so unset each before re-setting, or the
  // response carries two values (for CSP, two policies the browser intersects).
  const lines: string[] = [urlPath];
  for (const header of spaHeaders) {
    lines.push(`  ! ${header.name}`);
  }
  for (const header of spaHeaders) {
    const value =
      header.name === 'Content-Security-Policy'
        ? inlineHashesIntoSpaCsp(header.value, csp)
        : header.value;
    lines.push(`  ${header.name}: ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Override block for the `/demo` route(s). The `/*` block (emitted first)
 * already set the strict frame headers, and Cloudflare appends rather than
 * replaces — so unset each SPA header before re-setting the relaxed demo
 * variant. Without the unset, the response carries two CSPs and the browser
 * intersects them back to `frame-ancestors 'none'`, re-blocking the iframe.
 * Mirrors `formatMarketingBlock`'s unset-then-set discipline; no per-page
 * script hashes (the demo serves the SPA's hashless index.html).
 */
function formatDemoBlock(
  urlPath: string,
  spaHeaders: readonly { name: string; value: string }[],
  demoHeaders: readonly { name: string; value: string }[]
): string {
  const lines: string[] = [urlPath];
  for (const header of spaHeaders) {
    lines.push(`  ! ${header.name}`);
  }
  for (const header of demoHeaders) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  return `${lines.join('\n')}\n`;
}

function formatSpaBlock(spaHeaders: readonly { name: string; value: string }[]): string {
  const lines: string[] = ['/*'];
  for (const header of spaHeaders) {
    lines.push(`  ${header.name}: ${header.value}`);
  }
  return `${lines.join('\n')}\n`;
}

function inlineHashesIntoSpaCsp(baseCsp: string, csp: PageCsp): string {
  const directives = baseCsp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  return directives
    .map((directive) => {
      if (directive.toLowerCase().startsWith('script-src')) {
        return appendHashes(directive, csp.scriptHashes);
      }
      return directive;
    })
    .join('; ');
}

function appendHashes(directive: string, hashes: readonly string[]): string {
  if (hashes.length === 0) return directive;
  return `${directive} ${hashes.join(' ')}`;
}

/**
 * HSTS for the admin origin. Two years, `includeSubDomains` — `admin.hushbox.ai`
 * is HTTPS-only behind Cloudflare Access, so a protocol-downgrade attempt must
 * never reach a plaintext admin login. No `preload`: submitting to the preload
 * list is an apex-domain decision, not a subdomain's to make from its `_headers`.
 */
const ADMIN_HSTS = 'max-age=63072000; includeSubDomains';

/**
 * Security headers for the admin SPA (`admin.hushbox.ai`). The admin app is
 * fully same-origin: it fetches only relative `/api/*` (routed to the product
 * Worker), loads no third-party scripts, no R2/blob media, and needs no WASM or
 * eval. So every fetch/asset directive collapses to `'self'` — the tightest CSP
 * that still runs the SPA, the SQL panel, and the Customer-360 fetches, which
 * are all same-origin XHR. Inline-script hashes are folded into `script-src` by
 * `generateAdminHeaders`.
 */
function buildAdminSpaHeaders(): readonly { name: string; value: string }[] {
  const csp =
    "default-src 'self'; " +
    // No 'unsafe-eval'/'wasm-unsafe-eval' (unlike the web SPA): admin bundles no
    // crypto/WASM and no eval-using deps. Only 'self' plus the pre-paint
    // inline-script hashes appended by generateAdminHeaders.
    "script-src 'self'; " +
    // 'unsafe-inline' for STYLES only — Tailwind's runtime style insertion and
    // inline style="" attributes; hashing styles would break Tailwind.
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "font-src 'self' data:; " +
    // Same-origin API only. The Vite dev/preview proxy also serves /api from the
    // page origin, so 'self' holds in dev, preview, and production alike.
    "connect-src 'self'; " +
    // Admin must never be framed — belt to X-Frame-Options: DENY's suspenders.
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'";
  return [
    { name: 'Content-Security-Policy', value: csp },
    { name: 'X-Content-Type-Options', value: 'nosniff' },
    { name: 'X-Frame-Options', value: 'DENY' },
    { name: 'Referrer-Policy', value: 'no-referrer' },
    { name: 'Strict-Transport-Security', value: ADMIN_HSTS },
  ];
}

const ADMIN_FILE_BANNER = `# Auto-generated by scripts/generate-headers.ts — do not edit by hand.
# Admin SPA (admin.hushbox.ai) security headers. Single /* block: the admin app
# is a standalone same-origin SPA, so there are no per-path CSP variants.
# Directive rationale lives in buildAdminSpaHeaders (scripts/generate-headers.ts).`;

export interface GenerateAdminHeadersOptions {
  /** Absolute path to the built admin dist directory (contains index.html). */
  readonly distDir: string;
  /** Override the output file (defaults to `<distDir>/_headers`). */
  readonly outputPath?: string;
}

export interface GenerateAdminHeadersResult {
  readonly outputPath: string;
}

/**
 * Emit `<distDir>/_headers` for the admin assets Worker. Reads the built admin
 * shell, folds its pre-paint inline-script SHA-256 hashes into `script-src`, and
 * writes a single `/*` block. Cloudflare Workers static assets honor `_headers`
 * the same way Pages does, so the assets-only admin Worker serves these headers
 * on every response. Wired into `apps/admin/vite.config.ts` as a build-time
 * plugin so a plain `vite build` produces the file alongside the bundle.
 */
export async function generateAdminHeaders(
  options: GenerateAdminHeadersOptions
): Promise<GenerateAdminHeadersResult> {
  const outputPath = options.outputPath ?? path.join(options.distDir, '_headers');
  const shellHtml = await readShellHtml(options.distDir, 'admin');
  const csp = computePageCsp(shellHtml);
  const headers = buildAdminSpaHeaders().map((header) =>
    header.name === 'Content-Security-Policy'
      ? { name: header.name, value: inlineHashesIntoSpaCsp(header.value, csp) }
      : header
  );
  const content = `${ADMIN_FILE_BANNER}\n${formatSpaBlock(headers)}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, 'utf8');
  return { outputPath };
}

/* v8 ignore start -- CLI entry point exercised via shell */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const result = await generateHeaders({ repoRoot });
    console.log(
      `Wrote ${result.outputPath} (${String(result.pagesProcessed)} marketing pages, ${String(
        result.blocksEmitted
      )} blocks)`
    );
  });
}
/* v8 ignore stop */
