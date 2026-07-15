import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPair } from '@hushbox/crypto';
import { DemoBackendStore } from './store';
import { resolveDemoRoute, installFetchShim } from './fetch-shim';
import { DEMO_CONVERSATIONS } from './fixtures';

const KNOWN_ID = DEMO_CONVERSATIONS[0]!.id;
const API = 'http://localhost:8787';

function makeStore(): DemoBackendStore {
  return new DemoBackendStore(generateKeyPair().publicKey);
}

describe('resolveDemoRoute', () => {
  const store = makeStore();
  const noBody = (): unknown => undefined;

  it('passes GET /models through to the real network', () => {
    expect(
      resolveDemoRoute(store, { method: 'GET', pathname: '/models', readBody: noBody })
    ).toEqual({ kind: 'passthrough' });
  });

  it('serves the conversation list', () => {
    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: '/conversations',
      readBody: noBody,
    });
    expect(route).toMatchObject({ kind: 'json' });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.listConversations());
  });

  it('serves a known conversation and 404s an unknown one', () => {
    const known = resolveDemoRoute(store, {
      method: 'GET',
      pathname: `/conversations/${KNOWN_ID}`,
      readBody: noBody,
    });
    expect(known).toMatchObject({ kind: 'json' });
    expect(
      resolveDemoRoute(store, { method: 'GET', pathname: '/conversations/nope', readBody: noBody })
    ).toEqual({
      kind: 'notFound',
    });
  });

  it('serves the key-chain batch from the conversationIds query', () => {
    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: '/conversations/member-keys/batch',
      readBody: noBody,
      searchParams: new URLSearchParams({ conversationIds: KNOWN_ID }),
    });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getKeyChainBatch([KNOWN_ID]));
  });

  it('serves balance, members and links', () => {
    expect(
      resolveDemoRoute(store, { method: 'GET', pathname: '/billing/balance', readBody: noBody })
    ).toMatchObject({
      kind: 'json',
    });
    expect(
      resolveDemoRoute(store, {
        method: 'GET',
        pathname: `/conversations/${KNOWN_ID}/members`,
        readBody: noBody,
      })
    ).toMatchObject({
      kind: 'json',
    });
    expect(
      resolveDemoRoute(store, {
        method: 'GET',
        pathname: `/conversations/${KNOWN_ID}/links`,
        readBody: noBody,
      })
    ).toMatchObject({
      kind: 'json',
    });
  });

  it('serves the paginated message history and 404s an unknown conversation', () => {
    store.fillConversation(KNOWN_ID);
    const known = resolveDemoRoute(store, {
      method: 'GET',
      pathname: `/conversations/${KNOWN_ID}/messages`,
      readBody: noBody,
    });
    expect(known).toMatchObject({ kind: 'json' });
    if (known.kind !== 'json') throw new Error('expected json');
    expect(known.body).toEqual(store.getMessagesPage(KNOWN_ID));
    expect(
      resolveDemoRoute(store, {
        method: 'GET',
        pathname: '/conversations/nope/messages',
        readBody: noBody,
      })
    ).toEqual({ kind: 'notFound' });
  });

  it('serves a media download url for a known content item and 404s an unknown one', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const messages = store.getMessages('demo-image');
    if (messages === undefined) throw new Error('no conversation');
    const aiMessage = messages.find((m) => m.senderType === 'ai');
    const mediaItem = aiMessage?.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');

    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: `/media/${mediaItem.id}/download-url`,
      readBody: noBody,
    });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getMediaDownloadUrl(mediaItem.id));

    expect(
      resolveDemoRoute(store, {
        method: 'GET',
        pathname: '/media/nope/download-url',
        readBody: noBody,
      })
    ).toEqual({
      kind: 'notFound',
    });
  });

  it('serves media ciphertext bytes for a known blob url and 404s an unknown one', () => {
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const aiMessage = store.getMessages('demo-image')?.find((m) => m.senderType === 'ai');
    const mediaItem = aiMessage?.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');

    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: `/media/${mediaItem.id}/blob`,
      readBody: noBody,
    });
    if (route.kind !== 'bytes') throw new Error('expected bytes');
    expect(route.body).toEqual(store.getMediaBytes(mediaItem.id));
    expect(route.contentType).toBe('application/octet-stream');

    expect(
      resolveDemoRoute(store, { method: 'GET', pathname: '/media/nope/blob', readBody: noBody })
    ).toEqual({
      kind: 'notFound',
    });
  });

  it('answers POST /chat with a run handle and run frames', () => {
    const route = resolveDemoRoute(store, {
      method: 'POST',
      pathname: '/chat',
      readBody: () => ({
        conversationId: KNOWN_ID,
        model: 'm',
        userMessage: { id: 'u1', content: 'hi' },
      }),
    });
    expect(route.kind).toBe('run');
    if (route.kind !== 'run') throw new Error('expected run');
    expect(route.body).toMatchObject({ runId: expect.any(String), deadlineAt: expect.any(Number) });
    expect(route.conversationId).toBe(KNOWN_ID);
    expect(route.frames[0]).toMatchObject({ type: 'run-started' });
    expect(route.frames.at(-1)).toMatchObject({ type: 'run-finished' });
  });

  it('streams a media turn with a generation lead delay and text with none', () => {
    const fresh = makeStore();
    const text = resolveDemoRoute(fresh, {
      method: 'POST',
      pathname: '/chat',
      readBody: () => ({
        conversationId: KNOWN_ID,
        model: 'm',
        userMessage: { id: 'u1', content: 'hi' },
      }),
    });
    if (text.kind !== 'run') throw new Error('expected run');
    expect(text.leadDelayMs).toBe(0);

    const media = resolveDemoRoute(fresh, {
      method: 'POST',
      pathname: '/chat',
      readBody: () => ({
        conversationId: 'demo-image',
        model: 'm',
        userMessage: { id: 'u2', content: 'go' },
      }),
    });
    if (media.kind !== 'run') throw new Error('expected run');
    expect(media.leadDelayMs).toBe(5000);
    // The media turn announces generation so the optimistic UI shows the
    // "Generating image…" placeholder rather than the generic text indicator.
    const kinds = (frames: typeof media.frames): string[] =>
      frames.map((f) => (f.type === 'stream' ? f.event.kind : f.type));
    expect(kinds(media.frames)).toContain('media-start');
    expect(kinds(text.frames)).not.toContain('media-start');
  });

  it('404s a run POST without a userMessage', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/chat',
        readBody: () => ({ conversationId: KNOWN_ID }),
      })
    ).toEqual({
      kind: 'notFound',
    });
  });

  it('answers a regenerate POST with a run handle', () => {
    const userMessage = store.getMessages(KNOWN_ID)?.find((m) => m.senderType === 'user');
    if (userMessage === undefined) throw new Error('no user message');
    const route = resolveDemoRoute(store, {
      method: 'POST',
      pathname: '/chat/regenerate',
      readBody: () => ({
        conversationId: KNOWN_ID,
        targetMessageId: userMessage.id,
        models: ['m'],
      }),
    });
    expect(route.kind).toBe('run');
    if (route.kind !== 'run') throw new Error('expected run');
    expect(route.frames[0]).toMatchObject({ type: 'run-started' });
  });

  it('404s a regenerate POST without a targetMessageId', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/chat/regenerate',
        readBody: () => ({ conversationId: KNOWN_ID }),
      })
    ).toEqual({
      kind: 'notFound',
    });
  });

  it('answers /chat/stop with an idempotent stopped:false', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/chat/stop',
        readBody: () => ({ conversationId: KNOWN_ID }),
      })
    ).toEqual({ kind: 'json', body: { stopped: false } });
  });

  it('404s unknown API routes but passes non-API requests through', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'GET',
        pathname: '/account/preferences/accessibility',
        readBody: noBody,
      })
    ).toEqual({
      kind: 'notFound',
    });
    expect(
      resolveDemoRoute(store, { method: 'GET', pathname: '/assets/logo.png', readBody: noBody })
    ).toEqual({
      kind: 'passthrough',
    });
  });
});

describe('installFetchShim', () => {
  let originalFetch: typeof globalThis.fetch;
  let passthrough: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    passthrough = vi.fn(() => Promise.resolve(new Response('real', { status: 200 })));
    globalThis.fetch = passthrough as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serves demo endpoints from the store without hitting the network', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/conversations`);
    expect(await res.json()).toEqual(store.listConversations());
    expect(passthrough).not.toHaveBeenCalled();

    uninstall();
  });

  it('passes /models through to the real fetch', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    await fetch(`${API}/models`);
    expect(passthrough).toHaveBeenCalledTimes(1);

    uninstall();
    expect(globalThis.fetch).toBe(passthrough);
  });

  it('reads the query string of a GET to resolve the route', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/conversations/member-keys/batch?conversationIds=${KNOWN_ID}`);
    expect(await res.json()).toEqual(store.getKeyChainBatch([KNOWN_ID]));

    uninstall();
  });

  it('answers a chat send with a 201 run handle', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: KNOWN_ID,
        model: 'm',
        userMessage: { id: 'u1', content: 'hi' },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId?: string; deadlineAt?: number };
    expect(body.runId).toEqual(expect.any(String));
    expect(body.deadlineAt).toEqual(expect.any(Number));

    uninstall();
  });
});
