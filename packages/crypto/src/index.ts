/**
 * Crypto segregation: this package is the one home for all keyed cryptography —
 * every `@noble/*`, `@scure/*`, `@cloudflare/opaque` use and every keyed
 * `crypto.subtle` operation (AEAD, ECDH/wrap, HMAC/RSA signing) lives here and
 * nowhere else.
 *
 * Documented carve-out (keyless SHA-256): content-addressable / non-keyed
 * `sha256` hashing that binds no secret is NOT keyed crypto and may stay at its
 * call site rather than routing through this package. Five such sites exist by
 * design — rate-limit key derivation, canonical-JSON body hashing,
 * billing-portal and trial-quota identifiers, and roadmap normalization — each a
 * one-shot `crypto.subtle.digest('SHA-256', …)` over public/non-secret bytes.
 * Only keyed signing (e.g. FCM's RS256 OAuth JWT, `signRs256Jwt`) is relocated
 * into this package; keyless hashing is the explicit exception.
 */
export {
  CryptoError,
  InvalidKeyError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
  DecryptionFailedError,
  DecompressionCapError,
  DecompressionInvalidError,
  EpochNotInChainError,
  ChunkStreamError,
} from './errors.js';

export { BLOB_FORMAT_VERSION, NONCE_BYTES } from './format.js';

export {
  KEY_BYTES,
  asAccountPrivateKey,
  asAccountPublicKey,
  asWrappingPrivateKey,
  asWrappingPublicKey,
  asEpochPrivateKey,
  asEpochPublicKey,
  asContentKey,
  asShareSecret,
  generateAccountKeyPair,
  generateEpochKeyPair,
  generateContentKey,
} from './keys.js';
export type {
  AccountPrivateKey,
  AccountPublicKey,
  WrappingPrivateKey,
  WrappingPublicKey,
  EpochPrivateKey,
  EpochPublicKey,
  ContentKey,
  ShareSecret,
  PrivateKey,
  PublicKey,
  AccountKeyPair,
  EpochKeyPair,
} from './keys.js';

export { boundedInflate } from './bounded-inflate.js';

export { wrapSecretTo, unwrapSecret } from './wrap.js';
export type { WrappedSecret } from './wrap.js';

export {
  RECOVERY_DUMMY_WRAPPED_KEY_LABEL,
  asServerSecret,
  deriveDummyRecoveryWrappedKey,
} from './recovery-dummy.js';
export type { ServerSecret } from './recovery-dummy.js';

export { encryptContentEnvelope, decryptContentEnvelope } from './envelope.js';
export type { ContentLocation } from './envelope.js';

export {
  CONTENT_KEY_WRAP_LABEL,
  EPOCH_CONFIRMATION_BYTES,
  computeEpochConfirmation,
  verifyEpochConfirmation,
  wrapContentKeyToEpoch,
  unwrapContentKeyFromEpoch,
  decryptContentWithEpochChain,
} from './epoch.js';
export type { EpochChainEntry } from './epoch.js';

export {
  PER_FLOW_MEDIA_CAP_BYTES,
  encryptMediaChunk,
  decryptMediaChunk,
  encryptMediaStream,
  decryptMediaStream,
} from './chunked.js';
export type { ChunkLocation } from './chunked.js';

// Superseded blob-scheme surface (ECIES, version byte 0x01), still live for
// the current web client. Exports whose names the modules above claimed are
// re-exported under Legacy-prefixed aliases.
export {
  CryptoError as LegacyCryptoError,
  DecryptionError,
  InvalidBlobError,
  KeyDerivationError,
} from './crypto-errors.js';

export {
  createAccount,
  unwrapAccountKeyWithPassword,
  recoverAccountFromMnemonic,
  rewrapAccountKeyForPasswordChange,
  regenerateRecoveryPhrase,
} from './account.js';
export type { CreateAccountResult, RegenerateRecoveryResult } from './account.js';

export {
  createFirstEpoch,
  performEpochRotation,
  unwrapEpochKey,
  traverseChainLink,
  verifyEpochKeyConfirmation,
} from './epoch-lifecycle.js';
export type { EpochMemberWrap, CreateEpochResult, EpochRotationResult } from './epoch-lifecycle.js';

export {
  generateContentKey as legacyGenerateContentKey,
  wrapContentKeyForEpoch,
  unwrapContentKeyForEpoch,
  wrapContentKeyForShare,
  unwrapContentKeyForShare,
  CONTENT_KEY_LENGTH,
  SHARE_WRAP_INFO,
} from './content-key.js';
export type { ContentKey as LegacyContentKey, WrappedContentKey } from './content-key.js';

export {
  beginMessageEnvelope,
  openMessageEnvelope,
  encryptTextWithContentKey,
  decryptTextWithContentKey,
  encryptBinaryWithContentKey,
  decryptBinaryWithContentKey,
  encryptTextForEpoch,
  decryptTextFromEpoch,
} from './message-encrypt.js';
export type { MessageEnvelope } from './message-encrypt.js';

export { wrapEpochKeyForNewMember } from './member.js';

export { createSharedLink, deriveKeysFromLinkSecret } from './link.js';
export type { CreateSharedLinkResult } from './link.js';

export { createShare, openShare } from './message-share.js';
export type { CreateShareResult } from './message-share.js';

export {
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpCode,
  generateTotpCodeSync,
  verifyTotpToken,
  decryptAndVerifyTotp,
} from './totp.js';
export type { DecryptAndVerifyTotpResult, VerifyTotpTokenResult } from './totp.js';

export { generateKeyPair, getPublicKeyFromPrivate } from './sharing.js';
export type { KeyPair } from './sharing.js';

export { generateRecoveryPhrase, validatePhrase, phraseToSeed } from './recovery-phrase.js';

export {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
} from './opaque-client.js';
export type {
  RegistrationRequest,
  RegistrationResult,
  LoginRequest,
  LoginResult,
} from './opaque-client.js';

export {
  OpaqueServerConfig,
  deriveServerCredentials,
  createOpaqueServer,
  createOpaqueServerFromEnv,
  createFakeRegistrationRecord,
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueRegistrationRecord,
  OpaqueServerRegistrationRequest,
  OpaqueKE1,
  OpaqueKE3,
  OpaqueExpectedAuthResult,
} from './opaque-server.js';

export { opaqueStepUpInit, opaqueStepUpFinish } from './opaque-step-up.js';
export type { FinishOutcome as OpaqueStepUpFinishOutcome } from './opaque-step-up.js';

export { verifyHmacSha256Webhook, signHmacSha256Webhook } from './webhook.js';
export type { HmacWebhookSignParams, HmacWebhookVerifyParams } from './webhook.js';

export { signRs256Jwt } from './rs256-jwt.js';
export type { Rs256JwtSignParams } from './rs256-jwt.js';
