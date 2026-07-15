/**
 * Installs a global `fetch` shim that answers the demo's API calls from the
 * in-memory {@link DemoBackendStore}, while passing `GET /models` through
 * to the real network so the model list stays current. Everything funnels
 * through `globalThis.fetch` (the typed Hono client's `customFetch`, the SSE
 * consumer, and auth flows all call it), so this single seam intercepts the
 * whole read + send path with the app left completely unmodified.
 *
 * The route resolver is split into small pure functions so it can be
 * unit-tested without patching globals.
 */
import { buildTurnFrames } from './ws-turn-frames';
import { emitDemoTurnFrames } from './ws-shim';
import type { ServerFrame } from '@hushbox/realtime/protocol';
import type { DemoBackendStore } from './store';

export type DemoRouteResult =
  | { kind: 'json'; body: unknown; status?: number }
  | {
      kind: 'run';
      body: unknown;
      conversationId: string;
      frames: ServerFrame[];
      delayMs: number;
      leadDelayMs: number;
    }
  | { kind: 'bytes'; body: Uint8Array; contentType: string }
  | { kind: 'passthrough' }
  | { kind: 'notFound' };

/** Inter-token delay for the streamed reply — paced so the reply visibly types out. */
const STREAM_FRAME_DELAY_MS = 80;
/** One-time pause after `start` for media turns, so image/video "generation" reads as real work. */
const MEDIA_GENERATION_DELAY_MS = 5000;

const CONVERSATION_RE = /^\/conversations\/([^/]+)$/;
const MESSAGES_RE = /^\/conversations\/([^/]+)\/messages$/;
const KEYCHAIN_RE = /^\/conversations\/([^/]+)\/keychain$/;
const MEMBERS_RE = /^\/conversations\/([^/]+)\/members$/;
const LINKS_RE = /^\/conversations\/([^/]+)\/links$/;
const MEDIA_DOWNLOAD_RE = /^\/media\/([^/]+)\/download-url$/;
const MEDIA_BLOB_RE = /^\/media\/([^/]+)\/blob$/;

/**
 * Every API prefix the app can address on the rebuilt backend. Requests under
 * these never leave the demo (unknown ones 404); anything else (assets,
 * fonts, the announcements banner) passes through to the real network.
 */
const INTERCEPTED_PREFIXES = [
  '/api/',
  '/chat',
  '/conversations',
  '/billing',
  '/media',
  '/account',
  '/auth',
  '/notifications',
  '/updates',
] as const;

function parameter(re: RegExp, pathname: string): string | null {
  const match = re.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? '') : null;
}

function jsonOr404(body: unknown): DemoRouteResult {
  return body === undefined ? { kind: 'notFound' } : { kind: 'json', body };
}

/** Unknown API routes are harmless to 404; non-API requests (assets, fonts) pass through. */
function fallthrough(pathname: string): DemoRouteResult {
  return INTERCEPTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ? { kind: 'notFound' }
    : { kind: 'passthrough' };
}

function resolveGetExact(
  store: DemoBackendStore,
  pathname: string,
  searchParams: URLSearchParams
): DemoRouteResult | null {
  // Real, read-only call kept live so the model catalog stays current.
  if (pathname === '/models') return { kind: 'passthrough' };
  if (pathname === '/conversations') return { kind: 'json', body: store.listConversations() };
  if (pathname === '/billing/balance') return { kind: 'json', body: store.getBalance() };
  // Batch keychain refresh is a GET with a comma-separated id list.
  if (pathname === '/conversations/member-keys/batch') {
    const ids = (searchParams.get('conversationIds') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return { kind: 'json', body: store.getKeyChainBatch(ids) };
  }
  return null;
}

function resolveGetParameter(store: DemoBackendStore, pathname: string): DemoRouteResult | null {
  const conversationId = parameter(CONVERSATION_RE, pathname);
  if (conversationId !== null) return jsonOr404(store.getConversation(conversationId));
  const messagesId = parameter(MESSAGES_RE, pathname);
  if (messagesId !== null) return jsonOr404(store.getMessagesPage(messagesId));
  const keychainId = parameter(KEYCHAIN_RE, pathname);
  if (keychainId !== null) return jsonOr404(store.getKeyChain(keychainId));
  const membersId = parameter(MEMBERS_RE, pathname);
  if (membersId !== null) return { kind: 'json', body: store.getMembers(membersId) };
  const linksId = parameter(LINKS_RE, pathname);
  if (linksId !== null) return { kind: 'json', body: store.getLinks(linksId) };
  const mediaId = parameter(MEDIA_DOWNLOAD_RE, pathname);
  if (mediaId !== null) return jsonOr404(store.getMediaDownloadUrl(mediaId));
  const blobId = parameter(MEDIA_BLOB_RE, pathname);
  if (blobId !== null) {
    const bytes = store.getMediaBytes(blobId);
    return bytes === undefined
      ? { kind: 'notFound' }
      : { kind: 'bytes', body: bytes, contentType: 'application/octet-stream' };
  }
  return null;
}

function resolveGet(
  store: DemoBackendStore,
  pathname: string,
  searchParams: URLSearchParams
): DemoRouteResult {
  return (
    resolveGetExact(store, pathname, searchParams) ??
    resolveGetParameter(store, pathname) ??
    fallthrough(pathname)
  );
}

function resolveCreateConversation(
  store: DemoBackendStore,
  readBody: () => unknown
): DemoRouteResult {
  const body = readBody() as { id?: string; title?: string; epochPublicKey?: string } | undefined;
  if (body?.id === undefined || body.epochPublicKey === undefined) return { kind: 'notFound' };
  return {
    kind: 'json',
    status: 201,
    body: store.createConversation({
      id: body.id,
      epochPublicKey: body.epochPublicKey,
      ...(body.title === undefined ? {} : { title: body.title }),
    }),
  };
}

/** Wraps a recorded turn as the run response + the frames the WS pushes. */
function runResult(
  conversationId: string,
  turn:
    | {
        modelId: string;
        content: string;
        media?: { mediaType: 'image' | 'video'; mimeType: string };
      }
    | undefined
): DemoRouteResult {
  if (turn === undefined) return { kind: 'notFound' };
  const runId = crypto.randomUUID();
  return {
    kind: 'run',
    conversationId,
    body: { runId, deadlineAt: Date.now() + 300_000 },
    frames: buildTurnFrames({
      runId,
      modelId: turn.modelId,
      content: turn.content,
      ...(turn.media === undefined ? {} : { media: turn.media }),
    }),
    delayMs: STREAM_FRAME_DELAY_MS,
    leadDelayMs: turn.media === undefined ? 0 : MEDIA_GENERATION_DELAY_MS,
  };
}

function resolveChatRun(store: DemoBackendStore, readBody: () => unknown): DemoRouteResult {
  const body = readBody() as
    | {
        conversationId?: string;
        model?: string;
        models?: string[];
        userMessage?: { id: string; content: string };
      }
    | undefined;
  if (body?.userMessage === undefined || body.conversationId === undefined) {
    return { kind: 'notFound' };
  }
  const turn = store.recordSendTurn(
    body.conversationId,
    body.userMessage,
    body.models?.[0] ?? body.model ?? 'demo-model'
  );
  return runResult(body.conversationId, turn);
}

function resolveRegenerate(store: DemoBackendStore, readBody: () => unknown): DemoRouteResult {
  const body = readBody() as
    | {
        conversationId?: string;
        targetMessageId?: string;
        replaceAssistantId?: string;
        models?: string[];
        model?: string;
      }
    | undefined;
  if (body?.targetMessageId === undefined || body.conversationId === undefined) {
    return { kind: 'notFound' };
  }
  const models = body.models ?? (body.model === undefined ? undefined : [body.model]);
  const turn = store.recordRegenerateTurn({
    conversationId: body.conversationId,
    targetMessageId: body.targetMessageId,
    ...(body.replaceAssistantId === undefined
      ? {}
      : { replaceAssistantId: body.replaceAssistantId }),
    ...(models === undefined ? {} : { models }),
  });
  return runResult(body.conversationId, turn);
}

function resolvePost(
  store: DemoBackendStore,
  pathname: string,
  readBody: () => unknown
): DemoRouteResult {
  if (pathname === '/conversations') return resolveCreateConversation(store, readBody);
  if (pathname === '/chat' || pathname === '/chat/') return resolveChatRun(store, readBody);
  if (pathname === '/chat/regenerate') return resolveRegenerate(store, readBody);
  if (pathname === '/chat/stop') return { kind: 'json', body: { stopped: false } };
  return fallthrough(pathname);
}

interface DescribedRequest {
  pathname: string;
  method: string;
  readBody: () => unknown;
  searchParams?: URLSearchParams;
}

/** Map a request to a demo response. `readBody` lazily parses the POST JSON body. */
export function resolveDemoRoute(
  store: DemoBackendStore,
  request: DescribedRequest
): DemoRouteResult {
  const { pathname, method, readBody, searchParams = new URLSearchParams() } = request;
  const m = method.toUpperCase();
  if (m === 'GET') return resolveGet(store, pathname, searchParams);
  if (m === 'POST') return resolvePost(store, pathname, readBody);
  return fallthrough(pathname);
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): DescribedRequest {
  const url = new URL(requestUrl(input), globalThis.location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const bodySource = init?.body;
  const readBody = (): unknown => {
    if (typeof bodySource !== 'string') return undefined;
    try {
      return JSON.parse(bodySource);
    } catch {
      return undefined;
    }
  };
  return { pathname: url.pathname, method, readBody, searchParams: url.searchParams };
}

/** Patch `globalThis.fetch`. Returns an uninstaller that restores the original. */
export function installFetchShim(store: DemoBackendStore): () => void {
  // Capture the exact reference (not a bound copy) so uninstall fully restores
  // it; `fetch` is safe to invoke unbound.
  const original = globalThis.fetch;

  const shim: typeof globalThis.fetch = async (input, init) => {
    const route = resolveDemoRoute(store, describeRequest(input, init));
    switch (route.kind) {
      case 'passthrough': {
        return original(input, init);
      }
      case 'notFound': {
        return new Response(null, { status: 404 });
      }
      case 'json': {
        return Response.json(route.body, { status: route.status ?? 200 });
      }
      case 'run': {
        // Answer 201 immediately; the reply then streams over the demo's
        // conversation WebSocket exactly as against the real backend.
        emitDemoTurnFrames(route.conversationId, route.frames, {
          delayMs: route.delayMs,
          leadDelayMs: route.leadDelayMs,
        });
        return Response.json(route.body, { status: 201 });
      }
      case 'bytes': {
        // Copy into a fresh ArrayBuffer-backed Uint8Array: the stored bytes are
        // typed `Uint8Array<ArrayBufferLike>`, which `BodyInit` rejects (it
        // excludes SharedArrayBuffer-backed views); the copy is `Uint8Array<ArrayBuffer>`.
        return new Response(new Uint8Array(route.body), {
          status: 200,
          headers: { 'Content-Type': route.contentType },
        });
      }
    }
  };

  globalThis.fetch = shim;
  return () => {
    globalThis.fetch = original;
  };
}
