/**
 * HTTP cassette interceptor — wraps a fetch-shaped function so calls are
 * transparently recorded on first observation and replayed on subsequent
 * matching observations.
 *
 * Hit/miss semantics:
 *   - Hit (cassette exists for hash): replay synthetically; never call upstream.
 *   - Miss + success (<400): pass through to caller AND record the cassette.
 *   - Miss + error (>=400, i.e. 4xx or 5xx): pass through; do NOT record. A
 *     failed gateway request bills nothing, so re-running it live every time is
 *     free — whereas caching it would replay a stale, transient failure (auth /
 *     plan / rate-limit / server) forever and poison every later run. Only
 *     successful (billable) responses are worth recording. This is why a 403
 *     ZdrUnauthorized must never be cached.
 *   - Network failure / throw: pass the error through; do NOT record.
 *
 * Sequence-of-exchanges: each fetch call generates its own cassette entry
 * keyed by hash. The AI SDK's url-fallback download path (for providers that
 * return `type: 'url'` instead of base64) is therefore captured naturally —
 * the first fetch records the gateway response containing the URL, replay
 * returns the same URL, and the SDK's follow-up `defaultDownload(url)` then
 * hits a separately-keyed cassette entry. No special multi-exchange logic
 * needed at this layer.
 */

import { requestToDescriptor, descriptorHash } from './canonical-request.js';
import type { Cassette, CassetteStore } from './cassette-store.js';

export interface CreateCassetteFetchOptions {
  store: CassetteStore;
  /** Underlying fetch used on cassette misses. Usually `globalThis.fetch`. */
  realFetch: typeof globalThis.fetch;
}

export function createCassetteFetch(options: CreateCassetteFetchOptions): typeof globalThis.fetch {
  const { store, realFetch } = options;

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

    const upstream = await realFetch(request);

    if (upstream.status >= 400) {
      return upstream;
    }

    return recordAndPassThrough(upstream, hash, store);
  };
}

function replayFromCassette(cassette: Cassette): Response {
  // Use the first exchange. Per the sequence-of-exchanges design, each
  // logical operation that produces multiple HTTP calls keys each one to its
  // own cassette — so a single cassette holds one exchange in practice.
  // The caller already guards on `cassette.exchanges.length > 0`, so this
  // narrowing is safe; we explicitly throw if the invariant is ever broken
  // by a hand-edited cassette file rather than reach for a non-null assertion.
  const exchange = cassette.exchanges[0];
  if (exchange === undefined) {
    throw new Error('replayFromCassette invariant: cassette.exchanges is empty');
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

function recordAndPassThrough(upstream: Response, hash: string, store: CassetteStore): Response {
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

  if (recordBranch === null) {
    // Bodyless response — record an empty cassette so a future hit replays
    // status + headers correctly.
    store.write(hash, {
      version: 1,
      exchanges: [
        { status: upstream.status, statusText: upstream.statusText, headers, chunks: [] },
      ],
      recordedAt: new Date().toISOString(),
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
  store: CassetteStore;
}

async function drainAndStore(input: DrainAndStoreInput): Promise<void> {
  const { stream, hash, status, statusText, headers, store } = input;
  const chunks: string[] = [];
  for await (const value of stream as unknown as AsyncIterable<Uint8Array>) {
    // Convert Uint8Array → base64 via Buffer (Node-native, no string churn).
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    chunks.push(buffer.toString('base64'));
  }
  // GITHUB_SHA is a GitHub Actions runtime detail, not part of envConfig — it
  // doesn't have a slot in envUtils. Reading process.env directly is the
  // pragmatic choice for cassette diagnostics; production code never runs
  // through this path.
  store.write(hash, {
    version: 1,
    exchanges: [{ status, statusText, headers, chunks }],
    recordedAt: new Date().toISOString(),
    ...(process.env['GITHUB_SHA'] !== undefined && { recordedFromSha: process.env['GITHUB_SHA'] }),
  });
}
