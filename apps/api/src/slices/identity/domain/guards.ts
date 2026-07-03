import { fromBase64 } from '@hushbox/shared';
import { Result } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { IdentityUserRecord } from '../ports/index.js';

/** An authenticated principal whose user row vanished is a defect, never a Result. */
export function requireUser(user: IdentityUserRecord | null): IdentityUserRecord {
  if (user === null) {
    throw new Error('identity: authenticated principal resolved to no user row');
  }
  return user;
}

/** Decodes a client-supplied base64 field; malformed input is a validation Result. */
export function decodeBase64Field(value: string, field: string): Result<Uint8Array, DomainError> {
  return Result.fromThrowable(
    () => fromBase64(value),
    (cause) => validationError(`malformed base64 ${field}`, cause)
  )();
}
