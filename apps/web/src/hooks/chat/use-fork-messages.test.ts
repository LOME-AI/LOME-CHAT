import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { filterMessagesForFork, useForkMessages } from '@/hooks/chat/use-fork-messages.js';
import type { Message } from '@/lib/api.js';

function makeMessage(
  overrides: Partial<Message> & { id: string; parentMessageId?: string | null }
): Message & { parentMessageId?: string | null } {
  return {
    conversationId: 'conv-1',
    role: 'user',
    content: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('filterMessagesForFork', () => {
  it('returns messages in original order when no forks', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
    ];

    const result = filterMessagesForFork(messages, [], null);

    expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('walks parent chain from fork tip to root', () => {
    // Tree:
    //   M1 → M2 → M3 → M4 (Main tip)
    //              ↘ M5 → M6 (Fork 1 tip)
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
      makeMessage({ id: 'm4', parentMessageId: 'm3' }),
      makeMessage({ id: 'm5', parentMessageId: 'm2' }),
      makeMessage({ id: 'm6', parentMessageId: 'm5' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm4', createdAt: '' },
      { id: 'f2', conversationId: 'conv-1', name: 'Fork 1', tipMessageId: 'm6', createdAt: '' },
    ];

    // Walk Main: m4 → m3 → m2 → m1 → reverse → [m1, m2, m3, m4]
    const main = filterMessagesForFork(messages, forks, 'f1');
    expect(main.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);

    // Walk Fork 1: m6 → m5 → m2 → m1 → reverse → [m1, m2, m5, m6]
    const fork1 = filterMessagesForFork(messages, forks, 'f2');
    expect(fork1.map((m) => m.id)).toEqual(['m1', 'm2', 'm5', 'm6']);
  });

  it('returns all messages sorted by sequenceNumber when activeForkId is null and forks exist', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm2', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, null);
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('falls back to all messages when fork tip not found in messages', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      {
        id: 'f1',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'nonexistent',
        createdAt: '',
      },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages when fork ID not found', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm1', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'nonexistent');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages when fork has null tipMessageId', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: null, createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages preserving order when fork not found with multiple messages', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm3', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'nonexistent');
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('handles empty messages array', () => {
    const result = filterMessagesForFork([], [], null);
    expect(result).toEqual([]);
  });

  it('handles single message (root only)', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm1', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('includes sibling AI messages that share the same parentMessageId and batchId', () => {
    // Multi-model: user sends to 2 models in one turn, batchId matches.
    //   u1 → [a1, a2]  (a1 and a2 are batch peers under u1)
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'b1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
      makeMessage({ id: 'a2', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a2', createdAt: '' },
    ];

    // Fork tip is a2; chain walk hits u1. Sibling a1 shares parentMessageId u1 → must be included.
    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
  });

  it('includes siblings at multiple levels in the chain', () => {
    // u1 → a1 → u2 → [a2_claude, a2_gpt]
    // Two batches: (u1, a1) in one, (u2, a2_*) in the next.
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'b1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
      makeMessage({ id: 'u2', parentMessageId: 'a1', role: 'user', batchId: 'b2' }),
      makeMessage({ id: 'a2_claude', parentMessageId: 'u2', role: 'assistant', batchId: 'b2' }),
      makeMessage({ id: 'a2_gpt', parentMessageId: 'u2', role: 'assistant', batchId: 'b2' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a2_gpt', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2_claude', 'a2_gpt']);
  });

  it('does not include sibling messages from other fork branches', () => {
    // Main: u1 → a1 → u2 → a2
    // Fork 1: u1 → a1 → u3 → [a3_claude, a3_gpt] (tip = a3_gpt)
    // Each turn gets its own batch id; cross-batch siblings (a3_* under u3
    // when viewing Main, or a2 under u2 when viewing Fork 1) must NOT leak.
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'b1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
      makeMessage({ id: 'u2', parentMessageId: 'a1', role: 'user', batchId: 'b2' }),
      makeMessage({ id: 'a2', parentMessageId: 'u2', role: 'assistant', batchId: 'b2' }),
      makeMessage({ id: 'u3', parentMessageId: 'a1', role: 'user', batchId: 'b3' }),
      makeMessage({ id: 'a3_claude', parentMessageId: 'u3', role: 'assistant', batchId: 'b3' }),
      makeMessage({ id: 'a3_gpt', parentMessageId: 'u3', role: 'assistant', batchId: 'b3' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a2', createdAt: '' },
      { id: 'f2', conversationId: 'conv-1', name: 'Fork 1', tipMessageId: 'a3_gpt', createdAt: '' },
    ];

    // Main should NOT include Fork 1's messages (u3, a3_claude, a3_gpt)
    const main = filterMessagesForFork(messages, forks, 'f1');
    expect(main.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

    // Fork 1 should include both siblings but NOT Main's u2/a2
    const fork1 = filterMessagesForFork(messages, forks, 'f2');
    expect(fork1.map((m) => m.id)).toEqual(['u1', 'a1', 'u3', 'a3_claude', 'a3_gpt']);
  });

  it('keeps a multi-model assistant sibling on the source branch after the other fork grows', () => {
    // Multi-model conversation with three image responses:
    //   u1 → [a1, a2, a3]  (Main tip = a3, the latest sequenceNumber)
    //
    // The user forks on a1 (Fork 1's tip = a1), then sends a follow-up on
    // Fork 1 creating u4 → a5 underneath a1. Main's tip is unchanged, but
    // a1 now has a child (u4) that is NOT in Main's ancestor chain.
    //
    // Expected: Main still includes [u1, a1, a2, a3] — the assistant
    // siblings of a3 (a1 and a2) are parallel multi-model responses to the
    // same prompt (u1) and must travel with that prompt regardless of what
    // happens below a1 on another fork. The batchId rule keeps them tied
    // to the u1 turn; the follow-up u4/a5 belong to a different batch.
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'batch-u1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-u1' }),
      makeMessage({ id: 'a2', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-u1' }),
      makeMessage({ id: 'a3', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-u1' }),
      // Follow-up sent on Fork 1 (under a1):
      makeMessage({ id: 'u4', parentMessageId: 'a1', role: 'user', batchId: 'batch-u4' }),
      makeMessage({ id: 'a5', parentMessageId: 'u4', role: 'assistant', batchId: 'batch-u4' }),
    ];

    const forks = [
      { id: 'fmain', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a3', createdAt: '' },
      { id: 'ffork', conversationId: 'conv-1', name: 'Fork 1', tipMessageId: 'a5', createdAt: '' },
    ];

    const main = filterMessagesForFork(messages, forks, 'fmain');
    expect(main.map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 'a3']);

    // Sanity: Fork 1 still gets its own chain plus the parallel-batch siblings.
    const fork = filterMessagesForFork(messages, forks, 'ffork');
    expect(fork.map((m) => m.id)).toEqual(['u1', 'a1', 'a2', 'a3', 'u4', 'a5']);
  });

  it('excludes a fork-preserve orphan assistant from Main when its batchId differs from the new tip', () => {
    // Scenario from Failure #1 in the 2026-05-17 E2E report:
    //   1. New conversation: u1 → a1 (batch_T0)
    //   2. Follow-up: u2 (batch_T1) → a2 (batch_T1)
    //   3. Fork from a1 → Fork 1 with tip = a1; user sends → fork_user, fork_ai
    //   4. Switch to Main, retry u1. `deleteForkChain` preserves a1 (Fork 1
    //      has descendants under it) but creates a fresh a1_new under u1 with
    //      a brand-new batch id.
    //
    // After retry, u1 has THREE assistant children: a1 (batch_T0), a1_new
    // (batch_T_new), and — implicitly — the multi-model rule would falsely
    // include a1 as a peer of a1_new. The batchId discriminator forces the
    // filter to exclude a1 from Main (its descendants belong to Fork 1).
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'batch-T0' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-T0' }),
      makeMessage({
        id: 'a1_new',
        parentMessageId: 'u1',
        role: 'assistant',
        batchId: 'batch-T-new',
      }),
      // Fork 1's tail beneath a1 — proves a1 isn't exclusive to Main but
      // still must not appear on Main's view.
      makeMessage({
        id: 'fork_user',
        parentMessageId: 'a1',
        role: 'user',
        batchId: 'batch-fork',
      }),
      makeMessage({
        id: 'fork_ai',
        parentMessageId: 'fork_user',
        role: 'assistant',
        batchId: 'batch-fork',
      }),
    ];

    const forks = [
      {
        id: 'fmain',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'a1_new',
        createdAt: '',
      },
      {
        id: 'ffork',
        conversationId: 'conv-1',
        name: 'Fork 1',
        tipMessageId: 'fork_ai',
        createdAt: '',
      },
    ];

    const main = filterMessagesForFork(messages, forks, 'fmain');
    expect(main.map((m) => m.id)).toEqual(['u1', 'a1_new']);

    // Fork 1 still sees a1 because a1 IS in its ancestor chain (not a sibling).
    const fork = filterMessagesForFork(messages, forks, 'ffork');
    expect(fork.map((m) => m.id)).toEqual(['u1', 'a1', 'fork_user', 'fork_ai']);
  });

  it('keeps multi-model peers visible even when one peer has a fork branching beneath it', () => {
    // Multi-model fan-out: u1 → [a1, a2] (same batch_T0). User later forks
    // off a1; Fork 1 tip is below a1. Viewing Main at a2 (still in batch_T0),
    // a1 must remain visible because a1 and a2 are batch peers.
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'batch-T0' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-T0' }),
      makeMessage({ id: 'a2', parentMessageId: 'u1', role: 'assistant', batchId: 'batch-T0' }),
      makeMessage({
        id: 'fork_user',
        parentMessageId: 'a1',
        role: 'user',
        batchId: 'batch-fork',
      }),
      makeMessage({
        id: 'fork_ai',
        parentMessageId: 'fork_user',
        role: 'assistant',
        batchId: 'batch-fork',
      }),
    ];

    const forks = [
      { id: 'fmain', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a2', createdAt: '' },
      {
        id: 'ffork',
        conversationId: 'conv-1',
        name: 'Fork 1',
        tipMessageId: 'fork_ai',
        createdAt: '',
      },
    ];

    const main = filterMessagesForFork(messages, forks, 'fmain');
    expect(main.map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
  });

  it('prevents infinite loop on circular parentMessageId references', () => {
    // Pathological: m1 → m2 → m1 (circular)
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: 'm2' }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm2', createdAt: '' },
    ];

    // Should not infinite loop; returns whatever it walks before detecting cycle
    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('excludes an assistant sibling that lacks a batchId', () => {
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'b1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
      // Same parent, assistant, but no batchId → not a parallel-batch peer.
      makeMessage({ id: 'a2', parentMessageId: 'u1', role: 'assistant' }),
    ];
    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'a1', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('includes a leaf user sibling whose subtree is vacuously contained', () => {
    const messages = [
      makeMessage({ id: 'u1', parentMessageId: null, role: 'user', batchId: 'b1' }),
      makeMessage({ id: 'a1', parentMessageId: 'u1', role: 'assistant', batchId: 'b1' }),
      makeMessage({ id: 'u2', parentMessageId: 'a1', role: 'user' }),
      // Leaf user sibling of u2 (no children) → contained-thread check is
      // vacuously true, so it is included on this branch.
      makeMessage({ id: 'u3', parentMessageId: 'a1', role: 'user' }),
    ];
    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'u2', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toContain('u3');
  });

  it('returns just the tip when the tip has no parent (undefined parentMessageId)', () => {
    // A message constructed without a parentMessageId (undefined, not null) has
    // no siblings to resolve.
    const messages = [makeMessage({ id: 'root', role: 'user' })];
    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'root', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['root']);
  });
});

describe('useForkMessages', () => {
  it('memoizes the fork-filtered result', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
    ];
    const noForks: never[] = [];

    const { result, rerender } = renderHook(({ msgs }) => useForkMessages(msgs, noForks, null), {
      initialProps: { msgs: messages },
    });

    const first = result.current;
    expect(first.map((m) => m.id)).toEqual(['m1', 'm2']);

    rerender({ msgs: messages });
    // Same inputs → memoized identity is preserved.
    expect(result.current).toBe(first);
  });
});
