import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** The scope a live shared-link credential grants: the link and its one conversation. */
export interface LinkCredentialResolution {
  readonly linkId: string;
  readonly conversationId: string;
}

/**
 * The narrow, identity-owned link-resolution port (the VerificationEmailPort
 * pattern): identity turns a link credential into a typed principal without
 * importing anything from the conversations slice. The composition root binds
 * it to an adapter over the conversations barrel's shared-link surface, which
 * must answer null for revoked or expired links (lazy enforcement at read).
 */
export interface LinkResolutionPort {
  /** Resolves a link public key to its live link, or null (unknown/revoked/expired). */
  resolveLinkCredential(
    linkPublicKey: Uint8Array
  ): ResultAsync<LinkCredentialResolution | null, DomainError>;
}
