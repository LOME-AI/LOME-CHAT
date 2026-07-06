import type { SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * Single-writer persistence seam for chat's tables (`messages`,
 * `content_items`). Raw Drizzle mutations live only in the adapter behind this
 * port; the settlement domain holds the crypto-wrap and content-pairing logic
 * and calls through it.
 *
 * Every method runs on the branded `SettlementTx` and THROWS on failure —
 * inside the single settlement transaction a throw aborts the whole commit,
 * which is exactly the fail-fast saved ⟺ billed wants (a persist failure
 * unwinds the charges with it).
 */

export interface ChatMessageInput {
  readonly id: string;
  readonly conversationId: string;
  /** The assistant is the only sender the chat turn persists. */
  readonly senderType: 'assistant';
  /** The AAD sender bound into every content envelope under this message. */
  readonly senderId: string;
  /** The turn's content key wrapped to the epoch public key (ciphertext at rest). */
  readonly wrappedContentKey: Uint8Array;
  readonly epochNumber: number;
  readonly sequenceNumber: number;
}

export interface ChatContentItemInput {
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  /** The content envelope: XChaCha20-Poly1305 under the turn's content key. */
  readonly encryptedBlob: Uint8Array;
  readonly modelId: string;
  readonly providerName: string;
  /** The charged (post-markup) cost, mirrored onto the content for display reads. */
  readonly costNanoUsd: bigint;
}

export interface ChatStores {
  /**
   * The next sequence number for the conversation: `MAX(sequence) + 1` over
   * chat-owned `messages`. Safe as a read-then-insert here because the
   * conversation DO hard-blocks a second concurrent run, and the
   * `messages_conversation_sequence_unique` constraint is the backstop.
   */
  nextSequenceWithinTx(tx: SettlementTx, conversationId: string): Promise<number>;
  insertMessageWithinTx(tx: SettlementTx, input: ChatMessageInput): Promise<void>;
  insertContentItemWithinTx(tx: SettlementTx, input: ChatContentItemInput): Promise<void>;
}

export type ChatStoresFactory = () => ChatStores;
