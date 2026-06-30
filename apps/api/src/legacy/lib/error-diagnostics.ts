/**
 * Walks an error's `cause` chain and serializes each layer into a flat,
 * log-safe shape. Used by `writeStreamErrorFromException` so a single
 * `console.error` line captures the whole SDK error chain (V8 SyntaxError →
 * JSONParseError → APICallError → GatewayResponseError) — Cloudflare Workers'
 * default serializer only prints `name`/`message`/`stack` and drops every
 * enumerable property.
 *
 * Privacy boundary: this serializer NEVER includes `requestBodyValues` (which
 * carries user prompts), `responseHeaders` (which may carry auth tokens), or
 * any property whose key matches the sensitive-property denylist. Bodies are
 * truncated to a small cap so a stray success-path call doesn't blast a
 * base64 image into the log stream.
 */

const SENSITIVE_PROPERTY_PATTERN = /prompt|secret|token|apikey|cookie|authorization/i;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_BODY_CHARS = 1024;

export interface ErrorDiagnosticLayer {
  name: string;
  message: string;
  statusCode?: number;
  url?: string;
  bodyPreview?: string;
}

export interface ErrorDiagnostics {
  layers: ErrorDiagnosticLayer[];
  truncated: boolean;
}

export interface ExtractErrorDiagnosticsOptions {
  maxDepth?: number;
  maxBodyChars?: number;
}

function stringifyNonError(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    // JSON.stringify is typed as `string` but returns undefined for symbols /
    // functions / undefined-valued top-level inputs.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? typeof value;
  } catch {
    return typeof value;
  }
}

function readStringProperty(source: Record<string, unknown>, key: string): string | undefined {
  if (SENSITIVE_PROPERTY_PATTERN.test(key)) return undefined;
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumberProperty(source: Record<string, unknown>, key: string): number | undefined {
  if (SENSITIVE_PROPERTY_PATTERN.test(key)) return undefined;
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripQueryString(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function truncate(value: string, maxBodyChars: number): string {
  return value.length > maxBodyChars ? value.slice(0, maxBodyChars) + '…' : value;
}

function buildLayer(
  candidate: Record<string, unknown>,
  maxBodyChars: number
): ErrorDiagnosticLayer {
  const name = readStringProperty(candidate, 'name') ?? 'Unknown';
  const message =
    readStringProperty(candidate, 'message') ?? stringifyNonError(candidate['message']);

  const layer: ErrorDiagnosticLayer = { name, message };

  const statusCode = readNumberProperty(candidate, 'statusCode');
  if (statusCode !== undefined) layer.statusCode = statusCode;

  const url = readStringProperty(candidate, 'url');
  if (url !== undefined) layer.url = stripQueryString(url);

  // SDK preserves the raw body on `responseBody` (APICallError) or `text`
  // (JSONParseError); responseBody wins when both exist because it's
  // closer to the wire.
  const responseBody = readStringProperty(candidate, 'responseBody');
  const text = readStringProperty(candidate, 'text');
  const body = responseBody ?? text;
  if (body !== undefined) layer.bodyPreview = truncate(body, maxBodyChars);

  return layer;
}

function extractLayerAndCause(
  current: unknown,
  maxBodyChars: number
): { layer: ErrorDiagnosticLayer; cause: unknown } {
  if (typeof current !== 'object' || current === null) {
    return { layer: { name: 'Unknown', message: stringifyNonError(current) }, cause: null };
  }
  const candidate = current as Record<string, unknown>;
  return { layer: buildLayer(candidate, maxBodyChars), cause: candidate['cause'] ?? null };
}

export function extractErrorDiagnostics(
  err: unknown,
  options?: ExtractErrorDiagnosticsOptions
): ErrorDiagnostics {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBodyChars = options?.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;

  const layers: ErrorDiagnosticLayer[] = [];
  let current: unknown = err;
  let truncated = false;

  for (let depth = 0; depth < maxDepth; depth++) {
    const { layer, cause } = extractLayerAndCause(current, maxBodyChars);
    layers.push(layer);
    if (cause === null) break;
    current = cause;

    // Hit the cap with another cause still pending → mark truncated.
    if (depth + 1 === maxDepth) {
      truncated = true;
    }
  }

  return { layers, truncated };
}
