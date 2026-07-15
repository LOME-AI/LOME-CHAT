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

/**
 * Members and links CANNOT be pinned today: the conversations slice's
 * `respond200` helper is annotated `: Response`, so the whole slice is
 * schema-blind in `AppType` (its 200 branch infers as bare `{}`), and no
 * shared Zod response schema exists for either endpoint. The canaries below
 * assert that blindness: the moment the slice's response typing is fixed,
 * they stop compiling — restore real `satisfies` pins for both shapes then.
 */
type Members200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['members']['$get'],
  200
>;
type Links200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['links']['$get'],
  200
>;
type MembersStillBlind =
  Extract<Members200, { members: unknown }> extends never ? true : 'members is typed — pin it';
type LinksStillBlind =
  Extract<Links200, { links: unknown }> extends never ? true : 'links is typed — pin it';

type DemoBalance = ReturnType<DemoBackendStore['getBalance']>;

// Phantom demo value typed exactly as the store returns. The `satisfies`
// clause fails to compile if the demo shape stops being assignable to the real
// wire response, turning shape drift into a typecheck error.
const balance = null as unknown as DemoBalance;
const membersCanary: MembersStillBlind = true;
const linksCanary: LinksStillBlind = true;

describe('demo backend response contracts', () => {
  it('balance matches the real $get response shape', () => {
    expect(balance satisfies RealBalance).toBe(balance);
  });

  it('members/links canaries flag when the conversations slice becomes pinnable', () => {
    expect(membersCanary).toBe(true);
    expect(linksCanary).toBe(true);
  });
});
