/**
 * HTTP cassette interceptor — wraps a fetch-shaped function so calls are
 * replayed from the store when a recording exists.
 *
 * Two modes. Runtime always composes `record` (via `cassetteModeFor()`, which
 * is env-independent and record-on-miss); `replay-only` is exercised only by
 * the cassette unit tests:
 *   - `record`: miss + success (<400) passes through AND records (request +
 *     response); miss + error (>=400) passes through unrecorded — a failed
 *     gateway request bills nothing, and caching it would replay a stale,
 *     transient failure forever (deterministic error paths come from the
 *     hand-curated failure fixtures instead).
 *   - `replay-only`: a miss throws `CassetteMissError`. Used only by the
 *     cassette unit tests — CI runs in `record` mode (record-on-miss), so a
 *     cold-cache CI request makes a real charged call and records it.
 *
 * The replay semantics and store format predate this module; recordings are
 * shared with the prior implementation. Duplicated rather than imported
 * because new code never imports `legacy_` paths (lint-enforced). Replay-only
 * mode and canonical-request capture (the ZDR-flag store assertion reads it)
 * exist only here — prior recordings carry no `request` field.
 */

import {
  requestToDescriptor,
  descriptorHash,
  type RequestDescriptor,
} from './canonical-request.js';
import type { Cassette, CassetteStore } from './cassette-store.js';

/**
 * A replay-only miss. The message carries the request shape (method, path,
 * hash) and never the body — request bodies hold prompt content.
 */
export class CassetteMissError extends Error {
  constructor(descriptor: RequestDescriptor, hash: string) {
    super(
      `Cassette miss in replay-only mode: ${descriptor.method} ${descriptor.pathAndQuery} (hash ${hash}). ` +
        'Replay-only mode is used only by the cassette unit tests; CI runs in record mode and records on miss.'
    );
    this.name = 'CassetteMissError';
  }
}

export interface CreateCassetteFetchOptions {
  store: CassetteStore;
  mode: 'record' | 'replay-only';
  /** Underlying fetch used on record-mode misses. Usually `globalThis.fetch`. */
  realFetch?: typeof globalThis.fetch;
}

export function createCassetteFetch(options: CreateCassetteFetchOptions): typeof globalThis.fetch {
  const { store, mode, realFetch } = options;
  if (mode === 'record' && realFetch === undefined) {
    throw new Error('createCassetteFetch: record mode requires a realFetch');
  }

  return async function cassetteFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const request = new Request(input, init);
    const descriptor = await requestToDescriptor(request);
    const hash = descriptorHash(descriptor);

    const cached = store.read(hash);
    if (cached !== undefined && cached.exchanges.length > 0) {
      return replayFromCassette(cached);
    }

    if (mode === 'replay-only' || realFetch === undefined) {
      throw new CassetteMissError(descriptor, hash);
    }

    const upstream = await realFetch(request);

    if (upstream.status >= 400) {
      return upstream;
    }

    return recordAndPassThrough(upstream, hash, descriptor, store);
  };
}

export function replayFromCassette(cassette: Cassette): Response {
  // Use the first exchange. Each logical operation that produces multiple
  // HTTP calls keys each one to its own cassette — so a single cassette
  // holds one exchange in practice. The caller already guards on
  // `cassette.exchanges.length > 0`; throw explicitly if a hand-edited
  // cassette breaks the invariant rather than reach for a non-null assertion.
  const exchange = cassette.exchanges[0];
  if (exchange === undefined) {
    throw new Error('replayFromCassette invariant: cassette.exchanges is empty');
  }
  if (exchange.chunks.length === 0) {
    return new Response(null, {
      status: exchange.status,
      statusText: exchange.statusText,
      headers: exchange.headers,
    });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const base64 of exchange.chunks) {
        const bytes = Buffer.from(base64, 'base64');
        controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: exchange.status,
    statusText: exchange.statusText,
    headers: exchange.headers,
  });
}

function recordAndPassThrough(
  upstream: Response,
  hash: string,
  descriptor: RequestDescriptor,
  store: CassetteStore
): Response {
  // Tee the body so the caller's read does not consume the chunks we need to
  // record. Both branches share backpressure from the underlying source; the
  // caller's normal full-consume read drives both forward.
  const [callerBranch, recordBranch] = upstream.body === null ? [null, null] : upstream.body.tee();

  // Collect headers as a plain Record for serialization. Skip
  // `content-encoding` because the SDK's response parsers handle decoding
  // before our level — recording the encoded bytes would replay as
  // double-encoded.
  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (name.toLowerCase() === 'content-encoding') continue;
    headers[name] = value;
  }

  const request = {
    method: descriptor.method,
    pathAndQuery: descriptor.pathAndQuery,
    headers: descriptor.headers,
    ...(descriptor.body === undefined ? {} : { body: descriptor.body }),
  };

  if (recordBranch === null) {
    // Bodyless response — record an empty cassette so a future hit replays
    // status + headers correctly.
    store.write(hash, {
      version: 1,
      exchanges: [
        { status: upstream.status, statusText: upstream.statusText, headers, chunks: [] },
      ],
      recordedAt: new Date().toISOString(),
      request,
    });
  } else {
    // Drain the record branch in the background, then write the cassette.
    // The caller's branch drives backpressure; if the caller never reads,
    // this drain stalls until backpressure clears (or the source closes).
    void drainAndStore({
      stream: recordBranch,
      hash,
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
      request,
      store,
    });
  }

  return new Response(callerBranch, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

interface DrainAndStoreInput {
  stream: ReadableStream<Uint8Array>;
  hash: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  request: Cassette['request'];
  store: CassetteStore;
}

async function drainAndStore(input: DrainAndStoreInput): Promise<void> {
  const { stream, hash, status, statusText, headers, request, store } = input;
  const chunks: string[] = [];
  for await (const value of stream as unknown as AsyncIterable<Uint8Array>) {
    // Convert Uint8Array → base64 via Buffer (Node-native, no string churn).
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    chunks.push(buffer.toString('base64'));
  }
  store.write(hash, {
    version: 1,
    exchanges: [{ status, statusText, headers, chunks }],
    recordedAt: new Date().toISOString(),
    request,
  });
}
