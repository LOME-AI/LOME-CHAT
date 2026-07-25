import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { contentTypeFor } from './mime.js';
import { SANDBOX_SECURITY_HEADERS } from './csp.js';
import { ESM_STUB_PREFIX, resolveEsmStub } from './esm-stub.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Local dev server for the sandbox origin. Production serves the same `./dist`
 * as a Cloudflare assets Worker (wrangler.toml); this Node server is the
 * local-parity equivalent, mounted into `pnpm dev` on the per-worktree
 * `HB_SANDBOX_PORT`. It serves static files with the correct Content-Type, the
 * same Content-Security-Policy the production `_headers` ships (so E2E and dev
 * exercise the real containment policy, not a permissive one), and a permissive
 * CORS header so the opaque `allow-scripts` iframe can fetch the Pyodide
 * wasm/wheels cross-origin. It also publishes the synthetic `/config.js`
 * (env-derived renderer config) and, under `/esm-stub/`, the local module
 * fixtures test mode resolves imports against in place of esm.sh.
 */

/** Read the per-worktree dev port; fail fast rather than default a port. */
export function resolveDevPort(env: { HB_SANDBOX_PORT?: string | undefined }): number {
  const raw = env.HB_SANDBOX_PORT;
  const port = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `HB_SANDBOX_PORT is not a valid port (got ${JSON.stringify(raw)}) — run \`pnpm generate:env\` first.`
    );
  }
  return port;
}

export interface RequestListenerOptions {
  /** Absolute directory whose files are served. */
  readonly publicDir: string;
  /** The `/config.js` body (from buildSandboxConfigScript). */
  readonly configScript: string;
}

const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

/**
 * Every response carries the permissive CORS baseline plus the production
 * security headers (the sandbox CSP + DNS-prefetch lock), so a page loaded from
 * this dev server runs under exactly the containment policy production serves.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  ...CORS_HEADERS,
  ...SANDBOX_SECURITY_HEADERS,
};

/** The synthetic path that serves the env-derived renderer config. */
const CONFIG_PATH = '/config.js';

/**
 * Resolve a request pathname to an absolute path guaranteed to be the served
 * directory itself or strictly beneath it, or `null` when it would escape.
 * This is the traversal guard: even though the URL parser normalizes literal and
 * percent-encoded `..` segments before this runs, the check is the defensive
 * wall that does not trust that normalization.
 */
export function resolveWithinDir(publicDir: string, pathname: string): string | null {
  const resolved = path.resolve(publicDir, `.${pathname}`);
  if (resolved === publicDir || resolved.startsWith(publicDir + path.sep)) {
    return resolved;
  }
  return null;
}

/** Send a header-only response (CORS + security headers + status, no body). */
function respondEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, BASE_HEADERS);
  res.end();
}

/** Serve a file from the served directory, or a 403/404 header-only response. */
function serveStaticAsset(
  res: ServerResponse,
  options: RequestListenerOptions,
  pathname: string,
  isHead: boolean
): void {
  const resolved = resolveWithinDir(options.publicDir, pathname);
  /* v8 ignore start -- defense in depth: the URL parser normalizes both literal
     and percent-encoded `..` before this runs, so a real HTTP request can never
     reach here; the containment contract is unit-tested on resolveWithinDir. */
  if (resolved === null) {
    respondEmpty(res, 403);
    return;
  }
  /* v8 ignore stop */

  let body: Buffer;
  try {
    if (statSync(resolved).isDirectory()) {
      respondEmpty(res, 404);
      return;
    }
    body = readFileSync(resolved);
  } catch {
    respondEmpty(res, 404);
    return;
  }

  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': contentTypeFor(pathname) });
  res.end(isHead ? undefined : body);
}

/** Serve a JS module body, or a 404 when the esm-stub names no fixture. */
function serveEsmStub(res: ServerResponse, pathname: string, isHead: boolean): void {
  const body = resolveEsmStub(pathname);
  if (body === null) {
    respondEmpty(res, 404);
    return;
  }
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' });
  res.end(isHead ? undefined : body);
}

/** Build the Node request handler that serves the sandbox origin's assets. */
export function createRequestListener(
  options: RequestListenerOptions
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      respondEmpty(res, 204);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      respondEmpty(res, 405);
      return;
    }

    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const isHead = method === 'HEAD';

    if (pathname === CONFIG_PATH) {
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(isHead ? undefined : options.configScript);
      return;
    }

    if (pathname.startsWith(`${ESM_STUB_PREFIX}/`)) {
      serveEsmStub(res, pathname, isHead);
      return;
    }

    serveStaticAsset(res, options, pathname, isHead);
  };
}
