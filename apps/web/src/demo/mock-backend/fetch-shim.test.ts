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

  it('serves the key-chain for a known conversation', () => {
    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: `/conversations/${KNOWN_ID}/keychain`,
      readBody: noBody,
    });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getKeyChain(KNOWN_ID));
  });

  it('serves an empty key-chain batch when the conversationIds query is absent', () => {
    const route = resolveDemoRoute(store, {
      method: 'GET',
      pathname: '/conversations/member-keys/batch',
      readBody: noBody,
    });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.body).toEqual(store.getKeyChainBatch([]));
  });

  it('creates a conversation with a title and 201 status', () => {
    const fresh = makeStore();
    const route = resolveDemoRoute(fresh, {
      method: 'POST',
      pathname: '/conversations',
      readBody: () => ({ id: 'made-1', epochPublicKey: 'AA==', title: 'My chat' }),
    });
    if (route.kind !== 'json') throw new Error('expected json');
    expect(route.status).toBe(201);
    expect(fresh.getConversation('made-1')?.conversation.title).toBe('My chat');
  });

  it('creates a conversation without a title', () => {
    const fresh = makeStore();
    const route = resolveDemoRoute(fresh, {
      method: 'POST',
      pathname: '/conversations',
      readBody: () => ({ id: 'made-2', epochPublicKey: 'AA==' }),
    });
    expect(route.kind).toBe('json');
    expect(fresh.getConversation('made-2')?.conversation.title).toBe('');
  });

  it('404s a create without an id or epoch public key', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/conversations',
        readBody: () => ({ id: 'x' }),
      })
    ).toEqual({ kind: 'notFound' });
  });

  it('404s a chat run for an unknown conversation', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/chat',
        readBody: () => ({
          conversationId: 'no-such-conversation',
          userMessage: { id: 'u1', content: 'hi' },
        }),
      })
    ).toEqual({ kind: 'notFound' });
  });

  it('picks the first of a models array, else the model, else a default', () => {
    const a = makeStore();
    const multi = resolveDemoRoute(a, {
      method: 'POST',
      pathname: '/chat',
      readBody: () => ({
        conversationId: KNOWN_ID,
        models: ['first-model', 'second-model'],
        userMessage: { id: 'u1', content: 'hi' },
      }),
    });
    expect(multi.kind).toBe('run');
    expect(
      a.getMessages(KNOWN_ID)?.find((m) => m.senderType === 'ai')?.contentItems[0]?.modelName
    ).toBe('first-model');

    const b = makeStore();
    const none = resolveDemoRoute(b, {
      method: 'POST',
      pathname: '/chat',
      readBody: () => ({ conversationId: KNOWN_ID, userMessage: { id: 'u1', content: 'hi' } }),
    });
    expect(none.kind).toBe('run');
    expect(
      b.getMessages(KNOWN_ID)?.find((m) => m.senderType === 'ai')?.contentItems[0]?.modelName
    ).toBe('demo-model');
  });

  it('resolves regenerate with a single model, a replaceAssistantId, or neither', () => {
    // Each fresh store gets one recorded turn to regenerate; the returned kind is
    // 'run' when the target resolves, exercising each option-assembly branch of
    // resolveRegenerate (single model / replaceAssistantId / neither).
    const regenerate = (
      pick: (userId: string, aiId: string) => Record<string, unknown>
    ): string => {
      const fresh = makeStore();
      fresh.recordSendTurn(KNOWN_ID, { id: 'u1', content: 'hi' }, 'm');
      const user = fresh.getMessages(KNOWN_ID)?.find((m) => m.senderType === 'user');
      const ai = fresh.getMessages(KNOWN_ID)?.find((m) => m.senderType === 'ai');
      if (user === undefined || ai === undefined) throw new Error('missing messages');
      return resolveDemoRoute(fresh, {
        method: 'POST',
        pathname: '/chat/regenerate',
        readBody: () => ({
          conversationId: KNOWN_ID,
          targetMessageId: user.id,
          ...pick(user.id, ai.id),
        }),
      }).kind;
    };

    expect(regenerate(() => ({ model: 'solo-model' }))).toBe('run');
    expect(regenerate((_u, aiId) => ({ replaceAssistantId: aiId, models: ['m'] }))).toBe('run');
    expect(regenerate(() => ({}))).toBe('run');
  });

  it('falls through an unknown POST route and a non-GET/POST method', () => {
    expect(
      resolveDemoRoute(store, {
        method: 'POST',
        pathname: '/account/something',
        readBody: () => ({}),
      })
    ).toEqual({ kind: 'notFound' });
    expect(
      resolveDemoRoute(store, {
        method: 'DELETE',
        pathname: `/conversations/${KNOWN_ID}`,
        readBody: noBody,
      })
    ).toEqual({ kind: 'notFound' });
    expect(
      resolveDemoRoute(store, { method: 'DELETE', pathname: '/assets/x.png', readBody: noBody })
    ).toEqual({ kind: 'passthrough' });
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

  it('creates a conversation via a POST with a 201 status', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/conversations`, {
      method: 'POST',
      body: JSON.stringify({ id: 'shim-created', epochPublicKey: 'AA==', title: 'Made' }),
    });
    expect(res.status).toBe(201);

    uninstall();
  });

  it('reads the method and url from a Request object input', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(new Request(`${API}/conversations`, { method: 'GET' }));
    expect(await res.json()).toEqual(store.listConversations());

    uninstall();
  });

  it('reads the url from a URL object input', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(new URL(`${API}/billing/balance`));
    expect(await res.json()).toEqual(store.getBalance());

    uninstall();
  });

  it('answers an unknown API route with a 404', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/account/preferences/accessibility`);
    expect(res.status).toBe(404);

    uninstall();
  });

  it('serves media ciphertext bytes through the shim', async () => {
    const store = makeStore();
    store.recordSendTurn('demo-image', { id: 'u1', content: 'go' }, 'm');
    const mediaItem = store
      .getMessages('demo-image')
      ?.find((m) => m.senderType === 'ai')
      ?.contentItems.find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');
    const uninstall = installFetchShim(store);

    const res = await fetch(`${API}/media/${mediaItem.id}/blob`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(store.getMediaBytes(mediaItem.id));

    uninstall();
  });

  it('treats an absent or unparseable POST body as no body (404)', async () => {
    const store = makeStore();
    const uninstall = installFetchShim(store);

    const noBodyRes = await fetch(`${API}/conversations`, { method: 'POST' });
    expect(noBodyRes.status).toBe(404);

    const badJsonRes = await fetch(`${API}/conversations`, { method: 'POST', body: '{not json' });
    expect(badJsonRes.status).toBe(404);

    uninstall();
  });
});
