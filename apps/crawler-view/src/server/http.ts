/**
 * Minimal HTTP helpers for the dev-only crawler API middleware. Kept framework-free
 * and typed against small structural shapes so the handlers stay unit-testable with
 * fake req/res objects — a real Node `IncomingMessage`/`ServerResponse` satisfies them.
 */

export interface RequestLike {
  url?: string | undefined;
  method?: string | undefined;
  headers: { origin?: string | string[] | undefined };
}

export interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): unknown;
}

export function sendJson(res: ResponseLike, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** True only for `http://localhost` / `http://127.0.0.1` origins (any port). */
export function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

/** Reflect a localhost request Origin into CORS headers; ignore anything else. */
export function applyCors(req: RequestLike, res: ResponseLike): void {
  const origin = firstHeader(req.headers.origin);
  if (origin !== undefined && isLocalhostOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

/** Answer a CORS preflight; returns true when the request was fully handled. */
export function handlePreflight(req: RequestLike, res: ResponseLike): boolean {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

/** Read a query param from a connect-style `req.url` (mount prefix may be stripped). */
export function getQueryParameter(rawUrl: string | undefined, key: string): string | null {
  if (rawUrl === undefined || rawUrl === '') {
    return null;
  }
  try {
    return new URL(rawUrl, 'http://localhost').searchParams.get(key);
  } catch {
    return null;
  }
}
