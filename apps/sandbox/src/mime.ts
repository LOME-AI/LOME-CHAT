/**
 * Content-Type resolution for the static assets the sandbox origin serves.
 *
 * The Pyodide runtime is fetched by the opaque `allow-scripts` iframe, which
 * instantiates the WebAssembly module by response Content-Type: the `.wasm`
 * mapping to `application/wasm` is load-bearing, not cosmetic. In
 * production the assets runtime serves these types via ./public/_headers; this
 * table is the local dev server's equivalent so dev and prod agree.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  wasm: 'application/wasm',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  zip: 'application/zip',
  whl: 'application/octet-stream',
};

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** Resolve the Content-Type for a request pathname by its file extension. */
export function contentTypeFor(pathname: string): string {
  const lastDot = pathname.lastIndexOf('.');
  const lastSlash = pathname.lastIndexOf('/');
  if (lastDot === -1 || lastDot < lastSlash) return FALLBACK_CONTENT_TYPE;
  const extension = pathname.slice(lastDot + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? FALLBACK_CONTENT_TYPE;
}
