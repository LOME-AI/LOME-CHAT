import { notFoundError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import type { ConversationsStores } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Reserve a contiguous block of message sequence numbers (published for the
 * chat settlement, which owns no `conversations` access). Bumps the
 * conversation's monotonic `nextSequence` counter by `count` and returns the
 * reserved block, lowest first — chat stamps the turn's user and assistant
 * messages onto these. The numbers are never reused, so ordering never
 * collides even after a message is deleted.
 *
 * A missing conversation is an expected domain `Result` error (the settlement
 * gate that runs first already guarantees the row exists, so in practice this
 * arm is unreachable from the turn path).
 */

export interface SequenceBlockRequest {
  readonly conversationId: string;
  readonly count: number;
}

export function reserveSequenceBlockWithinTx(
  stores: ConversationsStores,
  params: SequenceBlockRequest
): ResultAsync<readonly number[], DomainError> {
  return stores.conversations
    .reserveSequenceBlock(params)
    .andThen((sequences) =>
      sequences === null
        ? errAsync<readonly number[], DomainError>(
            notFoundError('sequence block: conversation not found')
          )
        : okAsync<readonly number[], DomainError>(sequences)
    );
}
