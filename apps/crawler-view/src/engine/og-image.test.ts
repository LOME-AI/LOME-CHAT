import { describe, it, expect } from 'vitest';
import { checkImageReachable } from './og-image';
import { mockFetch } from './__test-fixtures-mocks__/mock-fetch';

describe('checkImageReachable', () => {
  it('reports a reachable image from a HEAD 200', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 200 }));
    const status = await checkImageReachable('https://cdn.test/i.png', fetchImpl);
    expect(status).toEqual({ checked: true, reachable: true, status: 200 });
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('HEAD');
  });

  it('reports an unreachable image for a 404', async () => {
    const fetchImpl = mockFetch(() => new Response(null, { status: 404 }));
    const status = await checkImageReachable('https://cdn.test/missing.png', fetchImpl);
    expect(status).toEqual({ checked: true, reachable: false, status: 404 });
  });

  it('falls back to GET when HEAD is not allowed', async () => {
    const fetchImpl = mockFetch(({ method }) =>
      method === 'HEAD'
        ? new Response(null, { status: 405 })
        : new Response('bytes', { status: 200 })
    );
    const status = await checkImageReachable('https://cdn.test/i.png', fetchImpl);
    expect(status).toEqual({ checked: true, reachable: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports unreachable with a null status on a network error', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('dns failure');
    });
    const status = await checkImageReachable('https://cdn.test/i.png', fetchImpl);
    expect(status).toEqual({ checked: true, reachable: false, status: null });
  });
});
