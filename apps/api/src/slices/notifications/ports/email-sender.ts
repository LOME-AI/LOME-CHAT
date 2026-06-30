import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly from?: string;
}

/**
 * The EmailSender port (ARCHITECTURE.md infra edge). Best-effort by doctrine:
 * callers log a failed Result with its error code and never let it crash the
 * request. Implementations must keep recipient addresses and message content
 * out of error messages — errors carry codes and operator-safe text only.
 */
export interface EmailSender {
  send(message: EmailMessage): ResultAsync<void, DomainError>;
}
