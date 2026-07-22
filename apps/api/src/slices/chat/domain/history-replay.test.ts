import { describe, expect, it } from 'vitest';
import { serializeReasoningText } from '@hushbox/shared';
import { stripReplayHistory } from './history-replay.js';
import type { ChatHistoryMessage } from '@hushbox/shared';

/**
 * History-replay stripping (G8): resent assistant turns may embed reasoning in
 * the canonical inline format (both client history sources produce it — a
 * persisted row the client decrypts and resends, and the live optimistic
 * message the client accumulated during streaming). The strip removes it so
 * provider messages never feed thoughts back. All fixtures are built through
 * the shared serializer — the delimiter strings stay module-private (G7).
 */

const user = (content: string): ChatHistoryMessage => ({ role: 'user', content });
const assistant = (content: string): ChatHistoryMessage => ({ role: 'assistant', content });

describe('stripReplayHistory', () => {
  it('strips embedded reasoning from an assistant turn resent from a persisted row', () => {
    const stored = serializeReasoningText('step by step thoughts', 'the final answer');
    const stripped = stripReplayHistory([user('question'), assistant(stored)]);
    expect(stripped).toEqual([user('question'), assistant('the final answer')]);
  });

  it('strips embedded reasoning from a live-accumulated assistant turn (client optimistic form)', () => {
    // The client accumulates streaming reasoning into the same always-closed
    // canonical form the server persists — the strip treats both identically.
    const live = serializeReasoningText('partial thoughts so far', 'answer so far');
    const stripped = stripReplayHistory([assistant(live)]);
    expect(stripped).toEqual([assistant('answer so far')]);
  });

  it('strips every reasoning-bearing assistant turn in a multi-turn regenerate history', () => {
    const first = serializeReasoningText('thoughts one', 'answer one');
    const second = serializeReasoningText('thoughts two', 'answer two');
    const stripped = stripReplayHistory([
      user('q1'),
      assistant(first),
      user('q2'),
      assistant(second),
    ]);
    expect(stripped).toEqual([
      user('q1'),
      assistant('answer one'),
      user('q2'),
      assistant('answer two'),
    ]);
  });

  it('leaves a user turn verbatim even when its text begins like a delimiter', () => {
    // A user message is never parsed — the leading-delimiter tolerance of the
    // shared parser must not be able to eat genuine user text.
    const userText = serializeReasoningText('looks like reasoning', 'but is user prose');
    const stripped = stripReplayHistory([user(userText), assistant('plain answer')]);
    expect(stripped[0]).toEqual(user(userText));
  });

  it('returns the very same array when no assistant turn embeds reasoning', () => {
    const history = [user('question'), assistant('plain answer')];
    expect(stripReplayHistory(history)).toBe(history);
  });

  it('drops an assistant turn that stripped to nothing (a reasoning-only aborted partial)', () => {
    const reasoningOnly = serializeReasoningText('thoughts with no answer yet', '');
    const stripped = stripReplayHistory([user('question'), assistant(reasoningOnly)]);
    expect(stripped).toEqual([user('question')]);
  });

  it('handles an empty history without inventing entries', () => {
    const history: ChatHistoryMessage[] = [];
    expect(stripReplayHistory(history)).toBe(history);
  });
});
