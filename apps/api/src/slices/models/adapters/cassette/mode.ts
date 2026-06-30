import type { EnvUtilities } from '@hushbox/shared';

/**
 * CI's hot path is 100% cassette hits — zero charged real calls; a miss is a
 * failure, not a recording (recording happens out-of-band). Outside CI the
 * harness records on miss so recordings can be produced locally.
 */
export type CassetteMode = 'record' | 'replay-only';

export function cassetteModeFor(env: EnvUtilities): CassetteMode {
  return env.isCI ? 'replay-only' : 'record';
}
