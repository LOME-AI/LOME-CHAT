import { describe, expect, it } from 'vitest';
import { canonicalJson, descriptorHash, requestToDescriptor } from './canonical-request.js';

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('strips keys whose value is undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });
});

describe('requestToDescriptor', () => {
  it('captures method, path and canonical body', async () => {
    const descriptor = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', { b: 2, a: 1 })
    );

    expect(descriptor.method).toBe('POST');
    expect(descriptor.pathAndQuery).toBe('/v3/ai/language-model');
    expect(descriptor.body).toBe('{"a":1,"b":2}');
  });

  it('keeps only allowlisted headers', async () => {
    const descriptor = await requestToDescriptor(
      jsonRequest(
        'https://ai-gateway.vercel.sh/v3/ai/language-model',
        {},
        {
          authorization: 'Bearer secret',
          'user-agent': 'ai-sdk/6.0.194',
          'ai-language-model-id': 'openai/gpt-4o',
          'ai-language-model-streaming': 'true',
        }
      )
    );

    expect(descriptor.headers).toEqual({
      'content-type': 'application/json',
      'ai-language-model-id': 'openai/gpt-4o',
      'ai-language-model-streaming': 'true',
    });
  });

  it('strips the generation id query from /v1/generation lookups', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v1/generation?id=gen-abc123')
    );

    expect(descriptor.pathAndQuery).toBe('/v1/generation');
  });

  it('sorts query parameters for other paths', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v1/models?b=2&a=1')
    );

    expect(descriptor.pathAndQuery).toBe('/v1/models?a=1&b=2');
  });

  it('hashes a malformed JSON body as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v3/ai/language-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(descriptor.body).toMatch(/^hex:/);
  });

  it('canonicalizes an empty JSON body to the empty string', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v3/ai/language-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      })
    );

    expect(descriptor.body).toBe('');
  });

  it('hashes a non-JSON body as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v3/ai/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      })
    );

    expect(descriptor.body).toBe('hex:010203');
  });

  it('hashes a body without a content-type header as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v3/ai/upload', {
        method: 'POST',
        body: new Uint8Array([4, 5]).buffer,
      })
    );

    expect(descriptor.body).toBe('hex:0405');
  });

  it('canonicalizes an empty non-JSON body to the empty string', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://ai-gateway.vercel.sh/v3/ai/upload', {
        method: 'POST',
        body: new Blob([]),
      })
    );

    expect(descriptor.body).toBe('');
  });
});

describe('descriptorHash', () => {
  it('produces a stable 16-hex-char hash', async () => {
    const descriptor = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', { a: 1 })
    );

    const first = descriptorHash(descriptor);
    const second = descriptorHash(descriptor);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes requests that differ only by model id header', async () => {
    const base = { body: { prompt: 'hi' } };
    const first = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', base, {
        'ai-language-model-id': 'openai/gpt-4o',
      })
    );
    const second = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', base, {
        'ai-language-model-id': 'anthropic/claude-sonnet-4.5',
      })
    );

    expect(descriptorHash(first)).not.toBe(descriptorHash(second));
  });

  it('distinguishes requests with different bodies', async () => {
    const first = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', { prompt: 'a' })
    );
    const second = await requestToDescriptor(
      jsonRequest('https://ai-gateway.vercel.sh/v3/ai/language-model', { prompt: 'b' })
    );

    expect(descriptorHash(first)).not.toBe(descriptorHash(second));
  });
});
