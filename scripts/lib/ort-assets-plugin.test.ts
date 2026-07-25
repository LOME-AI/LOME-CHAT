import { existsSync, promises as fs, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { TTS_ORT_WASM_PATH } from '../../packages/shared/src/tts-hosts.js';
import {
  collectOrtAssets,
  contentTypeFor,
  ortAssetsPlugin,
  ortDistributionDir,
  resolveOrtAssets,
} from './ort-assets-plugin.js';

describe('ortDistributionDir', () => {
  it('resolves the installed transformers dist that carries the ORT runtime', () => {
    const dir = ortDistributionDir();
    const names = readdirSync(dir);
    expect(names.some((n) => /^ort-.*\.wasm$/u.test(n))).toBe(true);
    expect(names.some((n) => /^ort-.*\.mjs$/u.test(n))).toBe(true);
  });
});

describe('collectOrtAssets', () => {
  it('returns each ort-*.wasm/.mjs file with an absolute path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ort-assets-'));
    await fs.writeFile(path.join(dir, 'ort-x.wasm'), 'w');
    await fs.writeFile(path.join(dir, 'ort-x.mjs'), 'm');
    await fs.writeFile(path.join(dir, 'transformers.js'), 'ignored');

    const assets = collectOrtAssets(dir);

    expect(assets.map((a) => a.fileName).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'ort-x.mjs',
      'ort-x.wasm',
    ]);
    for (const asset of assets) {
      expect(path.isAbsolute(asset.absPath)).toBe(true);
      expect(asset.absPath).toBe(path.join(dir, asset.fileName));
    }
  });

  it('throws when the directory holds no ORT runtime files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ort-empty-'));
    await fs.writeFile(path.join(dir, 'transformers.js'), 'x');
    expect(() => collectOrtAssets(dir)).toThrow(/No onnxruntime-web WASM assets/);
  });
});

describe('resolveOrtAssets', () => {
  it('resolves real ORT runtime files whose bytes are readable', () => {
    const assets = resolveOrtAssets();
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.some((a) => a.fileName.endsWith('.wasm'))).toBe(true);
    expect(assets.some((a) => a.fileName.endsWith('.mjs'))).toBe(true);
    for (const asset of assets) {
      expect(existsSync(asset.absPath)).toBe(true);
    }
  });
});

describe('contentTypeFor', () => {
  it('maps .wasm to application/wasm', () => {
    expect(contentTypeFor('ort-x.wasm')).toBe('application/wasm');
  });

  it('maps .mjs (and anything else) to text/javascript', () => {
    expect(contentTypeFor('ort-x.mjs')).toBe('text/javascript');
  });
});

describe('ortAssetsPlugin', () => {
  it('is named for its role', () => {
    expect(ortAssetsPlugin().name).toBe('ort-wasm-self-host');
  });

  it('emits every ORT asset under the shared same-origin dir during the build', () => {
    const plugin = ortAssetsPlugin();
    const emitFile = vi.fn();
    const ortDir = TTS_ORT_WASM_PATH.replaceAll(/^\/+|\/+$/gu, '');

    // Rollup calls generateBundle with the plugin context as `this`. The hook
    // type is an ObjectHook union; this plugin always uses the function form.
    (plugin.generateBundle as unknown as (this: { emitFile: typeof emitFile }) => void).call({
      emitFile,
    });

    const emitted = emitFile.mock.calls.map((c) => c[0] as { type: string; fileName: string });
    const realAssets = resolveOrtAssets();
    expect(emitted.length).toBe(realAssets.length);
    for (const asset of realAssets) {
      const call = emitted.find((e) => e.fileName === `${ortDir}/${asset.fileName}`);
      expect(call, `emits ${asset.fileName}`).toBeDefined();
      expect(call?.type).toBe('asset');
    }
  });

  it('serves a matching ORT request same-origin in dev with the right content type', async () => {
    const handler = captureMiddleware();
    // Use the small .mjs loader (not the ~21 MB wasm) to keep the pipe cheap.
    const mjs = resolveOrtAssets().find((a) => a.fileName.endsWith('.mjs'))!;

    const setHeader = vi.fn();
    const res = Object.assign(
      new Writable({
        write(_chunk, _enc, callback) {
          callback();
        },
      }),
      { setHeader }
    );
    const next = vi.fn();

    handler({ url: `${TTS_ORT_WASM_PATH}${mjs.fileName}?v=1` }, res, next);
    await new Promise((resolve) => res.on('finish', resolve));

    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/javascript');
    expect(next).not.toHaveBeenCalled();
  });

  it('passes non-ORT requests through to the next handler', () => {
    const handler = captureMiddleware();
    const setHeader = vi.fn();
    const next = vi.fn();

    handler({ url: '/index.html' }, { setHeader }, next);

    expect(next).toHaveBeenCalledOnce();
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('treats a request with no url as non-matching', () => {
    const handler = captureMiddleware();
    const next = vi.fn();
    handler({}, { setHeader: vi.fn() }, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

type Middleware = (req: { url?: string }, res: unknown, next: () => void) => void;

/** Instantiate the plugin, run its `configureServer` hook against a stub server,
 * and return the middleware it registered. */
function captureMiddleware(): Middleware {
  const plugin = ortAssetsPlugin();
  let captured: Middleware | undefined;
  const server = { middlewares: { use: (function_: Middleware) => (captured = function_) } };
  // configureServer's hook type is an ObjectHook union; the plugin uses the
  // function form.
  (plugin.configureServer as unknown as (this: unknown, s: typeof server) => void).call(
    undefined,
    server
  );
  if (captured === undefined) throw new Error('configureServer registered no middleware');
  return captured;
}
