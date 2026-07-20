/**
 * Canonical-request hashing for the HTTP cassette layer.
 *
 * Builds a deterministic descriptor of every fetch call (method, path+query,
 * allowlisted headers, canonicalized body) and produces a stable sha256 hash.
 * Two requests that should replay-match each other must produce the same
 * hash; two requests that should produce distinct recordings must produce
 * different hashes.
 *
 * The header allowlist is the load-bearing decision: include too much and the
 * hash drifts every SDK upgrade (User-Agent carries the version); include too
 * little and different models collide on the same hash (the gateway routes by
 * `ai-model-id` header, not URL path).
 */

import { createHash } from 'node:crypto';

export interface RequestDescriptor {
  method: string;
  pathAndQuery: string;
  /** Only the allowlist below — everything else is filtered. */
  headers: Record<string, string>;
  body: string | undefined;
}

/**
 * Headers we include in the hash. Everything outside this list is filtered.
 *
 * INCLUDE rationale:
 *   - `content-type`, `accept` — wire format; replay must match request shape
 *   - `ai-model-id` — gateway routes by this header, not URL path. Without
 *     it, different models hashes collide on the same `/v3/ai/{kind}-model` path
 *   - `ai-language-model-streaming` — `streamText` vs `generateText` go to the
 *     same endpoint; this header is the only discriminator
 *
 * EXCLUDE rationale: anything carrying SDK version, auth, or per-request
 * identifiers. These vary between record and replay even when the logical
 * request is identical.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  'ai-model-id',
  'ai-language-model-streaming',
]);

function filterHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (HEADER_ALLOWLIST.has(lower)) {
      result[lower] = value;
    }
  }
  return result;
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function sortedQueryString(search: string): string {
  if (search.length === 0) return '';
  const params = new URLSearchParams(search);
  const entries: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    entries.push([key, value]);
  }
  const sorted = entries.toSorted(([a], [b]) => compareStrings(a, b));
  const formatted = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `?${formatted}`;
}

/**
 * `gateway.getGenerationInfo({ id })` issues
 * `GET ${baseUrl.origin}/v1/generation?id=<urlencoded-id>`. The id is
 * assigned by the gateway at generation time — non-deterministic across
 * record/replay runs — so we hash only the shape of the request, not the
 * specific id. Replay returns the most recent matching recording.
 */
function isGenerationInfoPath(pathname: string): boolean {
  return pathname === '/v1/generation';
}

function pathAndQueryOf(url: URL): string {
  if (isGenerationInfoPath(url.pathname)) {
    return url.pathname; // strip id query
  }
  return `${url.pathname}${sortedQueryString(url.search)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry));
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).toSorted(compareStrings);
    for (const key of keys) {
      const inner = (value as Record<string, unknown>)[key];
      // `unknown` index access can produce undefined values from inputs whose
      // keys map to explicit `undefined`; strip them so two callers passing
      // `{ a: 1 }` vs `{ a: 1, b: undefined }` produce identical canonical JSON.
      if (inner === undefined) continue;
      sorted[key] = canonicalJsonValue(inner);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function bytesToHex(bytes: Uint8Array): string {
  const hex = Array.from({ length: bytes.length });
  for (const [index, byte] of bytes.entries()) {
    hex[index] = byte.toString(16).padStart(2, '0');
  }
  return hex.join('');
}

async function bodyToCanonicalString(req: Request): Promise<string | undefined> {
  if (req.body === null) return undefined;
  const contentType = req.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  if (isJson) {
    const text = await req.clone().text();
    if (text.length === 0) return '';
    try {
      const parsed: unknown = JSON.parse(text);
      return canonicalJson(parsed);
    } catch {
      // Malformed JSON: fall through to raw hex so a broken body still hashes
      // deterministically (and differently from a well-formed one).
    }
  }
  const buffer = await req.clone().arrayBuffer();
  if (buffer.byteLength === 0) return '';
  return `hex:${bytesToHex(new Uint8Array(buffer))}`;
}

export async function requestToDescriptor(req: Request): Promise<RequestDescriptor> {
  const url = new URL(req.url);
  return {
    method: req.method.toUpperCase(),
    pathAndQuery: pathAndQueryOf(url),
    headers: filterHeaders(req.headers),
    body: await bodyToCanonicalString(req),
  };
}

/**
 * Hash a descriptor to a stable 16-hex-char string (8 bytes of sha256 prefix).
 * 8 bytes is plenty for the cardinality we see in a single CI run (~20
 * recordings) — collision probability is ~10^-18.
 */
export function descriptorHash(descriptor: RequestDescriptor): string {
  const sortedHeaderKeys = Object.keys(descriptor.headers).toSorted(compareStrings);
  const sortedHeaders: Record<string, string> = {};
  for (const key of sortedHeaderKeys) {
    const value = descriptor.headers[key];
    if (value === undefined) continue;
    sortedHeaders[key] = value;
  }
  const payload = JSON.stringify({
    method: descriptor.method,
    pathAndQuery: descriptor.pathAndQuery,
    headers: sortedHeaders,
    body: descriptor.body,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
