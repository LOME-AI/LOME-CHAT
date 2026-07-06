import { describe, expect, it } from 'vitest';
import { resolveTrialSessionPrincipal } from './trial-session.js';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('resolveTrialSessionPrincipal', () => {
  it('adopts a well-formed uuid credential as the session id', () => {
    const principal = resolveTrialSessionPrincipal({
      credential: VALID_UUID,
      newId: () => 'minted',
    });
    expect(principal).toEqual({ kind: 'trial-session', sessionId: VALID_UUID });
  });

  it('mints a fresh session id when no credential is presented', () => {
    const principal = resolveTrialSessionPrincipal({
      credential: null,
      newId: () => VALID_UUID,
    });
    expect(principal).toEqual({ kind: 'trial-session', sessionId: VALID_UUID });
  });

  it('mints a fresh session id when the credential is not a uuid', () => {
    // The session id scopes the run's idempotency-key claim (a uuid column), so
    // an arbitrary client string is never trusted as the identity — a fresh
    // uuid is minted and returned for the client to store.
    const principal = resolveTrialSessionPrincipal({
      credential: 'not-a-uuid',
      newId: () => VALID_UUID,
    });
    expect(principal).toEqual({ kind: 'trial-session', sessionId: VALID_UUID });
  });
});
