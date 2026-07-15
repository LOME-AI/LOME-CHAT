import { fromBase64 } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import type { Principal } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { LinkResolutionPort } from '../ports/index.js';

/**
 * The shared-link visitor as a first-class principal. The variant is declared
 * on the pipeline's `Principal` union (the HTTP matrix must deny it by type);
 * this alias is the shape downstream slices consume from the identity barrel,
 * so realtime and media authorization match on `kind` and read the typed
 * scope — never ad-hoc header or field checks.
 */
export type LinkGuestPrincipal = Extract<Principal, { kind: 'link-guest' }>;

/** Resolution result: the typed guest, or `none` when the credential grants nothing. */
export type LinkGuestResolution = LinkGuestPrincipal | Extract<Principal, { kind: 'none' }>;

const NONE: LinkGuestResolution = { kind: 'none' };

export interface ResolveLinkGuestArgs {
  readonly port: LinkResolutionPort;
  /** The client-presented link public key, base64 (URL-safe accepted). */
  readonly credential: string;
}

/**
 * Turns a client-presented link credential into a typed principal. A
 * malformed or unresolvable credential is expected external input and
 * degrades to `none` — never an error; only an unanswerable port (store
 * down) surfaces on the error channel, so authorization can fail closed
 * rather than mistake an outage for a dead link.
 */
export function resolveLinkGuestPrincipal(
  args: ResolveLinkGuestArgs
): ResultAsync<LinkGuestResolution, DomainError> {
  let linkPublicKey: Uint8Array;
  try {
    linkPublicKey = fromBase64(args.credential);
    // eslint-disable-next-line catch-swallow/no-silent-catch -- a malformed link credential resolves to NONE (grants nothing); fail closed.
  } catch {
    return okAsync(NONE);
  }
  return args.port.resolveLinkCredential(linkPublicKey).map((resolution) =>
    resolution === null
      ? NONE
      : {
          kind: 'link-guest' as const,
          linkId: resolution.linkId,
          conversationId: resolution.conversationId,
        }
  );
}
