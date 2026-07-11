import { describe, it, expect } from 'vitest';
import { hc } from 'hono/client';
import type { InferResponseType } from 'hono/client';
import type { AppType } from '@hushbox/api';
import type { DemoBackendStore } from './store';

/**
 * Contract pinning the demo backend's member/balance/links shapes to the REAL
 * API response types inferred from the Hono route definitions (`AppType`). The
 * demo store hand-rolls these wire shapes so the unmodified app read path runs
 * against it; if a production route's response shape drifts (a renamed/added
 * field), the `satisfies` checks below stop compiling — so the drift fails at
 * `typecheck` rather than as a silent runtime mismatch only reproducible in the
 * browser. (The standard typecheck gate enforces this; vitest is not configured
 * for `typecheck`, so `expectTypeOf` alone would not catch drift.)
 *
 * `hc<AppType>()` is constructed only as a `typeof` anchor for
 * `InferResponseType`; no request is made, so the dummy base URL is never
 * dereferenced.
 */
const _typeClient = hc<AppType>('http://demo.invalid');

type RealMembers = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['members']['$get']
>;
type RealBalance = InferResponseType<typeof _typeClient.billing.balance.$get>;
type RealLinks = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['links']['$get']
>;

type DemoMembers = ReturnType<DemoBackendStore['getMembers']>;
type DemoBalance = ReturnType<DemoBackendStore['getBalance']>;
type DemoLinks = ReturnType<DemoBackendStore['getLinks']>;

// Phantom demo values typed exactly as the store returns. The `satisfies`
// clauses fail to compile if any demo shape stops being assignable to the real
// wire response, turning shape drift into a typecheck error.
const members = null as unknown as DemoMembers;
const balance = null as unknown as DemoBalance;
const links = null as unknown as DemoLinks;

describe('demo backend response contracts', () => {
  it('member roster, balance and links match the real $get response shapes', () => {
    expect(members satisfies RealMembers).toBe(members);
    expect(balance satisfies RealBalance).toBe(balance);
    expect(links satisfies RealLinks).toBe(links);
  });
});
