import { describe, it, expect } from 'vitest';
import { createFixtureFetch } from './payment-helcim-fixtures.js';

describe('createFixtureFetch', () => {
  it('records a bare call with defaulted method, headers, and body', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { ok: true });
    await fixture.fetchImpl('https://example.test/');

    expect(fixture.requests()).toEqual([
      { url: 'https://example.test/', method: 'GET', headers: {}, body: undefined },
    ]);
  });

  it('rejects when no response is queued', async () => {
    const fixture = createFixtureFetch();
    await expect(fixture.fetchImpl('https://example.test/')).rejects.toThrow('no response queued');
  });

  it('records the href of a URL input', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { ok: true });
    await fixture.fetchImpl(new URL('https://example.test/path'));

    expect(fixture.requests()[0]?.url).toBe('https://example.test/path');
  });

  it('records the url of a Request input', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueJson(200, { ok: true });
    await fixture.fetchImpl(new Request('https://example.test/from-request'));

    expect(fixture.requests()[0]?.url).toBe('https://example.test/from-request');
  });

  it('replays raw responses with their status', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueRaw(502, 'oops');
    const response = await fixture.fetchImpl('https://example.test/');

    expect(response.status).toBe(502);
    expect(await response.text()).toBe('oops');
  });

  it('rejects the call when a network error is enqueued', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueNetworkError();

    await expect(fixture.fetchImpl('https://example.test/')).rejects.toThrow('network error');
  });

  it('records the request even when the enqueued response is a network error', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueNetworkError();

    await expect(fixture.fetchImpl('https://example.test/')).rejects.toThrow('network error');
    expect(fixture.requests()).toHaveLength(1);
  });

  it('leaves the call pending when a hang is enqueued', async () => {
    const fixture = createFixtureFetch();
    fixture.enqueueHang();

    let settled = false;
    const pending = (async (): Promise<void> => {
      await fixture.fetchImpl('https://example.test/');
      settled = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(settled).toBe(false);
    void pending;
  });
});
