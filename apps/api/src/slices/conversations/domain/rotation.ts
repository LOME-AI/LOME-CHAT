import { fromBase64 } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { RotationBody } from './schemas.js';

/**
 * Wrap-set planning for an epoch rotation. The client supplies one wrap per
 * active member; the server — never the client — decides each row's
 * `visibleFromEpoch` from the authoritative membership rows, and the set
 * must match the active members exactly (a missing wrap would lock a member
 * out; an extra wrap would leak the new key to a non-member).
 */

export interface MemberWrapInput {
  /** base64 X25519 public key identifying the member. */
  readonly memberPublicKey: string;
  /** base64 ECIES wrap of the new epoch key for that member. */
  readonly wrap: string;
}

export interface PlannedWrap {
  readonly memberPublicKey: string;
  readonly wrap: string;
  readonly visibleFromEpoch: number;
}

export function planEpochWraps(
  visibilityByKey: ReadonlyMap<string, number>,
  memberWraps: readonly MemberWrapInput[]
): PlannedWrap[] | null {
  if (memberWraps.length !== visibilityByKey.size) return null;
  const seen = new Set<string>();
  const plan: PlannedWrap[] = [];
  for (const { memberPublicKey, wrap } of memberWraps) {
    const visibleFromEpoch = visibilityByKey.get(memberPublicKey);
    if (visibleFromEpoch === undefined || seen.has(memberPublicKey)) return null;
    seen.add(memberPublicKey);
    plan.push({ memberPublicKey, wrap, visibleFromEpoch });
  }
  return plan;
}

export interface ApplyRotationParams {
  readonly conversationId: string;
  readonly rotation: RotationBody;
  readonly plan: readonly PlannedWrap[];
}

/**
 * The atomic rotation: bump `currentEpoch` (first-write-wins claim, which the
 * caller's `FOR UPDATE` conversation lock has already serialized), insert the
 * chained epoch row, write the planned wraps, drop the previous epoch's
 * wraps. Runs inside the caller's transaction — a failure at any write rolls
 * the whole rotation back. Callers validated `expectedEpoch` against the
 * LOCKED row and planned the wrap set BEFORE any write, so a refusal can
 * never leave partial state; a lost claim here is therefore an invariant
 * break, not an expected answer.
 */
export function applyRotation(
  stores: ConversationsStores,
  params: ApplyRotationParams
): ResultAsync<{ readonly newEpochNumber: number }, DomainError> {
  const { conversationId, rotation, plan } = params;
  const newEpochNumber = rotation.expectedEpoch + 1;
  return stores.conversations
    .claimRotation({
      conversationId,
      expectedEpoch: rotation.expectedEpoch,
      encryptedTitle: fromBase64(rotation.encryptedTitle),
    })
    .andThen((claimed) => {
      if (!claimed) {
        throw new Error('conversations: rotation claim lost under the conversation lock');
      }
      return stores.epochs.byNumber(conversationId, rotation.expectedEpoch);
    })
    .andThen((previousEpoch) => {
      if (previousEpoch === null) {
        throw new Error('conversations: current epoch row missing for rotation');
      }
      return stores.epochs
        .insert({
          conversationId,
          epochNumber: newEpochNumber,
          previousEpochId: previousEpoch.id,
          epochPublicKey: fromBase64(rotation.epochPublicKey),
          confirmationHash: fromBase64(rotation.confirmationHash),
          chainLink: fromBase64(rotation.chainLink),
        })
        .andThen((newEpoch) =>
          stores.epochs.insertWraps(
            plan.map((wrap) => ({
              epochId: newEpoch.id,
              memberPublicKey: fromBase64(wrap.memberPublicKey),
              wrap: fromBase64(wrap.wrap),
              visibleFromEpoch: wrap.visibleFromEpoch,
            }))
          )
        )
        .andThen(() => stores.epochs.deleteWraps(previousEpoch.id))
        .map(() => ({ newEpochNumber }));
    });
}
