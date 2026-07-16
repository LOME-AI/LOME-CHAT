import type { DbTransaction, SettlementTx } from '../../../lib/idempotency/index.js';

/**
 * Single-writer persistence seam for chat's tables (`messages`,
 * `content_items`). Raw Drizzle mutations live only in the adapter behind this
 * port; the settlement domain holds the crypto-wrap and content-pairing logic
 * and calls through it.
 *
 * Every method THROWS on failure — inside the caller's transaction a throw
 * aborts the whole commit, which is exactly the fail-fast saved ⟺ billed
 * wants (a persist failure unwinds the charges with it). The content inserts
 * and the tip read run on any `DbTransaction` (the branded `SettlementTx` is
 * assignable) because the runless Pattern-A user-only send shares them; the
 * regenerate DELETE methods stay `SettlementTx`-only — deletion of settled
 * content is a settlement-exclusive capability.
 */

export interface ChatMessageInput {
  readonly id: string;
  readonly conversationId: string;
  /** The turn persists the initiator's message and the assistant's reply. */
  readonly senderType: 'user' | 'assistant';
  /** The AAD sender bound into every content envelope under this message. */
  readonly senderId: string;
  /** The message's content key wrapped to the epoch public key (ciphertext at rest). */
  readonly wrappedContentKey: Uint8Array;
  readonly epochNumber: number;
  readonly sequenceNumber: number;
  /** Linear tree link: the message this one replies to (null at the root). */
  readonly parentMessageId: string | null;
  /** Per-turn id shared by every message persisted in one settlement. */
  readonly batchId: string;
}

export interface ChatContentItemInput {
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  /** The content envelope: XChaCha20-Poly1305 under the message's content key. */
  readonly encryptedBlob: Uint8Array;
  /** Null for a user message (no generating model); set for assistant content. */
  readonly modelId: string | null;
  readonly providerName: string | null;
  /** The charged (post-markup) cost, mirrored onto assistant content; null for user content. */
  readonly costNanoUsd: bigint | null;
  /**
   * True when a Smart Model classifier charge anchored to this display item — the
   * signal the client reads to render the "Smart" chip. A DISPLAY flag only; the
   * debit path (`usage_records`) is unaffected. Optional: callers with no notion
   * of Smart Model (e.g. dev seed factories) omit it and the column defaults false.
   */
  readonly isSmartModel?: boolean;
}

export interface ChatStores {
  /**
   * The conversation's current tip: the id of its highest-sequence message, or
   * null when the conversation has no messages. The linear tree chains the
   * turn's user message onto this tip.
   */
  latestMessageIdWithinTx(tx: DbTransaction, conversationId: string): Promise<string | null>;
  insertMessageWithinTx(tx: DbTransaction, input: ChatMessageInput): Promise<void>;
  insertContentItemWithinTx(tx: DbTransaction, input: ChatContentItemInput): Promise<void>;
  /**
   * The regenerate anchor's sequence + parent — the delete boundary (linear) and
   * the re-parent target (edit re-parents onto the anchor's parent). Null when
   * the anchor is absent, which terminal-fails the regenerate settlement.
   */
  messageRefWithinTx(
    tx: SettlementTx,
    conversationId: string,
    messageId: string
  ): Promise<{ readonly sequenceNumber: number; readonly parentMessageId: string | null } | null>;
  /**
   * The linear retry/edit delete: every message after the anchor's sequence.
   * Runs before the new reply's sequence is reserved, so survivors keep the
   * lower sequences and the reply is always the highest.
   */
  deleteAfterSequenceWithinTx(
    tx: SettlementTx,
    conversationId: string,
    sequenceNumber: number
  ): Promise<void>;
  /** Deletes the named messages (scoped to the conversation); the fork/single-reply delete. */
  deleteMessagesByIdWithinTx(
    tx: SettlementTx,
    conversationId: string,
    ids: readonly string[]
  ): Promise<void>;
}
