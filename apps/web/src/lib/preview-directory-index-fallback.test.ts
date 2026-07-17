import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PreviewServer } from 'vite';
import {
  previewDirectoryIndexFallback,
  rewriteForDirectoryIndex,
} from './preview-directory-index-fallback';

const DIST = '/app/dist';

function exists(present: string[]): (path: string) => boolean {
  return (p) => present.includes(p);
}

describe('rewriteForDirectoryIndex', () => {
  it('rewrites a directory-style URL to its index.html when the file exists', () => {
    const result = rewriteForDirectoryIndex(
      '/welcome',
      DIST,
      exists(['/app/dist/welcome/index.html'])
    );
    expect(result).toBe('/welcome/index.html');
  });

  it('preserves query string on rewrite', () => {
    const result = rewriteForDirectoryIndex(
      '/welcome?utm=x&foo=bar',
      DIST,
      exists(['/app/dist/welcome/index.html'])
    );
    expect(result).toBe('/welcome/index.html?utm=x&foo=bar');
  });

  it('returns null for the root URL', () => {
    expect(rewriteForDirectoryIndex('/', DIST, exists(['/app/dist/index.html']))).toBeNull();
  });

  it('returns null for a trailing-slash directory URL (vite already handles it)', () => {
    expect(
      rewriteForDirectoryIndex('/welcome/', DIST, exists(['/app/dist/welcome/index.html']))
    ).toBeNull();
  });

  it('returns null when the URL already has a .html extension', () => {
    expect(
      rewriteForDirectoryIndex(
        '/welcome.html',
        DIST,
        exists(['/app/dist/welcome.html', '/app/dist/welcome/index.html'])
      )
    ).toBeNull();
  });

  it('returns null when the matching index.html does not exist (SPA fallthrough)', () => {
    expect(rewriteForDirectoryIndex('/chat', DIST, exists([]))).toBeNull();
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    expect(rewriteForDirectoryIndex('/%E0%A4%A', DIST, exists([]))).toBeNull();
  });

  it('refuses path traversal that escapes the dist directory', () => {
    // `/../etc/passwd` would resolve outside DIST. The guard must reject it
    // even if `fileExists` would return true for the target.
    const result = rewriteForDirectoryIndex(
      '/../etc/passwd',
      DIST,
      // Pretend the file is everywhere — the traversal guard should still trip first.
      () => true
    );
    expect(result).toBeNull();
  });

  it('rewrites nested directory URLs (e.g. /blog/tag/foo)', () => {
    const result = rewriteForDirectoryIndex(
      '/blog/tag/foo',
      DIST,
      exists(['/app/dist/blog/tag/foo/index.html'])
    );
    expect(result).toBe('/blog/tag/foo/index.html');
  });

  it('rewrites a URL containing percent-encoded path segments', () => {
    const result = rewriteForDirectoryIndex(
      '/blog/my%20post',
      DIST,
      exists(['/app/dist/blog/my post/index.html'])
    );
    // Rewritten URL keeps the original (still-encoded) path; vite/sirv
    // re-decodes it when reading the file.
    expect(result).toBe('/blog/my%20post/index.html');
  });
});

describe('previewDirectoryIndexFallback plugin', () => {
  let distributionDir: string;

  beforeAll(() => {
    distributionDir = mkdtempSync(path.join(os.tmpdir(), 'preview-dir-'));
    mkdirSync(path.join(distributionDir, 'welcome'), { recursive: true });
    writeFileSync(path.join(distributionDir, 'welcome', 'index.html'), '<!doctype html>');
  });

  afterAll(() => {
    rmSync(distributionDir, { recursive: true, force: true });
  });

  // Register the plugin's preview middleware against a fake server and return
  // the captured handler.
  function installMiddleware(): (req: { url?: string }, res: unknown, next: () => void) => void {
    const plugin = previewDirectoryIndexFallback(distributionDir);
    expect(plugin.name).toBe('preview-directory-index-fallback');
    let handler: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
    const server = {
      middlewares: {
        use: (
          registerFunction: (req: { url?: string }, res: unknown, next: () => void) => void
        ) => {
          handler = registerFunction;
        },
      },
    } as unknown as PreviewServer;
    // configurePreviewServer may be a function or an object hook; this plugin uses a function.
    const configure = plugin.configurePreviewServer as (s: PreviewServer) => void;
    configure(server);
    if (!handler) throw new Error('middleware not registered');
    return handler;
  }

  it('rewrites a directory-style request to its nested index.html', () => {
    const handler = installMiddleware();
    const next = vi.fn();
    const req = { url: '/welcome' };
    handler(req, {}, next);
    expect(req.url).toBe('/welcome/index.html');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes an unmatched request through untouched', () => {
    const handler = installMiddleware();
    const next = vi.fn();
    const req = { url: '/chat' };
    handler(req, {}, next);
    expect(req.url).toBe('/chat');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('treats a missing req.url as empty and passes through', () => {
    const handler = installMiddleware();
    const next = vi.fn();
    const req: { url?: string } = {};
    handler(req, {}, next);
    expect(req.url).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
