import {
  OpaqueExpectedAuthResult,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueRegistrationRecord,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
} from '@hushbox/crypto';
import { Result } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Bindings } from '../../../lib/context/index.js';

/**
 * The OPAQUE wire deserializers throw on malformed bytes; malformed bytes
 * are expected external input (any client can post junk), so each codec is
 * wrapped into the typed `validation` channel here — a deserialize throw
 * must never surface as a 500 defect.
 */
function codec<T>(
  deserialize: (bytes: number[]) => T,
  what: string
): (bytes: number[]) => Result<T, DomainError> {
  return (bytes: number[]): Result<T, DomainError> =>
    Result.fromThrowable(
      () => deserialize(bytes),
      (cause) => validationError(`malformed OPAQUE ${what}`, cause)
    )();
}

export const deserializeRegistrationRequest = codec(
  (bytes) => OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, bytes),
  'registration request'
);

export const deserializeRegistrationRecord = codec(
  (bytes) => OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, bytes),
  'registration record'
);

export const deserializeKe1 = codec(
  (bytes) => OpaqueKE1.deserialize(OpaqueServerConfig, bytes),
  'KE1'
);

export const deserializeKe3 = codec(
  (bytes) => OpaqueKE3.deserialize(OpaqueServerConfig, bytes),
  'KE3'
);

export const deserializeExpectedAuthResult = codec(
  (bytes) => OpaqueExpectedAuthResult.deserialize(OpaqueServerConfig, bytes),
  'expected auth result'
);

/**
 * Slice-owned fail-fast for the one binding the pipeline's required-bindings
 * gate deliberately does not cover (surfaces that never touch OPAQUE — and
 * their test environments — don't carry it). Missing here is a deployment
 * misconfiguration: a thrown defect, never a degraded auth path.
 */
export function requireOpaqueMasterSecret(env: Pick<Bindings, 'OPAQUE_MASTER_SECRET'>): string {
  const secret = env.OPAQUE_MASTER_SECRET;
  if (secret === undefined || secret === '') {
    throw new Error(
      'identity: missing required binding OPAQUE_MASTER_SECRET. ' +
        'Set it in wrangler config / .dev.vars — auth fails fast instead of degrading.'
    );
  }
  return secret;
}
