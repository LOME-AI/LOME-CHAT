import { describe, it, expect, vi } from 'vitest';
import {
  resolveTargetHost,
  isLocalHost,
  networkGuardEnabled,
  createNetworkGuard,
} from './vitest-setup.js';

describe('resolveTargetHost', () => {
  it('reads the host from an absolute string URL', () => {
    expect(resolveTargetHost('https://example.com/path?q=1')).toBe('example.com');
  });

  it('reads the host from a URL object', () => {
    expect(resolveTargetHost(new URL('https://api.linear.app/graphql'))).toBe('api.linear.app');
  });

  it('reads the host from a Request object', () => {
    expect(resolveTargetHost(new Request('https://openrouter.ai/api/v1/chat'))).toBe(
      'openrouter.ai'
    );
  });

  it('resolves a relative URL against localhost so it counts as local', () => {
    expect(resolveTargetHost('/api/models')).toBe('localhost');
  });

  it('returns an empty host for data: URLs (no network)', () => {
    expect(resolveTargetHost('data:text/plain,hello')).toBe('');
  });

  it('returns undefined for an unparseable URL', () => {
    expect(resolveTargetHost('http://')).toBeUndefined();
  });
});

describe('isLocalHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'sub.localhost'])(
    'allows the loopback host %s',
    (host) => {
      expect(isLocalHost(host)).toBe(true);
    }
  );

  it('allows an empty host (relative/data/blob URLs)', () => {
    expect(isLocalHost('')).toBe(true);
  });

  it.each(['example.com', 'openrouter.ai', 'api.linear.app', '8.8.8.8'])(
    'blocks the external host %s',
    (host) => {
      expect(isLocalHost(host)).toBe(false);
    }
  );
});

describe('networkGuardEnabled', () => {
  it('is enabled by default (local vitest, no CI signal)', () => {
    expect(networkGuardEnabled({})).toBe(true);
    expect(networkGuardEnabled({ VITEST: 'true' })).toBe(true);
  });

  it('is inert in CI so the real-API/evidence tests reach their external hosts', () => {
    expect(networkGuardEnabled({ CI: 'true' })).toBe(false);
    expect(networkGuardEnabled({ CI: '1' })).toBe(false);
  });

  it('stays enabled when CI is present but empty (matches Boolean(env.CI) semantics)', () => {
    expect(networkGuardEnabled({ CI: '' })).toBe(true);
  });
});

describe('createNetworkGuard', () => {
  it('delegates a localhost fetch to the real fetch', async () => {
    const sentinel = new Response('ok');
    const realFetch = vi.fn(() => Promise.resolve(sentinel));
    const guarded = createNetworkGuard(realFetch as unknown as typeof globalThis.fetch);

    const result = await guarded('http://localhost:4444/sql');

    expect(realFetch).toHaveBeenCalledOnce();
    expect(result).toBe(sentinel);
  });

  it('delegates a relative URL to the real fetch', async () => {
    const realFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    const guarded = createNetworkGuard(realFetch as unknown as typeof globalThis.fetch);

    await guarded('/api/health');

    expect(realFetch).toHaveBeenCalledOnce();
  });

  it('delegates when the host cannot be resolved (unparseable input)', () => {
    const realFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    const guarded = createNetworkGuard(realFetch as unknown as typeof globalThis.fetch);

    void guarded('http://');

    expect(realFetch).toHaveBeenCalledOnce();
  });

  it('throws for an external string URL and never calls the real fetch', () => {
    const realFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    const guarded = createNetworkGuard(realFetch as unknown as typeof globalThis.fetch);

    expect(() => guarded('https://example.com/data')).toThrow(/network access blocked/i);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('throws for an external Request object', () => {
    const realFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    const guarded = createNetworkGuard(realFetch as unknown as typeof globalThis.fetch);

    expect(() => guarded(new Request('https://openrouter.ai/api/v1/chat'))).toThrow(
      /openrouter\.ai/
    );
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('names the blocked host and points at the mock/cassette guidance', () => {
    const guarded = createNetworkGuard(vi.fn() as unknown as typeof globalThis.fetch);

    expect(() => guarded('https://8.8.8.8/')).toThrow(/8\.8\.8\.8/);
    expect(() => guarded('https://8.8.8.8/')).toThrow(/cassette|mock/i);
  });
});
