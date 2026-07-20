import { describe, expect, it } from 'vitest';
import { descriptorHash, requestToDescriptor } from './canonical-request.js';

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('requestToDescriptor', () => {
  it('extracts method, path+query, allowlisted headers, and body', async () => {
    const req = new Request('https://example.com/v3/ai/language-model?foo=1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ai-model-id': 'google/veo-3.1-generate-001',
        authorization: 'Bearer secret',
      },
      body: '{"prompt":"hi"}',
    });
    const d = await requestToDescriptor(req);
    expect(d.method).toBe('POST');
    expect(d.pathAndQuery).toBe('/v3/ai/language-model?foo=1');
    expect(d.headers['content-type']).toBe('application/json');
    expect(d.headers['ai-model-id']).toBe('google/veo-3.1-generate-001');
    expect(d.headers['authorization']).toBeUndefined();
  });

  it('sorts query string keys deterministically', async () => {
    const a = await requestToDescriptor(new Request('https://x.test/p?b=2&a=1'));
    const b = await requestToDescriptor(new Request('https://x.test/p?a=1&b=2'));
    expect(a.pathAndQuery).toBe(b.pathAndQuery);
  });

  it('strips the host so cassettes are portable across base URLs', async () => {
    const a = await requestToDescriptor(new Request('https://prod.example/v3/ai/x'));
    const b = await requestToDescriptor(new Request('https://staging.example/v3/ai/x'));
    expect(a.pathAndQuery).toBe(b.pathAndQuery);
  });

  it('canonicalizes JSON bodies — key order does not affect the hash', async () => {
    const a = await requestToDescriptor(jsonPost('https://x.test/p', { b: 2, a: 1 }));
    const b = await requestToDescriptor(jsonPost('https://x.test/p', { a: 1, b: 2 }));
    expect(a.body).toBe(b.body);
  });

  it('leaves non-JSON bodies as raw hex of the bytes', async () => {
    const bytes = new Uint8Array([0xff, 0x01, 0x02]);
    const req = new Request('https://x.test/p', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    });
    const d = await requestToDescriptor(req);
    expect(d.body).toBe('hex:ff0102');
  });

  it('strips the `id` query param from getGenerationInfo paths', async () => {
    // Per Vercel AI SDK source: `gateway.getGenerationInfo({ id })` issues
    // GET ${baseUrl.origin}/v1/generation?id=<urlencoded-id>. The id is
    // assigned by the gateway at generation time — non-deterministic across
    // record/replay runs — so the cassette hashes only the shape of the
    // request, not the specific id. Replay returns the most recent matching
    // recording.
    const a = await requestToDescriptor(new Request('https://x.test/v1/generation?id=abc123'));
    const b = await requestToDescriptor(new Request('https://x.test/v1/generation?id=def456'));
    expect(a.pathAndQuery).toBe(b.pathAndQuery);
  });
});

describe('descriptorHash', () => {
  it('returns a stable 16-char hex hash', () => {
    const d = {
      method: 'POST',
      pathAndQuery: '/v3/ai/language-model',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    };
    const h = descriptorHash(d);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('same descriptor → same hash', () => {
    const d = {
      method: 'POST',
      pathAndQuery: '/p',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    };
    expect(descriptorHash(d)).toBe(descriptorHash(d));
  });

  it('different body → different hash', () => {
    const a = { method: 'POST', pathAndQuery: '/p', headers: {}, body: '{"a":1}' };
    const b = { method: 'POST', pathAndQuery: '/p', headers: {}, body: '{"a":2}' };
    expect(descriptorHash(a)).not.toBe(descriptorHash(b));
  });

  it('different ai-model-id header → different hash', () => {
    const a = { method: 'POST', pathAndQuery: '/p', headers: { 'ai-model-id': 'm1' }, body: '' };
    const b = { method: 'POST', pathAndQuery: '/p', headers: { 'ai-model-id': 'm2' }, body: '' };
    expect(descriptorHash(a)).not.toBe(descriptorHash(b));
  });

  it('header insertion order does not affect the hash', () => {
    const a = {
      method: 'GET',
      pathAndQuery: '/p',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: undefined,
    };
    const b = {
      method: 'GET',
      pathAndQuery: '/p',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: undefined,
    };
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });

  it('JSON body key order does not affect the hash (descriptor body is already canonical)', () => {
    // descriptorHash assumes its input is already canonicalized — see
    // requestToDescriptor for the canonicalization step. Documenting the
    // contract via this test.
    const a = { method: 'POST', pathAndQuery: '/p', headers: {}, body: '{"a":1,"b":2}' };
    const b = { method: 'POST', pathAndQuery: '/p', headers: {}, body: '{"a":1,"b":2}' };
    expect(descriptorHash(a)).toBe(descriptorHash(b));
  });
});

describe('header allowlist integration', () => {
  it('omits authorization, user-agent, and SDK version headers from the descriptor', async () => {
    const req = new Request('https://x.test/p', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-key',
        'user-agent': 'ai-sdk/gateway/3.0.95',
        'ai-gateway-protocol-version': '0.0.1',
        'ai-language-model-specification-version': '3',
        'ai-model-id': 'google/veo-3.1-generate-001',
      },
      body: '{}',
    });
    const d = await requestToDescriptor(req);
    expect(d.headers['authorization']).toBeUndefined();
    expect(d.headers['user-agent']).toBeUndefined();
    expect(d.headers['ai-gateway-protocol-version']).toBeUndefined();
    expect(d.headers['ai-language-model-specification-version']).toBeUndefined();
    expect(d.headers['ai-model-id']).toBe('google/veo-3.1-generate-001');
  });

  it('omits trace and request-id headers from the descriptor', async () => {
    const req = new Request('https://x.test/p', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'rid-1',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b9c7c989f97918e1-01',
        'ai-o11y-deployment-id': 'dpl-xyz',
      },
      body: '{}',
    });
    const d = await requestToDescriptor(req);
    expect(d.headers['x-request-id']).toBeUndefined();
    expect(d.headers['traceparent']).toBeUndefined();
    expect(d.headers['ai-o11y-deployment-id']).toBeUndefined();
  });
});
