import { parseReasoningText } from '@hushbox/shared';
import type { ChatHistoryMessage } from '@hushbox/shared';

/**
 * Strips embedded reasoning from resent assistant turns before a run starts
 * (G8): persisted assistant text may carry the model's reasoning inline in the
 * canonical format (same-field storage doctrine, R2/G6), and BOTH client
 * history sources resend it verbatim — rows the client decrypted (E2EE means
 * the server never reads them from the DB) and the client's live-accumulated
 * optimistic messages. Feeding thoughts back changes model behavior and cost,
 * so provider messages must never contain them.
 *
 * Only assistant turns are parsed — user text is never interpreted, so the
 * parser's leading-delimiter tolerance cannot eat genuine user prose. An
 * assistant turn that strips to nothing (a reasoning-only aborted partial) is
 * dropped: an empty assistant message has no replay value and some providers
 * reject empty content. A history with nothing to strip returns the SAME array,
 * preserving the untouched-request identity of the start path.
 */
export function stripReplayHistory(
  history: readonly ChatHistoryMessage[]
): readonly ChatHistoryMessage[] {
  let changed = false;
  const stripped: ChatHistoryMessage[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') {
      stripped.push(message);
      continue;
    }
    const parsed = parseReasoningText(message.content);
    if (parsed.reasoning === undefined) {
      stripped.push(message);
      continue;
    }
    changed = true;
    if (parsed.answer !== '') {
      stripped.push({ role: 'assistant', content: parsed.answer });
    }
  }
  return changed ? stripped : history;
}
