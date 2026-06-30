import { createCachedMembershipVerifier } from '@hushbox/realtime';
import {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  MEMBERSHIP_FRESHNESS_MS,
  MEMBERSHIP_LAST_KNOWN_GOOD_MS,
} from './membership.js';
import type { MembershipCache, MembershipSource, MembershipVerifier } from '@hushbox/realtime';

/**
 * Separate from membership.ts deliberately: this module VALUE-imports the
 * `@hushbox/realtime` barrel, which transitively imports `cloudflare:workers`
 * and therefore only loads under workerd (node tests stub that platform
 * module). Keeping the import here lets the cache/source/revoker adapters
 * stay loadable everywhere. A node-loadable `./revocation` subpath export on
 * the package would dissolve this split.
 */
export interface MembershipVerifierOptions {
  readonly cache: MembershipCache;
  readonly source: MembershipSource;
  /** Injectable clock for window tests; production uses the wall clock. */
  readonly now?: () => number;
}

export function composeMembershipVerifier(options: MembershipVerifierOptions): MembershipVerifier {
  return createCachedMembershipVerifier({
    cache: options.cache,
    source: options.source,
    freshnessMs: MEMBERSHIP_FRESHNESS_MS,
    lastKnownGoodMs: MEMBERSHIP_LAST_KNOWN_GOOD_MS,
    cacheTtlSeconds: MEMBERSHIP_CACHE_TTL_SECONDS,
    now: options.now ?? ((): number => Date.now()),
  });
}
