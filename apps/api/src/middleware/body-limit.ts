import { bodyLimit } from 'hono/body-limit';
import { PER_FLOW_MEDIA_CAP_BYTES } from '@hushbox/crypto';
import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context/index.js';

/**
 * Absolute request-body ceiling, enforced at the edge before any handler runs.
 *
 * Sizing (the largest LEGITIMATE body governs it, not the platform maximum):
 * media inputs ride the request body by REFERENCE (`MediaRef` — an `inputs/`
 * R2 key + byteLength), never as inline bytes, and generated media leaves via
 * presigned R2 — so no route carries raw media in its body. The largest legit
 * body is therefore a text-only chat send/regenerate: an unbounded prior-turn
 * `history`, a prompt, and ≤5000-char custom instructions. A whole flow's
 * CONTENT is in turn bounded by the in-memory ValueStore's metered budget,
 * which equals `PER_FLOW_MEDIA_CAP_BYTES` (20 MiB) — nothing a turn can
 * legitimately process exceeds that. Doubling it leaves 100% headroom for JSON
 * structure and multi-part bodies while sitting far below Cloudflare's 100 MB
 * zone request-body cap, so oversized/abusive bodies are rejected up front and
 * every real request passes. (The redesign's "large media may ride the body up
 * to 100 MB" fallback was not built — `MediaRef` staging replaced it — so no
 * route needs a near-zone-cap body.)
 */
export const MAX_REQUEST_BODY_BYTES = 2 * PER_FLOW_MEDIA_CAP_BYTES;

/**
 * Caps the request-body size at `MAX_REQUEST_BODY_BYTES`, answering the uniform
 * `{code}` wire shape with 413 on breach (Hono's default `bodyLimit` returns a
 * bare `text/plain` "Payload Too Large", which would break the contract). The
 * content-length header short-circuits the common case without buffering.
 */
export function requestBodyLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json(createErrorResponse(ERROR_CODES.PAYLOAD_TOO_LARGE), 413),
  });
}
