import {
  asEpochPublicKey,
  encryptContentEnvelope,
  generateContentKey,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import { createChargingCommit } from '../../workflows/index.js';
import { applyMarkup } from '../../billing/index.js';
import { assertWrapEpochWithinTx, createConversationsStores } from '../../conversations/index.js';
import type { SettlementCommit } from '../../workflows/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { DbWriter, SettlementTx } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ChatStores } from '../ports/stores.js';

/**
 * The AAD sender bound into the assistant message's content envelopes. A
 * reserved non-user sentinel (the nil UUID), NOT the initiator's userId:
 * `messages.senderId` is scrubbed to null when a user's account is deleted, so
 * binding the initiator would make the assistant's answers undecryptable for
 * co-members after the initiator leaves. The sentinel matches no user, so
 * deletion never touches it; `senderType='assistant'` disambiguates it, and the
 * anti-splice guarantee is unaffected (the per-item AAD still binds messageId,
 * contentItemId, and position).
 */
export const ASSISTANT_SENDER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The captured send-time epoch was superseded (rotation) or the initiator is no
 * longer a member of it. Thrown from the settlement commit to terminal-fail the
 * run and roll back — nothing persists, so nothing wraps to a stale epoch.
 */
export class EpochWrapConflict extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat settlement: wrap-epoch assertion failed');
    this.name = 'EpochWrapConflict';
  }
}

/**
 * The chat turn's settlement commit: persist the assistant message and its
 * content items, then charge each billable generation — all in the ONE fenced
 * settlement transaction the interpreter enters through the settlement hook.
 * Nothing commits mid-run, so a throw here (a failed persist or charge) unwinds
 * the whole transaction: saved ⟺ billed ⟺ key-row flipped, atomically.
 *
 * Content pairing is keyed by the CHARGE key. Each charge names the generation
 * that produced it (the node id); the interpreter surfaces that generation's
 * content under the same key in `outputs`, so a charge maps to the content item
 * minted for exactly its generation. A charge with no matching persisted
 * content is skipped by the charging commit — no content, no charge.
 */

const textEncoder = new TextEncoder();

/**
 * Reads the epoch public key the assistant output wraps to. Injected by the
 * conversations slice (the single writer of `epochs`); returns null when the
 * conversation's epoch row is absent, which aborts the settlement.
 */
export type EpochPublicKeyReader = (
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
) => Promise<Uint8Array | null>;

/** The run identity the settlement commit closes over (RunContext, sans fence). */
export interface ChatSettlementIdentity {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly walletId: string;
  readonly userId: string;
  readonly runId: string;
}

export interface ChatSettlementDeps {
  readonly identity: ChatSettlementIdentity;
  readonly stores: ChatStores;
  readonly billingStores: BillingStores;
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly now: () => Date;
  readonly newId: () => string;
}

interface PersistableCharge {
  readonly charge: SettlementCharge;
  readonly text: string;
}

/** A billable text generation whose content the run surfaced as an output. */
function collectTextCharges(request: SettlementRequest): PersistableCharge[] {
  const persistable: PersistableCharge[] = [];
  for (const charge of request.charges) {
    const output: (typeof request.outputs)[string] | undefined = request.outputs[charge.key];
    if (output?.kind === 'text') {
      persistable.push({ charge, text: output.text });
    }
  }
  return persistable;
}

async function persistTurnContent(
  tx: SettlementTx,
  request: SettlementRequest,
  deps: ChatSettlementDeps
): Promise<Map<string, string>> {
  const contentItemIdByKey = new Map<string, string>();
  const persistable = collectTextCharges(request);
  // Nothing produced → nothing persisted → nothing billed (the interpreter's
  // stopped-with-empty path settles here with no charges).
  if (persistable.length === 0) return contentItemIdByKey;

  const { identity } = deps;
  // Epoch-at-persist gate (forward secrecy): FOR SHARE re-read + assert the
  // send-time epoch is still current and the initiator still belongs to it,
  // INSIDE this transaction, BEFORE wrapping. A mismatch throws → the whole
  // settlement rolls back, so content never wraps to a superseded epoch.
  const epochCheck = await assertWrapEpochWithinTx(createConversationsStores(tx), {
    conversationId: identity.conversationId,
    epochNumber: identity.epochNumber,
    userId: identity.userId,
  });
  if (epochCheck.isErr()) throw new EpochWrapConflict(epochCheck.error);

  const rawKey = await deps.readEpochPublicKey(tx, identity.conversationId, identity.epochNumber);
  if (rawKey === null) {
    throw new Error(
      `chat settlement: conversation ${identity.conversationId} has no epoch ${String(identity.epochNumber)} to wrap to`
    );
  }
  const epochPublicKey = asEpochPublicKey(rawKey);
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
  const messageId = deps.newId();
  const sequenceNumber = await deps.stores.nextSequenceWithinTx(tx, identity.conversationId);
  await deps.stores.insertMessageWithinTx(tx, {
    id: messageId,
    conversationId: identity.conversationId,
    senderType: 'assistant',
    senderId: ASSISTANT_SENDER_ID,
    wrappedContentKey,
    epochNumber: identity.epochNumber,
    sequenceNumber,
  });

  let position = 0;
  for (const { charge, text } of persistable) {
    const contentItemId = deps.newId();
    const encryptedBlob = encryptContentEnvelope(
      contentKey,
      wrappedContentKey,
      {
        conversationId: identity.conversationId,
        messageId,
        contentItemId,
        position,
        epochNumber: identity.epochNumber,
        senderId: ASSISTANT_SENDER_ID,
      },
      textEncoder.encode(text)
    );
    await deps.stores.insertContentItemWithinTx(tx, {
      id: contentItemId,
      messageId,
      position,
      encryptedBlob,
      modelId: charge.modelId,
      providerName: charge.providerName,
      // The charged (post-markup) cost, mirrored for display reads. The markup
      // is a pure function of the base cost; the authoritative charge lands
      // once in `chargeWithinTx` below on the same base.
      costNanoUsd: applyMarkup(charge.baseCostNanoUsd),
    });
    contentItemIdByKey.set(charge.key, contentItemId);
    position += 1;
  }
  return contentItemIdByKey;
}

export function createChatSettlementCommit(deps: ChatSettlementDeps): SettlementCommit {
  return async (tx, request) => {
    const contentItemIdByKey = await persistTurnContent(tx, request, deps);
    const charging = createChargingCommit({
      stores: deps.billingStores,
      context: {
        walletId: deps.identity.walletId,
        userId: deps.identity.userId,
        runId: deps.identity.runId,
        now: deps.now(),
        contentItemIdFor: (key) => contentItemIdByKey.get(key),
      },
    });
    await charging(tx, request);
  };
}
