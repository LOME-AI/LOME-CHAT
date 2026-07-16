/**
 * Canonical-request hashing for the HTTP cassette harness.
 *
 * Builds a deterministic descriptor of every fetch call (method, path+query,
 * allowlisted headers, canonicalized body) and produces a stable sha256 hash.
 * Two requests that should replay-match each other must produce the same
 * hash; two requests that should produce distinct recordings must produce
 * different hashes.
 *
 * The hashing scheme predates this module — recordings are shared with the
 * prior implementation, so the on-disk store stays interoperable; duplicated
 * rather than imported because new code never imports `legacy_` paths
 * (lint-enforced). One deliberate divergence: the header allowlist below is
 * pared to the deterministic, non-secret wire headers (OpenRouter carries the
 * model id in the body, not a header).
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../../../../lib/idempotency/canonical-json.js';

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
 *   - `content-type`, `accept` — wire format; replay must match request shape.
 *
 * OpenRouter carries the model id in the request BODY (`body.model`), not a
 * header, so two models with identical prompts already hash differently via the
 * body — no model-id header needs to ride the hash.
 *
 * EXCLUDE rationale: anything carrying SDK version, auth (`Authorization`, the
 * API key), or per-request identifiers. These vary between record and replay
 * even when the logical request is identical.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set(['content-type', 'accept']);

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

// Orders wire keys (query params, allowlisted header names) for the descriptor.
// This is request shaping, not JSON-body canonicalization — the body delegates
// to the shared `canonicalJson` (imported above), so there is one serializer.
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

function pathAndQueryOf(url: URL): string {
  return `${url.pathname}${sortedQueryString(url.search)}`;
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
      // eslint-disable-next-line catch-swallow/no-silent-catch -- malformed JSON falls through to deterministic hex hashing.
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
