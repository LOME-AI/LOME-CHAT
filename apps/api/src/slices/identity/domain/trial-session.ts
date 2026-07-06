import { z } from 'zod';
import type { Principal } from '../../../lib/context/index.js';

/**
 * The trial visitor as a first-class principal. Like the link guest, the
 * variant is declared on the pipeline's `Principal` union (the HTTP matrix
 * denies it by type); this alias is the shape downstream seams consume from
 * the identity barrel, so the realtime authz matches on `kind` and reads the
 * typed scope — the one trial room the session id names.
 */
export type TrialSessionPrincipal = Extract<Principal, { kind: 'trial-session' }>;

const uuidSchema = z.uuid();

export interface ResolveTrialSessionArgs {
  /** The client-presented `x-trial-token` (localStorage), or null when absent. */
  readonly credential: string | null;
  /** Mints a fresh session id (uuid) when the credential is absent or malformed. */
  readonly newId: () => string;
}

/**
 * Turns the client-presented trial credential into a typed principal. Trial
 * sessions are never persisted, so there is no store to consult — the session
 * id is simply the client's token when it is a well-formed uuid, or a freshly
 * minted uuid otherwise. The id scopes the trial run's idempotency-key claim
 * (a uuid column), so an arbitrary client string is never adopted verbatim; a
 * mint returns a new id for the client to store. Anti-evasion is the route's
 * IP-keyed quota, not this identity.
 */
export function resolveTrialSessionPrincipal(args: ResolveTrialSessionArgs): TrialSessionPrincipal {
  const sessionId =
    args.credential !== null && uuidSchema.safeParse(args.credential).success
      ? args.credential
      : args.newId();
  return { kind: 'trial-session', sessionId };
}
