// Throwaway spike static server. Serves a directory on a port with permissive
// CORS and correct MIME (application/wasm for .wasm, text/javascript for .mjs/.js).
// The app server template-injects the sandbox origin so nothing is hard-coded.
// Usage: node serve.mjs <dir> <port> [sandboxOrigin]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [, , dir, portStr, sandboxOrigin] = process.argv;
if (!dir || !portStr) {
  console.error('usage: node serve.mjs <dir> <port> [sandboxOrigin]');
  process.exit(1);
}
const port = Number(portStr);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let p = decodeURIComponent(url.pathname);
    // App-emitted result beacon: the spike page POSTs its final JSON here so the
    // result can be read on the host (device → host via `adb reverse`), with no
    // device DOM scraping. Written next to the served dir as spike-result.json.
    if (p === '/__result' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, '..', 'spike-result.json'), body);
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
      res.end('ok');
      return;
    }
    if (p === '/') p = '/index.html';
    const full = join(dir, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    let body = await readFile(full);
    const ext = extname(full);
    // Template-inject the sandbox origin into the app page (no hard-coded port).
    if (ext === '.html' && sandboxOrigin) {
      body = Buffer.from(
        body.toString('utf8').replace('SANDBOX_ORIGIN_PLACEHOLDER', sandboxOrigin),
        'utf8'
      );
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      // Permissive CORS so the opaque-origin sandboxed iframe / its worker can
      // fetch cross-origin module + wasm assets. (Real T6 CSP will be strict.)
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
});
server.listen(port, '0.0.0.0', () => console.log(`serving ${dir} on :${port}`));
