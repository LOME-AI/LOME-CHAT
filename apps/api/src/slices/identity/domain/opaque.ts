import {
  OpaqueExpectedAuthResult,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueRegistrationRecord,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  createOpaqueServerFromEnv,
} from '@hushbox/crypto';
import { Result, fromPromise } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Bindings } from '../../../lib/context/index.js';

/**
 * Upper bound on the length of the OPAQUE KE byte arrays (`ke1`/`ke3`) a
 * client may post. The serialized OPAQUE messages are fixed, small sizes, so
 * this caps parse cost against an oversized array without touching any
 * legitimate handshake.
 */
export const MAX_KE_ARRAY_LENGTH = 1024;

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
 * The `@cloudflare/opaque-ts` server APIs report protocol failures as Error
 * VALUES, not rejections. Unwrapping through this guard converts them into
 * throws so the surrounding `fromPromise` maps them into the typed
 * validation channel — without it, an Error value would flow onward as a
 * success and be serialized into pending state.
 */
export function throwIfOpaqueError<T>(result: T | Error): T {
  if (result instanceof Error) throw result;
  return result;
}

/**
 * Rejection mapper for the OPAQUE server calls: protocol rejections are
 * client input (any client can post junk), so they land in the typed
 * `validation` channel, never as 500 defects.
 */
export function opaqueProtocolError(what: string): (cause: unknown) => DomainError {
  return (cause: unknown): DomainError => validationError(what, cause);
}

/**
 * Serialized registerInit response for a new password bound to the given
 * credential identifier — the round-one half shared by the password-change
 * and recovery-reset flows (registration mints its own id and rides its own
 * pending state, so it keeps a separate composition).
 */
export function runNewPasswordRegisterInit(
  masterSecret: string,
  credentialIdentifier: string,
  request: OpaqueServerRegistrationRequest
): ResultAsync<number[], DomainError> {
  return fromPromise(
    (async (): Promise<number[]> => {
      const server = await createOpaqueServerFromEnv(masterSecret);
      const response = throwIfOpaqueError(await server.registerInit(request, credentialIdentifier));
      return response.serialize();
    })(),
    opaqueProtocolError('OPAQUE registerInit rejected the new registration request')
  );
}

/**
 * The claim/execute/duplicate triple an `opaque-protocol` route composes
 * into `idempotent.byEventId`: the handshake id is the event id, and the
 * single-use consume of the pending Redis state — an atomic GETDEL, so
 * exactly one concurrent delivery wins it — is the first-delivery claim.
 */
export interface OpaqueFinishFlow<TOutcome> {
  readonly claim: () => ResultAsync<boolean, DomainError>;
  readonly execute: () => ResultAsync<TOutcome, DomainError>;
  readonly onDuplicate: () => ResultAsync<TOutcome, DomainError>;
}

/**
 * The `opaque-protocol` init rounds mint the event id (the handshake id)
 * server-side inside the mutation — a fresh uuid per request — so the first
 * delivery wins the `byEventId` claim by construction and a duplicate
 * delivery cannot occur; reaching this is a defect, never a client outcome.
 */
export function duplicateFreshHandshakeDefect(): never {
  throw new Error('identity: duplicate byEventId claim on a server-minted handshake id');
}

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
