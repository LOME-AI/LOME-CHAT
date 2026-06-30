/**
 * Canonical JSON for the idempotency body hash: object keys are sorted
 * recursively so key reordering between retries never reads as a different
 * body (a reused key with a genuinely different body must 409). Array order
 * stays significant — it is data.
 *
 * Non-JSON values (functions, symbols, bigint, non-finite numbers, cycles)
 * are defects at this boundary: a request body that cannot canonicalize
 * cannot be deduplicated, so we fail fast instead of hashing something lossy.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: ReadonlySet<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean': {
      return JSON.stringify(value);
    }
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite numbers are not JSON');
      }
      return JSON.stringify(value);
    }
    case 'object': {
      return serializeObject(value, seen);
    }
    default: {
      throw new TypeError(`canonicalJson: cannot serialize a ${typeof value}`);
    }
  }
}

function serializeObject(value: object, seen: ReadonlySet<object>): string {
  if (seen.has(value)) {
    throw new TypeError('canonicalJson: cyclic structures are not JSON');
  }
  const nested = new Set(seen).add(value);
  if (Array.isArray(value)) {
    // JSON.stringify renders undefined array elements as null; match it.
    const items = value.map((item: unknown) =>
      item === undefined ? 'null' : serialize(item, nested)
    );
    return `[${items.join(',')}]`;
  }
  // A non-plain object (Date, Map, class instance) would flatten to its
  // enumerable own keys — Object.entries(new Date()) is [] — so two
  // genuinely different bodies could hash equal. Fail fast instead.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('canonicalJson: non-plain objects are not JSON');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, nested)}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 hex over the canonical serialization — the stored `bodyHash`. */
export async function hashCanonicalJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
