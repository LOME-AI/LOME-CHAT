import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestListener, resolveDevPort, resolveWithinDir } from './dev-server.js';
import { SANDBOX_CSP } from './csp.js';
import { ESM_STUB_PREFIX } from './esm-stub.js';

describe('resolveWithinDir', () => {
  it('resolves a normal path beneath the served directory', () => {
    expect(resolveWithinDir('/srv/public', '/pyodide/core.wasm')).toBe(
      '/srv/public/pyodide/core.wasm'
    );
  });

  it('resolves the bare root to the served directory itself', () => {
    expect(resolveWithinDir('/srv/public', '/')).toBe('/srv/public');
  });

  it('allows an interior `..` that stays within the directory', () => {
    expect(resolveWithinDir('/srv/public', '/a/../b.html')).toBe('/srv/public/b.html');
  });

  it('rejects a traversal that escapes the served directory', () => {
    expect(resolveWithinDir('/srv/public', '/../../etc/passwd')).toBeNull();
  });

  it('rejects a sibling directory sharing the prefix', () => {
    expect(resolveWithinDir('/srv/public', '/../public-evil/x')).toBeNull();
  });
});

describe('resolveDevPort', () => {
  it('reads HB_SANDBOX_PORT as a number', () => {
    expect(resolveDevPort({ HB_SANDBOX_PORT: '7400' })).toBe(7400);
  });

  it('fails fast when HB_SANDBOX_PORT is unset (no default port)', () => {
    expect(() => resolveDevPort({})).toThrow(/HB_SANDBOX_PORT/);
  });

  it('fails fast when HB_SANDBOX_PORT is not a positive integer', () => {
    expect(() => resolveDevPort({ HB_SANDBOX_PORT: 'not-a-port' })).toThrow(/HB_SANDBOX_PORT/);
  });
});

describe('createRequestListener', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sandbox-dev-'));
    writeFileSync(path.join(dir, 'render.html'), '<!doctype html><title>render</title>');
    mkdirSync(path.join(dir, 'pyodide'));
    // A minimal valid WebAssembly module header (\0asm + version 1).
    writeFileSync(
      path.join(dir, 'pyodide', 'core.wasm'),
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    );

    server = createServer(
      createRequestListener({ publicDir: dir, configScript: 'globalThis.X = 1;' })
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a static page with the correct MIME and permissive CORS', async () => {
    const res = await fetch(`${base}/render.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.text()).toContain('<title>render</title>');
  });

  it('serves every page under the exact production sandbox CSP', async () => {
    // E2E and dev must exercise the deployed containment policy, not a permissive
    // dev server. The served header is the one shared constant verbatim.
    const res = await fetch(`${base}/render.html`);
    expect(res.headers.get('content-security-policy')).toBe(SANDBOX_CSP);
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
  });

  it('serves an esm-stub fixture module as JavaScript under the CSP', async () => {
    const res = await fetch(`${base}${ESM_STUB_PREFIX}/react@19.1.0`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(SANDBOX_CSP);
    expect(await res.text()).toContain('createElement');
  });

  it('serves an esm-stub subpath fixture (react automatic JSX runtime)', async () => {
    const res = await fetch(`${base}${ESM_STUB_PREFIX}/react@19.1.0/jsx-runtime`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Fragment');
  });

  it('returns 404 for an esm-stub path that names no fixture', async () => {
    const res = await fetch(`${base}${ESM_STUB_PREFIX}/left-pad@1.0.0`);
    expect(res.status).toBe(404);
  });

  it('answers HEAD for an esm-stub fixture with headers and no body', async () => {
    const res = await fetch(`${base}${ESM_STUB_PREFIX}/react@19.1.0`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  it('serves .wasm as application/wasm with CORS (opaque frame fetches it cross-origin)', async () => {
    const res = await fetch(`${base}/pyodide/core.wasm`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/wasm');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const head = Buffer.from(await res.arrayBuffer())
      .subarray(0, 4)
      .toString('hex');
    expect(head).toBe('0061736d');
  });

  it('serves the env-derived /config.js as JavaScript', async () => {
    const res = await fetch(`${base}/config.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe('globalThis.X = 1;');
  });

  it('answers a CORS preflight with 204 and the allow headers', async () => {
    const res = await fetch(`${base}/render.html`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('returns 404 for a missing file', async () => {
    const res = await fetch(`${base}/does-not-exist.html`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for the bare root (no SPA index shell)', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
  });

  it('never serves a file outside the served directory (traversal is safe end-to-end)', async () => {
    // The URL parser normalizes literal and percent-encoded `..` before the
    // handler runs, so both resolve to a non-existent in-dir path (404); the
    // resolveWithinDir guard is the defensive wall, unit-tested directly above.
    for (const suffix of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await fetch(`${base}${suffix}`, { redirect: 'manual' });
      expect(res.status).not.toBe(200);
    }
  });

  it('rejects a non-GET/HEAD method with 405', async () => {
    const res = await fetch(`${base}/render.html`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('answers HEAD for a static file with headers and no body', async () => {
    const res = await fetch(`${base}/render.html`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('');
  });

  it('answers HEAD for /config.js with no body', async () => {
    const res = await fetch(`${base}/config.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('createRequestListener (defensive defaults)', () => {
  it('treats a request with no method/url as GET "/" (404 on the root dir)', () => {
    const listener = createRequestListener({ publicDir: tmpdir(), configScript: '' });
    let status = 0;
    const req = { method: undefined, url: undefined } as unknown as Parameters<typeof listener>[0];
    const res = {
      writeHead(code: number): void {
        status = code;
      },
      end(): void {},
    } as unknown as Parameters<typeof listener>[1];
    listener(req, res);
    expect(status).toBe(404);
  });
});
