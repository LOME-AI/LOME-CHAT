import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  test as base,
  expect as rawExpect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
  type Response,
  type Route,
  type APIRequestContext,
  type TestInfo,
} from '@playwright/test';
import { TEST_IDS } from '@hushbox/shared';
import { ChatPage } from './pages';
import { TIMEOUTS } from './config/timeouts.js';
import { requireEnv } from './helpers/env.js';
import { clearUsageRateLimits } from './helpers/auth.js';
import { withRequestRetry } from './helpers/resilient-request.js';
import { pooledPersonaName } from '../scripts/seed.js';
import {
  buildStorageInitScript,
  type RawStorageState,
} from '../scripts/storage-state-init-script.js';

const apiUrl = requireEnv('VITE_API_URL');

/**
 * Storage-state path for a persona, resolved to the current Playwright worker's
 * isolated copy (pooled personas alice/bob/dave — see `pooledPersonaName`). Two
 * parallel workers therefore authenticate as distinct users with distinct
 * wallets, so their chat-turn admission holds never contend (the chat-402 fix).
 */
function pooledStorageStatePath(baseName: string, testInfo: TestInfo): string {
  const persona = pooledPersonaName(baseName, testInfo.parallelIndex);
  return `e2e/.auth/${testInfo.project.name}/${persona}.json`;
}

/** Project- and worker-aware persona email, matching `pooledStorageStatePath`. */
function pooledPersonaEmail(baseName: string, testInfo: TestInfo): string {
  const persona = pooledPersonaName(baseName, testInfo.parallelIndex);
  return `${persona}-${testInfo.project.name}@test.hushbox.ai`;
}

/**
 * The backend host:port. Backend routes are bare (no `/api/` prefix) after the
 * rewrite, so "is this a backend request?" is decided by the API host:port —
 * localhost/127.0.0.1 on `HB_API_PORT` — not by a path substring. The same
 * host:port also serves the conversation WebSocket, so host-matching covers
 * both. Read once at module load (`requireEnv` fail-fasts if the stack env
 * wasn't generated).
 */
const apiPort = requireEnv('HB_API_PORT');
const API_REQUEST_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/**
 * Whether `url` is a backend (API/WebSocket) request: its host is
 * localhost/127.0.0.1 AND its port is `HB_API_PORT`. Pure and browser-free.
 * An unparseable URL is treated as not-backend.
 */
function isApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return API_REQUEST_HOSTS.has(parsed.hostname) && parsed.port === apiPort;
}

/**
 * `recordHar.urlFilter` matching backend traffic by the API origin
 * (`://localhost:<port>/` or `://127.0.0.1:<port>/`), built from `HB_API_PORT`
 * so worktree-offset ports stay correct without hardcoding. Covers `http(s)://`
 * and the `ws(s)://` WebSocket on the same host:port. `apiPort` is digits, so
 * it carries no regex metacharacters.
 */
const API_HAR_URL_FILTER = new RegExp(String.raw`://(?:localhost|127\.0\.0\.1):${apiPort}/`);

/**
 * Artifact policy mirrors `playwright.config.ts`: CI captures nothing, local
 * keeps what the e2e debug report consumes. HAR is a per-context network capture
 * the report attaches on failure (`har-<label>`), so it is recorded locally —
 * including under `e2e:fast` — and skipped only in CI. The in-memory console/API
 * error capture is always on regardless.
 */
const skipHar = !!process.env['CI'];

/**
 * The `recordHar` context option, or `undefined` in CI so no network capture is
 * recorded (mirrors the trace/screenshot gate in playwright.config.ts: CI keeps
 * no artifacts, local keeps what the debug report consumes). Returned spread into
 * `newContext({...})`; callers that gate HAR on a retry pass their own predicate
 * instead.
 */
function harOption(
  harPath: string
): { recordHar: { path: string; mode: 'minimal'; urlFilter: RegExp } } | undefined {
  if (skipHar) return undefined;
  return { recordHar: { path: harPath, mode: 'minimal', urlFilter: API_HAR_URL_FILTER } };
}

/**
 * Network `errorText` families for an in-flight load cancelled by navigation,
 * page close, or an `AbortController` — `net::ERR_ABORTED` (Chromium),
 * `NS_BINDING_ABORTED` / `NS_ERROR_DOM_BAD_URI` (Firefox — the latter is what
 * Firefox reports when a request is abandoned because the document began
 * unloading, e.g. a key prefetch firing as the page navigates away), and
 * `Load request cancelled` (WebKit). The single source of truth for "a dropped
 * load is teardown noise": the console correlation marks these requests' URLs
 * aborted, and `DEFAULT_API_ALLOW` derives its network-channel allowance from
 * the same list.
 */
const ABORT_ERROR_TEXTS = [
  'net::ERR_ABORTED',
  'NS_BINDING_ABORTED',
  'NS_ERROR_DOM_BAD_URI',
  'Load request cancelled',
];

/**
 * Per page: the resource URLs the network layer reported as aborted. Teardown
 * cross-references these against each captured console error's source URL (its
 * {@link ConsoleEntry}) to drop the resource-load console error an engine emits
 * for a cancelled load — browser-agnostically, keyed on the abort *fact* rather
 * than each engine's console prose (a Firefox font download, a script, a
 * stylesheet). A genuine 404/5xx/decode failure never produces a
 * `requestfailed` abort, so it still surfaces.
 */
const abortedResourceUrls = new WeakMap<Page, Set<string>>();

/**
 * A captured console error and the `location().url` it came from (`''` for an
 * uncaught page error). Text and source travel together so the abort
 * correlation never has to index two parallel arrays.
 */
interface ConsoleEntry {
  text: string;
  url: string;
}

function attachConsoleErrors(page: Page): { entries: ConsoleEntry[]; cleanup: () => void } {
  const entries: ConsoleEntry[] = [];
  const aborted = new Set<string>();
  abortedResourceUrls.set(page, aborted);
  const onConsole = (msg: {
    type: () => string;
    text: () => string;
    location: () => { url: string };
  }): void => {
    if (msg.type() !== 'error') return;
    entries.push({ text: msg.text(), url: msg.location().url });
  };
  const onPageError = (err: Error): void => {
    entries.push({ text: `[UNCAUGHT] ${err.message}`, url: '' });
  };
  const onRequestFailed = (request: Request): void => {
    const errorText = request.failure()?.errorText ?? '';
    if (ABORT_ERROR_TEXTS.some((token) => errorText.includes(token))) {
      aborted.add(request.url());
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  return {
    entries,
    cleanup: () => {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
      abortedResourceUrls.delete(page);
    },
  };
}

const API_ERROR_BODY_CAP = 2000;

/**
 * Capture backend responses (API host:port, see {@link isApiUrl}) with status
 * >= 400 and network-level request failures. Body fetch is wrapped in
 * try/catch because streaming responses
 * (SSE) can't be re-read after the fact and `response.text()` rejects.
 * Mirror of `attachConsoleErrors` — same lifecycle, same attach pattern on
 * test failure, surfaced as `api-errors-<label>` test attachment.
 *
 * `extraApiUrl` widens the capture to an additional API origin the default
 * predicate can't see — the admin SPA's `/api` vite proxy, where browser-side
 * admin API traffic carries the admin dev-server host:port, not `HB_API_PORT`.
 */
function attachApiErrors(
  page: Page,
  extraApiUrl?: (url: string) => boolean
): { errors: string[]; cleanup: () => void } {
  const errors: string[] = [];
  const isCapturedApiUrl = (url: string): boolean => isApiUrl(url) || extraApiUrl?.(url) === true;
  const recordResponse = async (response: Response): Promise<void> => {
    const url = response.url();
    if (!isCapturedApiUrl(url)) return;
    const status = response.status();
    if (status < 400) return;
    const time = new Date().toISOString();
    const method = response.request().method();
    // Streaming responses (SSE) can't be re-read after the fact and
    // `response.text()` rejects; swallow that into an empty body.
    const body = await response.text().catch(() => '');
    const trimmed = body ? `\n  body: ${body.slice(0, API_ERROR_BODY_CAP)}` : '';
    errors.push(`${time} ${String(status)} ${response.statusText()} ${method} ${url}${trimmed}`);
  };
  const onResponse = (response: Response): void => {
    void recordResponse(response);
  };
  const onRequestFailed = (request: Request): void => {
    const url = request.url();
    if (!isCapturedApiUrl(url)) return;
    const failure = request.failure();
    errors.push(
      `${new Date().toISOString()} NETWORK_FAILED ${request.method()} ${url} — ${failure?.errorText ?? 'unknown'}`
    );
  };
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    errors,
    cleanup: () => {
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

/**
 * Network allowlist. The browser may only reach the
 * services the suite legitimately uses; any request to a non-allowlisted host
 * is a live third-party leaking into the hot path.
 *
 * Allowlisted hosts are `localhost`/`127.0.0.1` on the ports the dev stack
 * exposes — the app (preview + vite), the API (which also serves the WebSocket
 * on the same host:port), and MinIO (the R2/S3 emulator the browser hits
 * directly via presigned media URLs). Ports are read from the same `HB_*_PORT`
 * env the Playwright config and dev scripts use, so worktree-offset ports stay
 * correct without hardcoding `:4173`/`:8788`/`:9000`.
 *
 * `data:`/`blob:` schemes are always allowed — they are in-document media
 * (canvas blobs, decoded images) with no network egress.
 *
 * With the model catalog pinned, the AI gateway
 * (`ai-gateway.vercel.sh`) is never reached, so it is deliberately NOT
 * allowlisted: a request to it must fail the test.
 */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);
const ALWAYS_ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'blob:']);

/**
 * Ports of the local services the browser legitimately reaches. Read once at
 * module load. `requireEnv` fail-fasts if the stack env wasn't generated —
 * matching the rest of the suite, which assumes `ensure-stack` ran first.
 *
 * - preview/vite: the app origin (`vite preview` serves E2E; vite dev exists
 *   for parity and worktree port-mapping).
 * - api: REST endpoints AND the conversation WebSocket (same host:port,
 *   `ws://` scheme — host-matching covers both).
 * - minio: the R2/S3 emulator; presigned GET URLs are fetched by the browser.
 * - admin: the admin SPA dev server (the admin project's page origin); its
 *   `/api/*` vite proxy is also the admin suite's browser-side API origin.
 */
function allowedLocalPorts(): ReadonlySet<string> {
  return new Set([
    requireEnv('HB_PREVIEW_PORT'),
    requireEnv('HB_VITE_PORT'),
    requireEnv('HB_API_PORT'),
    requireEnv('HB_MINIO_API_PORT'),
    requireEnv('HB_ADMIN_PORT'),
  ]);
}

const LOCAL_PORTS = allowedLocalPorts();

/**
 * Whether `hostname` falls under one of the opt-in domains: an exact match or
 * a subdomain. Matched on a leading-dot boundary (`host === domain` or
 * `host.endsWith('.' + domain)`) rather than a naive substring/`includes`, so
 * a look-alike like `evil-myhelcim.com.attacker.com` can never pass.
 */
function hostUnderExtraDomains(hostname: string, extraHosts: ReadonlySet<string>): boolean {
  for (const domain of extraHosts) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

/**
 * Decide whether a single request URL is allowed. Pure so the allow/deny
 * decision is testable without a browser. `extraHosts` carries the per-test
 * opt-in extension (real-payment billing tests — see `allowExternalHosts`);
 * an entry there is a domain family matched by suffix (the domain or any
 * subdomain of it), on any port. The default local allowlist below stays
 * exact-host: localhost/127.0.0.1 only, and only on the dev-stack ports.
 */
export function isRequestAllowed(url: string, extraHosts: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A URL Playwright can't parse can't be a legitimate egress we recognize.
    return false;
  }
  if (ALWAYS_ALLOWED_PROTOCOLS.has(parsed.protocol)) return true;
  if (hostUnderExtraDomains(parsed.hostname, extraHosts)) return true;
  return ALLOWED_HOSTNAMES.has(parsed.hostname) && LOCAL_PORTS.has(parsed.port);
}

/**
 * Domain families the real-payment ("Payment Flow (Full)" / token-portal)
 * billing tests legitimately reach — the ONLY sanctioned external egress.
 * Each entry is matched by suffix (the domain itself or any
 * subdomain — see `hostUnderExtraDomains`), so the whole `*.myhelcim.com` /
 * `*.helcim.com` family is covered: Helcim.js tokenizes the card in-browser
 * (e.g. `secure.myhelcim.com`) and in CI may call other Helcim gateway
 * sub-hosts during tokenization, none of which can be enumerated up front.
 * The Hookdeck webhook relay is server-side (CLI tunnel → localhost:API), but
 * its family is included so a browser-side Hookdeck call (should the flow ever
 * make one) is not a false positive. Listed as family roots only; subdomains
 * are implied by the suffix match. Locally these tests use a mock Helcim, so
 * this opt-in is a no-op there and the suite stays strict.
 */
const BILLING_EXTERNAL_HOSTS: readonly string[] = ['myhelcim.com', 'helcim.com', 'hookdeck.com'];

const pageExtraHosts = new WeakMap<Page, Set<string>>();

function getExtraHosts(page: Page): Set<string> {
  let hosts = pageExtraHosts.get(page);
  if (hosts === undefined) {
    hosts = new Set();
    pageExtraHosts.set(page, hosts);
  }
  return hosts;
}

/**
 * Opt a page into reaching external hosts that the test legitimately needs.
 * Defaults to the sanctioned billing payment hosts (Helcim + Hookdeck) when
 * called with no list. Call BEFORE any navigation that could trigger the
 * external request (e.g. at the top of the test, before `goto`), because the
 * allowlist route consults this set at request time.
 *
 * This is a sanctioned exception, not an escape hatch: only the
 * real-payment billing tests should call it. Everything else stays strict so
 * a stray live third-party in the hot path fails the test.
 *
 * The real-payment billing tests are also opted in automatically by their
 * `@webhook` tag (see `installNetworkAllowlist`), so they need no explicit
 * call; this export exists for any future test with a different external edge.
 */
export function allowExternalHosts(
  page: Page,
  hosts: readonly string[] = BILLING_EXTERNAL_HOSTS
): void {
  const set = getExtraHosts(page);
  for (const host of hosts) set.add(host);
}

/**
 * Tag that marks the real-payment billing tests (`Payment Flow (Full)` and the
 * token-login portal). They drive the real Helcim → Hookdeck path in CI, so
 * pages created under them are auto-opted into the billing external hosts.
 * Locally these tests use a mock Helcim and reach no external host, so the
 * extension is a harmless no-op there.
 */
const WEBHOOK_TAG = '@webhook';

interface NetworkViolation {
  host: string;
  url: string;
}

/**
 * Install the allowlist on a browser context. Every request is matched against
 * the allowlist; allowed requests continue untouched, blocked requests are
 * recorded and aborted. Returns the violations array (asserted empty at
 * teardown) and a cleanup that removes the route.
 *
 * Violations are collected explicitly here rather than read off the
 * `requestfailed` channel: aborting produces a `net::ERR_FAILED`/`ABORTED`
 * that is indistinguishable from the navigation-cancel noise already allowed
 * in `DEFAULT_API_ALLOW`. Collecting the host+URL at the decision point makes
 * the teardown failure precise and unambiguous.
 */
function installNetworkAllowlist(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo
): { violations: NetworkViolation[]; cleanup: () => Promise<void> } {
  if (testInfo.tags.includes(WEBHOOK_TAG)) {
    allowExternalHosts(page);
  }
  const violations: NetworkViolation[] = [];
  const handler = async (route: Route): Promise<void> => {
    const url = route.request().url();
    if (isRequestAllowed(url, getExtraHosts(page))) {
      await route.continue();
      return;
    }
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url as the host label when it can't be parsed
    }
    violations.push({ host, url });
    await route.abort();
  };
  void context.route('**/*', handler);
  return {
    violations,
    cleanup: () => context.unroute('**/*', handler),
  };
}

/**
 * Joiner per labeled-artifact prefix. `api-errors` uses a blank line between
 * entries because each entry can include a multi-line response body that
 * would visually merge into the next entry under a single `\n`.
 */
const ARTIFACT_JOINER: Record<'console-errors' | 'api-errors', string> = {
  'console-errors': '\n',
  'api-errors': '\n\n',
};

/**
 * Per-page opt-out lists for tests that intentionally provoke console/API
 * errors. By default, any uncaught console error or unsuccessful API response
 * fails the test at teardown — this catches regressions like the chat stream
 * parse failure and the `/chat/new` 404 prefetch without per-test boilerplate.
 *
 * Tests that need to allow specific patterns call `expectConsoleErrors(page, [...])`
 * or `expectApiErrors(page, [...])`. WeakMap keying means the lists are
 * garbage-collected with the page itself.
 */
interface AllowList {
  console: RegExp[];
  api: RegExp[];
}
const pageAllowList = new WeakMap<Page, AllowList>();

function getAllowList(page: Page): AllowList {
  let list = pageAllowList.get(page);
  if (list === undefined) {
    list = { console: [], api: [] };
    pageAllowList.set(page, list);
  }
  return list;
}

function toRegExp(pattern: string | RegExp): RegExp {
  return typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
}

/**
 * Opt a page out of failing on console errors that the test **purposely**
 * provokes — e.g. a wrong-password assertion that surfaces a friendly error
 * banner, or a test that revokes a share link and then visits it.
 *
 * Do NOT use this to hide real application problems (accessibility hints,
 * `setState`-in-render warnings, hydration errors, etc.). Those should
 * surface as failures so they get fixed at the source. If a console error
 * fires on a test that isn't intentionally producing it, the right move is
 * to fix the app code, not to suppress the warning here.
 *
 * Patterns match each captured console line independently. Pass substrings
 * (matched case-insensitively) or RegExps. Call before any action that
 * might produce the error.
 */
export function expectConsoleErrors(page: Page, patterns: (string | RegExp)[]): void {
  const list = getAllowList(page);
  list.console.push(...patterns.map((p) => toRegExp(p)));
}

/**
 * Opt a page out of failing on API errors that the test **purposely**
 * provokes — e.g. a test that posts an invalid TOTP code and asserts the
 * 400 response, or a test that fetches a deliberately-nonexistent share
 * link and asserts the 404.
 *
 * Do NOT use this to hide real application problems (unexpected 4xx/5xx
 * responses from endpoints the test isn't deliberately exercising). Those
 * should surface as failures. Match precisely on `<status> <method> <url>`
 * (and optionally the body's `code`) so the opt-out can only mask the
 * exact request the test is asserting against — not other failures on the
 * same page.
 *
 * Patterns match each captured error line independently. Each line
 * includes the status code, method, URL, and (when re-readable) body.
 * Call before any action that might produce the error.
 */
export function expectApiErrors(page: Page, patterns: (string | RegExp)[]): void {
  const list = getAllowList(page);
  list.api.push(...patterns.map((p) => toRegExp(p)));
}

/**
 * Universally-allowed API errors. The navigation-cancel families come straight
 * from the single {@link ABORT_ERROR_TEXTS} source the console correlation also
 * keys on — a request dropped because the page navigated, closed, or its
 * `AbortController` fired is teardown noise on both channels, never an app
 * concern. (`ABORT_ERROR_TEXTS` entries are fixed literals with no regex
 * metacharacters, so they interpolate directly.)
 */
const DEFAULT_API_ALLOW: RegExp[] = [
  ...ABORT_ERROR_TEXTS.map((text) => new RegExp(`NETWORK_FAILED .* — ${text}`)),
  // A workerd/wrangler worker restart under host saturation answers an in-flight
  // request with a bare, CORS-headerless 503 — the runtime envelope, not an app
  // response — which fails the fetch at the network layer. Each engine names the
  // CORS block differently (Chromium "Preflight response is not successful",
  // WebKit "Origin … is not allowed by Access-Control-Allow-Origin"), so this
  // keys on the shared 503 fact, not the prose. Reads recover via the app-wide
  // query retry; the failed attempt is still logged. Scoped to 503 so a genuine
  // app/CORS 4xx still fails. See e2e/CLAUDE.md rule 2.10 (surface, not fail).
  /NETWORK_FAILED .* — .*Status code: 503/,
  // A transient network-level drop of an idempotent GET read (a workerd recycle
  // or a navigation-cancel under saturation severs the socket before any
  // response). The app's TanStack Query layer retries reads and recovers, so the
  // data still loads — and a read that genuinely never loads fails the test's own
  // assertion (the awaited message/element never appears). Scoped to GET so a
  // dropped mutation (non-idempotent, not auto-retried) still surfaces. Keyed on
  // the method + API host:port fact (backend routes are bare — no `/api/`
  // prefix), independent of each engine's errorText prose. Built from
  // `HB_API_PORT` so worktree-offset ports stay correct.
  new RegExp(String.raw`NETWORK_FAILED GET .*(?:localhost|127\.0\.0\.1):${apiPort}/`),
  // The same saturation sever on a *mutation*, where the socket drops with a
  // bare connection-failure errorText (no status reaches the client, so this is
  // distinct from the 503 envelope above). Every mutation is idempotent
  // (Idempotency-Key required; conversation create is keyed on a client-minted
  // id, the chat turn on an Idempotency-Key, and the stream POST re-issues on a
  // transport drop), so a severed attempt is reconciled by a retry or a
  // concurrent idempotent attempt — and a mutation whose effect genuinely never
  // lands fails the test's own assertion (no conversation row, no AI response).
  // Unlike the GET rule this is errorText-keyed, not method-keyed: a sever is
  // tolerated, but a real mutation 4xx/5xx still arrives on its own
  // status-bearing line and surfaces. Chromium reports the sever as
  // `net::ERR_FAILED`; other engines' equivalents join here when observed.
  /NETWORK_FAILED .* — net::ERR_FAILED/,
];

/**
 * Universally-allowed console errors:
 *
 * 1. WebKit's local-network gating on iOS surfaces blocked fetches to
 *    `localhost`/private addresses as a `pageerror`
 *    (`<url> due to access control checks.`) even when the request ultimately
 *    succeeds via Playwright's request routing. Production never serves the
 *    app from localhost, so this pattern cannot mask a real cross-origin bug
 *    — it is a Playwright-on-WebKit artifact.
 *
 * 2. `Viewport argument key "interactive-widget" not recognized and ignored.`
 *    — the SPA's viewport meta sets `interactive-widget=resizes-content` for
 *    Android keyboard handling; WebKit doesn't recognize the Chrome-only
 *    attribute and logs a console.error on every page load. Real noise on
 *    every iphone-15/webkit test.
 *
 * 3. `[astro-island] Error hydrating /_astro/<chunk>.js TypeError: Importing a
 *    module script failed.` — WebKit (desktop Safari + iPhone-15) rejects
 *    in-flight dynamic `import()` calls when the page begins unloading. Tests
 *    that land on the Astro marketing site and then navigate away (e.g.
 *    post-delete-account → /welcome → /login) cancel hydration mid-flight,
 *    and Astro's hydration runner surfaces the rejection as a console error.
 *    Chromium and Firefox swallow the same rejection silently. The chunks
 *    load cleanly when the page stays put — see `marketing-roadmap.spec.ts`.
 *    Pure WebKit artifact, not a real hydration failure.
 */
const DEFAULT_CONSOLE_ALLOW: RegExp[] = [
  /\[UNCAUGHT\] (https?:)?\/\/?(localhost|127\.0\.0\.1|0\.0\.0\.0)[:/].*due to access control checks\.?/,
  /Viewport argument key "interactive-widget" not recognized and ignored\./,
  /\[astro-island\] Error hydrating .*TypeError: Importing a module script failed/,
  // The saturation 503 envelope, console side: a workerd recycle answers a
  // cross-origin /api request with a bare response lacking CORS headers, so the
  // browser blocks it and logs a cross-origin error. Each engine phrases it
  // differently — Chromium "has been blocked by CORS policy: No
  // 'Access-Control-Allow-Origin' header", Firefox "Cross-Origin Request
  // Blocked", WebKit "Origin … is not allowed by Access-Control-Allow-Origin",
  // and the Chromium preflight variant "Preflight response is not successful".
  // Keyed on the CORS-block fact across engines, NOT on a status code (Chromium's
  // message carries none). Safe to drop the 503 scope: the app sets CORS headers
  // on every real response, so a genuine CORS regression blocks every
  // cross-origin request and fails the whole suite at once — never
  // intermittently. The query layer retries and recovers.
  /has been blocked by CORS policy|Cross-Origin Request Blocked|is not allowed by Access-Control-Allow-Origin|Preflight response is not successful/,
  // Chromium's companion failed-load line for the same blocked fetch — a
  // network-level failure, not an app status. A real 4xx/5xx logs "responded
  // with a status of N" instead and still surfaces.
  /Failed to load resource: net::ERR_FAILED/,
  // Firefox's network-level companion when the 503 severs the socket outright:
  // the CORS request "did not succeed" with a "(null)" status.
  /Cross-Origin Request Blocked: .*CORS request did not succeed\)\. Status code: \(null\)\./,
  // ResizeObserver "loop" notices are a benign browser frame-budget artifact: a
  // ResizeObserver callback mutated layout and the browser deferred the
  // remaining notifications to the next frame (it self-heals — they are
  // delivered then). It is never an app fault, but a host-saturated, starved
  // frame makes it fire far more often, turning any test into a flake. Both the
  // modern Chromium phrasing ("completed with undelivered notifications") and
  // the legacy one ("loop limit exceeded") are the same benign condition. A real
  // infinite resize loop would instead manifest as the tested UI never settling,
  // which the test's own assertions catch.
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/,
  // A WebSocket upgrade to the dev realtime endpoint
  // (ws://localhost:<api>/conversations/<id>/websocket or /chat/trial/websocket)
  // can be rejected once before the client reconnects: a link-guest socket races
  // ahead of its principal/access resolving (a 401), or a workerd recycle under
  // saturation drops the in-flight upgrade. The client reconnects and realtime
  // recovers; the browser still logs the one rejected upgrade — and each engine
  // phrases it differently (Chromium "WebSocket connection to … failed: …",
  // Firefox "Firefox can't establish a connection to the server at …"). Keyed on
  // the *fact* that the line names the dev websocket URL rather than any engine's
  // prose — the same browser-agnostic principle as the abort correlation. The
  // only console lines that carry that URL are WS connection failures, and a
  // genuine realtime regression still fails via the realtime assertions that
  // depend on a live socket (a dead socket never delivers the awaited frame), so
  // this backstop is redundant for real breakage.
  /wss?:\/\/(?:localhost|127\.0\.0\.1):\d+\/(?:conversations\/[0-9a-f-]+|chat\/trial)\/websocket/,
  // Firefox logs a console error when an `@font-face` download is cancelled by a
  // navigation that fires while the font is still in flight (status 2152398850 =
  // NS_BINDING_ABORTED). This is the same navigation-cancel class the
  // abort-correlation below already drops for tracked requests — but CSS-engine
  // font loads don't surface as Playwright `requestfailed` events, so they can't
  // be correlated by URL and slip through. Host saturation widens the
  // font-in-flight-at-navigation window, so a navigation away from a page that
  // is still loading a dev-served font (e.g. the marketing site's JetBrains
  // Mono) can cancel the download. The font falls back to the system monospace;
  // nothing functional breaks. Scoped to a local dev-served font, so a
  // missing/renamed font (a deterministic 404, caught by the marketing render
  // tests) is not masked.
  /downloadable font: download failed.*source: https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^"']*\.woff2?/,
  // Streamdown's code plugin calls Shiki to highlight code blocks and logs
  // `[Streamdown Code] Failed to highlight code: <err>` when a highlight throws.
  // The app already wraps the plugin (createSafeCodePlugin) to short-circuit
  // unsupported/partial languages, but Shiki loads grammars+theme as async WASM,
  // and under host saturation that work is starved and can throw transiently for
  // a supported language too — the base plugin logs from inside its own call, so
  // the wrapper can't intercept it. The block falls back to unhighlighted text;
  // nothing functional breaks. A real misconfiguration would fail every render
  // (caught by the code-block render tests), not intermittently under load.
  /\[Streamdown Code\] Failed to highlight code:/,
];

function filterUnexpected(captured: string[], allowed: RegExp[]): string[] {
  return captured.filter((line) => !allowed.some((pattern) => pattern.test(line)));
}

/**
 * A console error is navigation-cancel noise when it refers to a resource the
 * network layer reported as aborted — by its `location().url` (`source`) or by
 * a URL embedded in the message (Firefox's font error carries `source: <url>`).
 * The cross-browser counterpart of `DEFAULT_API_ALLOW`'s network-abort
 * families: it suppresses the resource-load console error any engine emits for
 * a load cancelled by navigation/teardown, without a per-engine regex.
 */
function isAbortedResourceError(line: string, source: string, abortedUrls: Set<string>): boolean {
  if (source !== '' && abortedUrls.has(source)) return true;
  for (const url of abortedUrls) {
    if (line.includes(url)) return true;
  }
  return false;
}

/**
 * Console error texts for `page` minus the resource-load errors whose
 * underlying request the network layer reported as aborted (the page
 * navigated/closed mid-load) — the browser-agnostic counterpart of
 * `DEFAULT_API_ALLOW`'s abort families. Each {@link ConsoleEntry} carries its
 * own source URL, so no parallel-array indexing is involved.
 */
function dropAbortedResourceErrors(page: Page, entries: ConsoleEntry[]): string[] {
  const aborted = abortedResourceUrls.get(page);
  if (!aborted || aborted.size === 0) return entries.map((entry) => entry.text);
  return entries
    .filter((entry) => !isAbortedResourceError(entry.text, entry.url, aborted))
    .map((entry) => entry.text);
}

/**
 * Attach a labeled text artifact (`console-errors-<label>`, `api-errors-<label>`)
 * to the failing test. Skips attachment when there are no errors — Playwright
 * shows empty attachments which clutter the report. Used by every page-creating
 * fixture so the attach shape stays uniform across labels.
 */
async function attachLabeledArtifact(
  testInfo: TestInfo,
  prefix: 'console-errors' | 'api-errors',
  label: string,
  errors: string[]
): Promise<void> {
  if (errors.length === 0) return;
  await testInfo.attach(`${prefix}-${label}`, {
    body: errors.join(ARTIFACT_JOINER[prefix]),
    contentType: 'text/plain',
  });
}

type StorageState = NonNullable<BrowserContextOptions['storageState']>;
type StorageStateObject = Exclude<StorageState, string>;
type FixtureSpec = { persona: string } | { state: StorageState };

/**
 * Strip `origins` (localStorage entries) out of a storage state JSON and
 * return them as an equivalent `addInitScript` body. The default Playwright
 * behavior — apply origins by navigating the new context to each origin and
 * waiting for `load` — is the bottleneck in firefox `browser.newContext`
 * and the root cause of Group C fixture timeouts. Init scripts run before
 * any page script on every navigation, so the localStorage values are in
 * place by the time React boots, identical observable behavior at a
 * fraction of the cost.
 */
// Cache the read + parse + init-script build per persona path — the JSON is
// fixed for the run, and Playwright treats the result as read-only.
const contextOptionsCache = new Map<string, { state: StorageState; initScript: string | null }>();

async function buildContextOptions(
  storageState: StorageState
): Promise<{ state: StorageState; initScript: string | null }> {
  if (typeof storageState !== 'string') {
    return { state: storageState, initScript: null };
  }
  const cached = contextOptionsCache.get(storageState);
  if (cached !== undefined) return cached;
  const raw = JSON.parse(await readFile(storageState, 'utf8')) as RawStorageState;
  const initScript = buildStorageInitScript(raw);
  const result =
    initScript === null
      ? { state: storageState, initScript: null }
      : {
          state: { cookies: raw.cookies as StorageStateObject['cookies'], origins: [] },
          initScript,
        };
  contextOptionsCache.set(storageState, result);
  return result;
}

function createPageFixture(
  spec: FixtureSpec,
  label: string
): (
  deps: { browser: Browser },
  use: (page: Page) => Promise<void>,
  testInfo: TestInfo
) => Promise<void> {
  return async ({ browser }, use, testInfo) => {
    const harPath = testInfo.outputPath(`${label}.har`);
    const storageState =
      'persona' in spec ? pooledStorageStatePath(spec.persona, testInfo) : spec.state;
    const { state, initScript } = await buildContextOptions(storageState);
    // Record HAR on every attempt — `attachFailureArtifacts` only attaches it
    // when the attempt fails, so a flaky test's first (failing) attempt has
    // network data in the report instead of only the retry that passed.
    const context = await browser.newContext({
      storageState: state,
      ...harOption(harPath),
    });
    if (initScript !== null) await context.addInitScript({ content: initScript });
    const page = await context.newPage();
    const { entries, cleanup } = attachConsoleErrors(page);
    const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
    const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
      context,
      page,
      testInfo
    );
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      {
        page,
        context,
        label,
        entries,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      },
      failed,
      testInfo
    );
  };
}

interface TestConversation {
  id: string;
  url: string;
}

interface GroupConversation {
  id: string;
  members: { userId: string; username: string; email: string }[];
}

interface MultiModelConversation {
  id: string;
  url: string;
}

interface MediaConversation {
  conversationId: string;
  assistantMessageId: string;
  page: Page;
}

/** Seed a finished image/video turn via the dev endpoint; returns its ids. */
async function seedMediaConversation(
  request: APIRequestContext,
  testInfo: TestInfo,
  mediaType: 'image' | 'video',
  userContent: string
): Promise<{ conversationId: string; assistantMessageId: string }> {
  const ownerEmail = pooledPersonaEmail('test-alice', testInfo);
  const response = await request.post('/dev/media-conversation', {
    data: { ownerEmail, userContent, mediaType },
  });
  rawExpect(
    response.ok(),
    `${mediaType} conversation creation failed: ${String(response.status())}`
  ).toBe(true);
  return (await response.json()) as { conversationId: string; assistantMessageId: string };
}

export interface CustomFixtures {
  /**
   * Auto-fixture: clears per-user usage rate-limit buckets (chat stream,
   * media download, share creation) at the start of every test. Stops late
   * tests in a worker from hitting 429s caused by prior tests reusing the
   * same test user. Trial IP limits are deliberately not cleared so that
   * `trial-chat.spec.ts` continues to exercise the trial cap firing.
   *
   * Returns `null` (and the fixture value is never read) — Playwright requires
   * a defined return type, and `void` is reserved for function return types.
   */
  resetRateLimitsAutoHook: null;
  authenticatedPage: Page;
  unauthenticatedPage: Page;
  /** Factory for creating fresh, fully-instrumented browser contexts on demand.
   *  Each page gets HAR recording, console error capture, and page snapshot on failure.
   *  Defaults to empty storage state (unauthenticated). Pass a storage state path for auth. */
  createPage: (storageState?: StorageState) => Promise<Page>;
  testConversation: TestConversation;
  multiModelConversation: MultiModelConversation;
  /** Authenticated conversation with one finished image generation. */
  imageConversation: MediaConversation;
  /** Authenticated conversation with one finished video generation. */
  videoConversation: MediaConversation;
  /** Authenticated low-balance user (~$0.01) for affordability error testing. */
  lowBalancePage: Page;
  authenticatedRequest: APIRequestContext;
  test2FAPage: Page;
  billingSuccessPage: Page;
  billingSuccessPage2: Page;
  billingFailurePage: Page;
  billingValidationPage: Page;
  billingDevModePage: Page;
  billingTokenRequest: APIRequestContext;
  groupConversation: GroupConversation;
  testBobPage: Page;
  testDavePage: Page;
  testBobRequest: APIRequestContext;
}

export interface CustomWorkerFixtures {
  /**
   * Request context reused by `resetRateLimitsAutoHook`, built once per worker so
   * each test pays only the DELETE. Request contexts hold no isolation state.
   */
  rateLimitResetRequest: APIRequestContext;
}

async function zeroLowBalanceWallets(
  requestContext: APIRequestContext,
  email: string
): Promise<void> {
  // Zero both wallets so the user is on the free tier with no allowance —
  // every preflight cost trips `insufficient_free_allowance` denial.
  await requestContext.post('/dev/wallet-balance', {
    data: { email, walletType: 'purchased', balance: '0.00000000' },
  });
  await requestContext.post('/dev/wallet-balance', {
    data: { email, walletType: 'free_tier', balance: '0.00000000' },
  });
}

function formatUnexpectedErrors(
  title: string,
  label: string,
  unexpectedConsole: string[],
  unexpectedApi: string[]
): string {
  const sections: string[] = [];
  if (unexpectedConsole.length > 0) {
    sections.push(`Console:\n  ${unexpectedConsole.join('\n  ')}`);
  }
  if (unexpectedApi.length > 0) {
    sections.push(`API:\n  ${unexpectedApi.join('\n  ')}`);
  }
  return (
    `Unexpected errors during test "${title}" (page "${label}"):\n${sections.join('\n')}\n\n` +
    `If these are expected, opt out with expectConsoleErrors(page, [...]) / expectApiErrors(page, [...]).`
  );
}

/**
 * Format the network-allowlist violation message. Distinct from the
 * console/API teardown failure so a live-third-party-in-the-hot-path breach
 * reads unambiguously and points at the opt-in escape hatch for the
 * legitimate-external case.
 */
function formatNetworkViolations(
  title: string,
  label: string,
  violations: NetworkViolation[]
): string {
  const lines = violations.map((v) => `  ${v.host} — ${v.url}`);
  return (
    `Blocked non-allowlisted network request(s) during test "${title}" (page "${label}").\n` +
    `The E2E suite may only reach the local app/api/ws/minio origins:\n` +
    `${lines.join('\n')}\n\n` +
    `If a host is legitimate, add it to the allowlist in fixtures.ts; if it is the ` +
    `sanctioned billing payment edge, opt in with allowExternalHosts(page).`
  );
}

async function attachFailureArtifacts(
  testInfo: TestInfo,
  entry: {
    page: Page;
    label: string;
    entries: ConsoleEntry[];
    apiErrors: string[];
    harPath: string;
  }
): Promise<void> {
  await attachLabeledArtifact(
    testInfo,
    'console-errors',
    entry.label,
    entry.entries.map((e) => e.text)
  );
  await attachLabeledArtifact(testInfo, 'api-errors', entry.label, entry.apiErrors);
  const snapshot = await entry.page
    .locator(':root')
    .ariaSnapshot()
    .catch(() => null);
  if (snapshot) {
    await testInfo.attach(`page-snapshot-${entry.label}`, {
      body: snapshot,
      contentType: 'text/yaml',
    });
  }
  if (existsSync(entry.harPath)) {
    await testInfo.attach(`har-${entry.label}`, {
      path: entry.harPath,
      contentType: 'application/json',
    });
  }
}

interface PageTeardownEntry {
  page: Page;
  context: BrowserContext;
  label: string;
  entries: ConsoleEntry[];
  apiErrors: string[];
  violations: NetworkViolation[];
  cleanup: () => void;
  cleanupApi: () => void;
  cleanupNetwork: () => Promise<void>;
  harPath: string;
}

async function teardownPage(
  entry: PageTeardownEntry,
  failed: boolean,
  testInfo: TestInfo
): Promise<void> {
  // Promote captured errors to test assertions when the test would otherwise
  // pass. Tests opt-out per-page via `expectConsoleErrors` / `expectApiErrors`.
  const allowList = getAllowList(entry.page);
  const consoleLines = dropAbortedResourceErrors(entry.page, entry.entries);
  const unexpectedConsole = filterUnexpected(consoleLines, [
    ...DEFAULT_CONSOLE_ALLOW,
    ...allowList.console,
  ]);
  const unexpectedApi = filterUnexpected(entry.apiErrors, [...DEFAULT_API_ALLOW, ...allowList.api]);
  const hasViolations = entry.violations.length > 0;
  const hasUnexpected = unexpectedConsole.length > 0 || unexpectedApi.length > 0 || hasViolations;

  if (failed || hasUnexpected) {
    await attachFailureArtifacts(testInfo, entry);
  }
  await entry.cleanupNetwork();
  entry.cleanup();
  entry.cleanupApi();
  await entry.context.close();

  if (!failed && hasViolations) {
    throw new Error(formatNetworkViolations(testInfo.title, entry.label, entry.violations));
  }
  if (!failed && (unexpectedConsole.length > 0 || unexpectedApi.length > 0)) {
    throw new Error(
      formatUnexpectedErrors(testInfo.title, entry.label, unexpectedConsole, unexpectedApi)
    );
  }
}

/**
 * Instrument an externally-created page (one the harness did not build via
 * `createPageFixture` — e.g. the admin suite's `adminPage`, which rides the
 * built-in `page` fixture to keep the project's baseURL/device options) with
 * the same per-page guardrails every harness page gets: console-error
 * capture, unexpected-API-≥400 capture (the default API origin plus any
 * `extraApiUrl` origin, such as the admin SPA's `/api` proxy), the network
 * allowlist, and failure artifacts.
 *
 * Call before the page's first navigation. `finish()` must run after `use()`:
 * it detaches the listeners, closes the context, attaches failure artifacts,
 * and promotes captured errors to test failures exactly like the harness-owned
 * page fixtures (opt-outs via `expectConsoleErrors` / `expectApiErrors` apply).
 */
export function instrumentPage(
  context: BrowserContext,
  page: Page,
  testInfo: TestInfo,
  options: { label: string; extraApiUrl?: (url: string) => boolean }
): { finish: () => Promise<void> } {
  const { entries, cleanup } = attachConsoleErrors(page);
  const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page, options.extraApiUrl);
  const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(context, page, testInfo);
  return {
    finish: async () => {
      const failed = testInfo.status !== testInfo.expectedStatus;
      await teardownPage(
        {
          page,
          context,
          label: options.label,
          entries,
          apiErrors,
          violations,
          cleanup,
          cleanupApi,
          cleanupNetwork,
          // No HAR: the context was created by Playwright's built-in fixture,
          // which records none; teardown skips a missing path.
          harPath: '',
        },
        failed,
        testInfo
      );
    },
  };
}

export const test = base.extend<CustomFixtures, CustomWorkerFixtures>({
  // Wrap the built-in request context once so every node-side API call retries a
  // transient saturation sever (5xx envelope or socket drop) by construction —
  // a plain `request.get(...)` is resilient and there are no per-call retry
  // wrappers to forget. `authenticatedRequest` and every
  // `playwright.request.newContext` the harness creates are wrapped the same
  // way; lint forbids reaching past this via `page.request.<method>()`.
  request: async ({ request }, use) => {
    await use(withRequestRetry(request));
  },
  rateLimitResetRequest: [
    async ({ playwright }, use) => {
      const ctx = withRequestRetry(await playwright.request.newContext({ baseURL: apiUrl }));
      await use(ctx);
      await ctx.dispose();
    },
    { scope: 'worker' },
  ],
  resetRateLimitsAutoHook: [
    async ({ rateLimitResetRequest }, use) => {
      await clearUsageRateLimits(rateLimitResetRequest);
      await use(null);
    },
    { auto: true },
  ],

  authenticatedPage: createPageFixture({ persona: 'test-alice' }, 'authenticatedPage'),

  // Explicitly clear storage state to override project-level default auth
  unauthenticatedPage: createPageFixture(
    { state: { cookies: [], origins: [] } },
    'unauthenticatedPage'
  ),

  createPage: async ({ browser }, use, testInfo) => {
    const pages: PageTeardownEntry[] = [];
    let counter = 0;

    const DEFAULT_STORAGE_STATE: StorageState = { cookies: [], origins: [] };
    const factory = async (storageState: StorageState = DEFAULT_STORAGE_STATE): Promise<Page> => {
      counter++;
      const label = `unauthenticatedPage-${String(counter)}`;
      const harPath = testInfo.outputPath(`${label}.har`);
      const { state, initScript } = await buildContextOptions(storageState);
      const context = await browser.newContext({
        storageState: state,
        ...harOption(harPath),
      });
      if (initScript !== null) await context.addInitScript({ content: initScript });
      const page = await context.newPage();
      const { entries, cleanup } = attachConsoleErrors(page);
      const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
      const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
        context,
        page,
        testInfo
      );
      pages.push({
        page,
        context,
        label,
        entries,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      });
      return page;
    };

    await use(factory);

    const failed = testInfo.status !== testInfo.expectedStatus;
    for (const entry of pages) {
      await teardownPage(entry, failed, testInfo);
    }
  },

  authenticatedRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: pooledStorageStatePath('test-alice', testInfo),
    });
    await use(withRequestRetry(context));
    await context.dispose();
  },

  test2FAPage: createPageFixture({ persona: 'test-2fa' }, 'test2FAPage'),

  billingSuccessPage: createPageFixture({ persona: 'test-billing-success' }, 'billingSuccessPage'),
  billingSuccessPage2: createPageFixture(
    { persona: 'test-billing-success-2' },
    'billingSuccessPage2'
  ),
  billingFailurePage: createPageFixture({ persona: 'test-billing-failure' }, 'billingFailurePage'),
  billingValidationPage: createPageFixture(
    { persona: 'test-billing-validation' },
    'billingValidationPage'
  ),
  billingDevModePage: createPageFixture({ persona: 'test-billing-devmode' }, 'billingDevModePage'),

  billingTokenRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: `e2e/.auth/${testInfo.project.name}/test-billing-token.json`,
    });
    await use(withRequestRetry(context));
    await context.dispose();
  },

  groupConversation: async (
    { authenticatedPage: _authenticatedPage, authenticatedRequest },
    use,
    testInfo
  ) => {
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const bobEmail = pooledPersonaEmail('test-bob', testInfo);
    const response = await authenticatedRequest.post('/dev/group-chat', {
      data: {
        ownerEmail: aliceEmail,
        memberEmails: [bobEmail],
        messages: [
          { senderEmail: aliceEmail, content: 'Hello from Alice', senderType: 'user' },
          { content: 'Echo: Hello! How can I help?', senderType: 'ai' },
          { senderEmail: bobEmail, content: 'Hi from Bob', senderType: 'user' },
          { senderEmail: aliceEmail, content: 'Alice replies', senderType: 'user' },
          { senderEmail: aliceEmail, content: 'Summarize this', senderType: 'user' },
          { content: 'Echo: Here is a summary of your conversation.', senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `group-chat creation failed: ${String(response.status())}`).toBe(true);
    const data = (await response.json()) as {
      conversationId: string;
      members: GroupConversation['members'];
    };
    await use({ id: data.conversationId, members: data.members });
    // No cleanup — CI database is ephemeral. Deleting here races with deferred
    // saveChatTurn() running via Wrangler's waitUntil(), producing billing_failed errors.
  },

  testBobPage: createPageFixture({ persona: 'test-bob' }, 'testBobPage'),

  testDavePage: createPageFixture({ persona: 'test-dave' }, 'testDavePage'),

  testBobRequest: async ({ playwright }, use, testInfo) => {
    const context = await playwright.request.newContext({
      baseURL: apiUrl,
      storageState: pooledStorageStatePath('test-bob', testInfo),
    });
    await use(withRequestRetry(context));
    await context.dispose();
  },

  // API-seeded multi-model turn: one user message and two sibling AI responses
  // sharing a parent message and batch id (the exact shape `saveChatTurn`
  // writes), seeded server-side via the dev endpoint instead of driving the UI
  // through a real two-model send. The two AI rows carry distinct live-catalog
  // model ids (distinct nametags) and non-null seed costs (visible cost badges).
  multiModelConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const userContent = `Multi-model fixture ${String(Date.now())}`;
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const response = await authenticatedRequest.post('/dev/conversation', {
      data: {
        ownerEmail: aliceEmail,
        aiTurn: { userContent, responseCount: 2 },
      },
    });

    rawExpect(
      response.ok(),
      `multi-model conversation creation failed: ${String(response.status())}`
    ).toBe(true);
    const data = (await response.json()) as { conversationId: string };
    const id = data.conversationId;

    await authenticatedPage.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    // Both AI siblings render as multi-model peers (proves the shared parent +
    // batch id), and each shows a cost badge — the shape the dependent specs
    // (nametags, per-model cost, retry/regenerate) assert against.
    await rawExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });
    await rawExpect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
      timeout: TIMEOUTS.CONVERSATION_LOAD,
    });

    // Leave the composer in 2-model mode. The seed populates the conversation's
    // history but not the client's model selection; a follow-up send relies on
    // this selection to fan out to two models (matching the prior UI-driven
    // fixture's persisted post-state). `data-app-stable` only exists on the
    // new-chat route, so gate on the conversation being loaded (above) instead.
    await chatPage.selectModels(2);

    await use({ id, url: `/chat/${id}` });
  },

  // API-seeded image turn (one prompt + one finished AI image) — no UI generate.
  imageConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const { conversationId, assistantMessageId } = await seedMediaConversation(
      authenticatedRequest,
      testInfo,
      'image',
      `Image fixture ${String(Date.now())}`
    );

    await authenticatedPage.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    // Gate handoff on the seed decoding, so a broken seed fails here, not mid-test.
    await chatPage.expectImageVisible();

    await use({ conversationId, assistantMessageId, page: authenticatedPage });
  },

  // API-seeded video turn — see imageConversation.
  videoConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const { conversationId, assistantMessageId } = await seedMediaConversation(
      authenticatedRequest,
      testInfo,
      'video',
      `Video fixture ${String(Date.now())}`
    );

    await authenticatedPage.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    await chatPage.expectVideoVisible();

    await use({ conversationId, assistantMessageId, page: authenticatedPage });
  },

  // Low-balance page: authenticated as test-billing-validation (zero starting balance);
  // both wallets are zeroed via the dev endpoint before the test runs so the
  // user lands on free tier with no allowance — any preflight cost denies with
  // `insufficient_free_allowance`. The "paid + $0.01" route doesn't work here:
  // the $0.50 paid-tier cushion always covers image/Smart-Model preflight costs.
  // Reset to $0 after the test to avoid bleed.
  lowBalancePage: async ({ browser, playwright }, use, testInfo) => {
    const projectName = testInfo.project.name;
    const lowBalanceEmail = `test-billing-validation-${projectName}@test.hushbox.ai`;
    const storageStatePath = `e2e/.auth/${projectName}/test-billing-validation.json`;
    const requestContext = withRequestRetry(
      await playwright.request.newContext({
        baseURL: apiUrl,
        storageState: storageStatePath,
      })
    );

    await zeroLowBalanceWallets(requestContext, lowBalanceEmail);

    const harPath = testInfo.outputPath('lowBalancePage.har');
    const isRetry = testInfo.retry > 0;
    const context = await browser.newContext({
      storageState: storageStatePath,
      ...(isRetry && {
        recordHar: { path: harPath, mode: 'minimal', urlFilter: API_HAR_URL_FILTER },
      }),
    });
    const page = await context.newPage();
    const { entries, cleanup } = attachConsoleErrors(page);
    const { errors: apiErrors, cleanup: cleanupApi } = attachApiErrors(page);
    const { violations, cleanup: cleanupNetwork } = installNetworkAllowlist(
      context,
      page,
      testInfo
    );
    await use(page);
    const failed = testInfo.status !== testInfo.expectedStatus;
    await teardownPage(
      {
        page,
        context,
        label: 'lowBalancePage',
        entries,
        apiErrors,
        violations,
        cleanup,
        cleanupApi,
        cleanupNetwork,
        harPath,
      },
      failed,
      testInfo
    );

    await requestContext.post('/dev/wallet-balance', {
      data: { email: lowBalanceEmail, walletType: 'purchased', balance: '0.00000000' },
    });
    await requestContext.dispose();
  },

  testConversation: async ({ authenticatedPage, authenticatedRequest }, use, testInfo) => {
    const testMessage = `Fixture setup ${String(Date.now())}`;
    const aliceEmail = pooledPersonaEmail('test-alice', testInfo);
    const response = await authenticatedRequest.post('/dev/conversation', {
      data: {
        ownerEmail: aliceEmail,
        messages: [
          { content: testMessage, senderType: 'user' },
          { content: `Echo: ${testMessage}`, senderType: 'ai' },
        ],
      },
    });

    rawExpect(response.ok(), `conversation creation failed: ${String(response.status())}`).toBe(
      true
    );
    const data = (await response.json()) as { conversationId: string };
    const id = data.conversationId;

    // Navigate to the conversation so the page is ready for test interactions.
    // Wait for both seeded messages to render — waitForConversationLoaded only
    // waits for the first message-item, which can resolve on just the user
    // message while the AI reply is still decrypting. Tests assuming "the
    // conversation is ready" need both present.
    await authenticatedPage.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' });
    const chatPage = new ChatPage(authenticatedPage);
    await chatPage.waitForConversationLoaded();
    await rawExpect(chatPage.messageList.getByTestId(TEST_IDS.messageItem)).toHaveCount(2);

    await use({ id, url: `/chat/${id}` });
  },
});

// Both `expect` and `unsettledExpect` resolve to plain Playwright `expect`;
// `unsettledExpect` is a retained alias so spec files importing either name
// keep resolving.
export { expect, expect as unsettledExpect } from './helpers/expect.js';

// Re-export the Playwright value-less types specs need, so specs source them
// here instead of importing `@playwright/test` directly (lint-banned in specs)
// — the fixtures module is the single door to the harness for both runtime
// values and types.
export type { APIRequestContext, Locator, Page, Request, Response } from '@playwright/test';
