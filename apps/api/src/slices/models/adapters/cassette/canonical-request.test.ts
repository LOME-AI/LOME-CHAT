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
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', { b: 2, a: 1 })
    );

    expect(descriptor.method).toBe('POST');
    expect(descriptor.pathAndQuery).toBe('/api/v1/chat/completions');
    expect(descriptor.body).toBe('{"a":1,"b":2}');
  });

  it('keeps only the deterministic wire headers and never the Authorization key', async () => {
    const descriptor = await requestToDescriptor(
      jsonRequest(
        'https://openrouter.ai/api/v1/chat/completions',
        {},
        {
          authorization: 'Bearer secret',
          'user-agent': 'ai-sdk/6.0.194',
          accept: 'application/json',
        }
      )
    );

    expect(descriptor.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
    });
  });

  it('sorts query parameters', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/models?b=2&a=1')
    );

    expect(descriptor.pathAndQuery).toBe('/api/v1/models?a=1&b=2');
  });

  it('hashes a malformed JSON body as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })
    );

    expect(descriptor.body).toMatch(/^hex:/);
  });

  it('canonicalizes an empty JSON body to the empty string', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '',
      })
    );

    expect(descriptor.body).toBe('');
  });

  it('hashes a non-JSON body as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array([1, 2, 3]),
      })
    );

    expect(descriptor.body).toBe('hex:010203');
  });

  it('hashes a body without a content-type header as raw hex', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/upload', {
        method: 'POST',
        body: new Uint8Array([4, 5]).buffer,
      })
    );

    expect(descriptor.body).toBe('hex:0405');
  });

  it('canonicalizes an empty non-JSON body to the empty string', async () => {
    const descriptor = await requestToDescriptor(
      new Request('https://openrouter.ai/api/v1/upload', {
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
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', { a: 1 })
    );

    const first = descriptorHash(descriptor);
    const second = descriptorHash(descriptor);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes requests that differ only by the body model id', async () => {
    // OpenRouter carries the model id in the body, so identical prompts on
    // different models hash apart without any model-id header.
    const first = await requestToDescriptor(
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', {
        model: 'openai/gpt-4o',
        prompt: 'hi',
      })
    );
    const second = await requestToDescriptor(
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', {
        model: 'anthropic/claude-sonnet-4.5',
        prompt: 'hi',
      })
    );

    expect(descriptorHash(first)).not.toBe(descriptorHash(second));
  });

  it('distinguishes requests with different bodies', async () => {
    const first = await requestToDescriptor(
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', { prompt: 'a' })
    );
    const second = await requestToDescriptor(
      jsonRequest('https://openrouter.ai/api/v1/chat/completions', { prompt: 'b' })
    );

    expect(descriptorHash(first)).not.toBe(descriptorHash(second));
  });
});
