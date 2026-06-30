import type { DomainError, DomainErrorCode } from '../errors/index.js';

/**
 * The one sanctioned bridge from the DomainError taxonomy into log fields:
 * expected failures are logged as their closed-set code and nothing else —
 * the operator-safe `message` stays out of telemetry by construction
 * (doctrine: errors carry codes, not content).
 */
export function domainErrorFields(error: DomainError): { readonly errorCode: DomainErrorCode } {
  return { errorCode: error.code };
}
