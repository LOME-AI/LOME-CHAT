/**
 * A refused run-start (or stop) POST carrying the wire `{ code, details }`
 * body. Pages map refusal codes to copy via `friendlyErrorMessage` /
 * `trialRefusalFor` instead of pattern-matching on `message` (message stays
 * equal to `code` for older consumers).
 */
export class ChatRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
    public readonly status?: number
  ) {
    super(code);
    this.name = 'ChatRequestError';
  }
}
