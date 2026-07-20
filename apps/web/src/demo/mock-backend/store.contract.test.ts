import { describe, it, expect } from 'vitest';
import { hc } from 'hono/client';
import type { InferResponseType } from 'hono/client';
import type { AppType } from '@hushbox/api';
import type { DemoBackendStore } from './store';

/**
 * Contract pinning the demo backend's hand-rolled wire shapes to the REAL API
 * response types inferred from the Hono route definitions (`AppType`). The
 * demo store hand-rolls these shapes so the unmodified app read path runs
 * against it; if a production route's response shape drifts (a renamed/added
 * field), the `satisfies` checks below stop compiling — so the drift fails at
 * `typecheck` rather than as a silent runtime mismatch only reproducible in the
 * browser. (The standard typecheck gate enforces this; vitest is not configured
 * for `typecheck`, so `expectTypeOf` alone would not catch drift.)
 *
 * `hc<AppType>()` is constructed only as a `typeof` anchor for
 * `InferResponseType`; no request is made, so the dummy base URL is never
 * dereferenced.
 *
 * A pin must be scoped to the 200 branch AND `Extract`ed on a required key of
 * the success shape: handlers whose error branch returns a bare `Response`
 * (every slice's `respondDomainError`) contribute `{}` to the inferred
 * response union at every status, and `{}` admits any object — an unfiltered
 * `InferResponseType` pin is vacuously satisfied. If the real success shape
 * drops or renames the sentinel key, the `Extract` collapses to `never` and
 * the `satisfies` fails loudly.
 */
const _typeClient = hc<AppType>('http://demo.invalid');

type RealBalance = Extract<
  InferResponseType<typeof _typeClient.billing.balance.$get, 200>,
  { purchased: unknown }
>;

// The conversations slice's `respond200` tail now preserves its `TypedResponse`,
// so the members/links 200 shapes flow into `AppType` and are pinnable. Each
// pin is `Extract`ed on a required sentinel key so the bare-`Response` error
// arm's `{}` contribution cannot vacuously satisfy it.
type Members200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['members']['$get'],
  200
>;
type Links200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['links']['$get'],
  200
>;
type RealMembers = Extract<Members200, { members: unknown }>;
type RealLinks = Extract<Links200, { links: unknown }>;

type DemoBalance = ReturnType<DemoBackendStore['getBalance']>;
type DemoMembers = ReturnType<DemoBackendStore['getMembers']>;
type DemoLinks = ReturnType<DemoBackendStore['getLinks']>;

// Phantom demo values typed exactly as the store returns. Each `satisfies`
// clause fails to compile if the demo shape stops being assignable to the real
// wire response, turning shape drift into a typecheck error.
const balance = null as unknown as DemoBalance;
const members = null as unknown as DemoMembers;
const links = null as unknown as DemoLinks;

describe('demo backend response contracts', () => {
  it('balance matches the real $get response shape', () => {
    expect(balance satisfies RealBalance).toBe(balance);
  });

  it('members matches the real $get response shape', () => {
    expect(members satisfies RealMembers).toBe(members);
  });

  it('links matches the real $get response shape', () => {
    expect(links satisfies RealLinks).toBe(links);
  });
});
