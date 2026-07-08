import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { canRegenerate, regenerateBlockedByOtherUser } from './regenerate-guard.js';
import type { ConversationsStores, SenderChainRow } from '../../conversations/index.js';

const CALLER = 'user-caller';
const OTHER = 'user-other';

function assistant(id: string, parentMessageId: string | null): SenderChainRow {
  return { id, parentMessageId, senderType: 'assistant', senderId: null };
}
function userMsg(
  id: string,
  parentMessageId: string | null,
  senderId: string | null
): SenderChainRow {
  return { id, parentMessageId, senderType: 'user', senderId };
}

describe('regenerateBlockedByOtherUser', () => {
  it('allows when the tip is null (no chain to walk)', () => {
    expect(regenerateBlockedByOtherUser([], null, 'target', CALLER)).toBe(false);
  });

  it('allows when the tip is the target itself', () => {
    expect(regenerateBlockedByOtherUser([], 'target', 'target', CALLER)).toBe(false);
  });

  it('allows a chain of only the caller and assistants', () => {
    const rows = [
      userMsg('target', null, CALLER),
      assistant('a1', 'target'),
      userMsg('u2', 'a1', CALLER),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it("blocks when another user's message sits between tip and target", () => {
    const rows = [
      userMsg('target', null, CALLER),
      userMsg('u2', 'target', OTHER),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(true);
  });

  it('ignores assistant messages (only user senders can intervene)', () => {
    const rows = [userMsg('target', null, CALLER), assistant('tip', 'target')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it('treats a scrubbed (null) senderId as nobody, not another user', () => {
    const rows = [
      userMsg('target', null, CALLER),
      userMsg('u2', 'target', null),
      assistant('tip', 'u2'),
    ];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it('stops (allows) when the chain dangles before reaching the target', () => {
    const rows = [assistant('tip', 'gone')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });

  it('stops (allows) on a cyclic parent reference instead of looping', () => {
    const rows = [assistant('tip', 'loop'), assistant('loop', 'tip')];
    expect(regenerateBlockedByOtherUser(rows, 'tip', 'target', CALLER)).toBe(false);
  });
});

interface FakeReads {
  readonly present?: boolean;
  readonly presentFails?: boolean;
  readonly members?: readonly (string | null)[];
  readonly latestId?: string | null;
  readonly forkTip?: string | null;
  /** The conversation's forks (the fork-required gate reads only their count). */
  readonly forkList?: readonly { readonly id: string }[];
  readonly rows?: readonly SenderChainRow[];
}

function fakeStores(reads: FakeReads): ConversationsStores {
  return {
    members: {
      listActive: () =>
        okAsync((reads.members ?? []).map((userId) => ({ userId }) as { userId: string | null })),
    },
    forks: {
      list: () => okAsync(reads.forkList ?? []),
      byId: () => okAsync(reads.forkTip === undefined ? null : { tipMessageId: reads.forkTip }),
    },
    messages: {
      inConversation: () =>
        reads.presentFails === true
          ? errAsync(unavailableError('inConversation read failed'))
          : okAsync(reads.present ?? true),
      latestId: () => okAsync(reads.latestId ?? null),
      senderChainRows: () => okAsync(reads.rows ?? []),
    },
  } as unknown as ConversationsStores;
}

describe('canRegenerate', () => {
  const base = { conversationId: 'c1', targetMessageId: 'target', userId: CALLER };

  it('reports target-missing when the target is not in the conversation', async () => {
    const decision = await canRegenerate(fakeStores({ present: false }), base);
    expect(decision._unsafeUnwrap().decision).toBe('target-missing');
  });

  it('propagates a read failure as an error', async () => {
    const decision = await canRegenerate(fakeStores({ presentFails: true }), base);
    expect(decision._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('allows a solo conversation without walking the message chain', async () => {
    const stores = fakeStores({ members: [CALLER], rows: [userMsg('target', null, CALLER)] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('allows when no other user intervened on a linear tip', async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'tip',
      rows: [userMsg('target', null, CALLER), assistant('tip', 'target')],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('blocks when another user intervened on the linear tip', async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'tip',
      rows: [
        userMsg('target', null, CALLER),
        userMsg('u2', 'target', OTHER),
        assistant('tip', 'u2'),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('resolves the tip from the fork when a forkId is supplied', async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      forkTip: 'tip',
      rows: [
        userMsg('target', null, CALLER),
        userMsg('u2', 'target', OTHER),
        assistant('tip', 'u2'),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('surfaces the fork tip it observed on an allowed fork regenerate', async () => {
    const stores = fakeStores({
      members: [CALLER],
      forkList: [{ id: 'fork-1' }],
      forkTip: 'fork-tip',
      rows: [userMsg('target', null, CALLER)],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: 'fork-tip' });
  });

  it('surfaces a null observed tip on a linear regenerate', async () => {
    const stores = fakeStores({ members: [CALLER], rows: [userMsg('target', null, CALLER)] });
    const verdict = await canRegenerate(stores, base);
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: null });
  });

  it('surfaces a null observed tip when the fork has no tip yet', async () => {
    const stores = fakeStores({
      members: [CALLER],
      forkList: [{ id: 'fork-1' }],
      forkTip: null,
      rows: [userMsg('target', null, CALLER)],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'allowed', observedForkTipId: null });
  });

  it('carries the observed fork tip even on a blocked fork verdict', async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      forkTip: 'tip',
      rows: [
        userMsg('target', null, CALLER),
        userMsg('u2', 'target', OTHER),
        assistant('tip', 'u2'),
      ],
    });
    const verdict = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(verdict._unsafeUnwrap()).toEqual({ decision: 'blocked', observedForkTipId: 'tip' });
  });
});

// The retry-one delete is scoped to `replaceAssistantId`, so that id must be a
// direct assistant reply of the anchor — otherwise a caller could name ANY
// message (a co-member's) and have the settlement delete it.
describe('canRegenerate — replaceAssistantId must be a direct assistant reply of the target', () => {
  const base = { conversationId: 'c1', targetMessageId: 'target', userId: CALLER };

  it("rejects a replaceAssistantId naming another member's message (not a reply of the target)", async () => {
    const stores = fakeStores({
      members: [CALLER],
      rows: [userMsg('target', null, CALLER), userMsg('victim', 'elsewhere', OTHER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'victim' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId that is an assistant reply of a DIFFERENT anchor', async () => {
    const stores = fakeStores({
      members: [CALLER],
      rows: [
        userMsg('target', null, CALLER),
        userMsg('other-anchor', null, CALLER),
        assistant('reply', 'other-anchor'),
      ],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId absent from the conversation', async () => {
    const stores = fakeStores({ members: [CALLER], rows: [userMsg('target', null, CALLER)] });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'ghost' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('rejects a replaceAssistantId that is a USER message parented on the target', async () => {
    const stores = fakeStores({
      members: [CALLER],
      rows: [userMsg('target', null, CALLER), userMsg('child', 'target', CALLER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'child' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });

  it('allows a replaceAssistantId that IS a direct assistant reply of the target', async () => {
    const stores = fakeStores({
      members: [CALLER],
      rows: [userMsg('target', null, CALLER), assistant('reply', 'target')],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'reply' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('refuses the crafted exploit: target = the tip (empty walk) + a co-member message as the replace id', async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'target',
      rows: [userMsg('target', null, CALLER), userMsg('victim', 'elsewhere', OTHER)],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'victim' });
    expect(decision._unsafeUnwrap().decision).toBe('invalid-replace');
  });
});

// A no-forkId retry-all/edit deletes by sequence across the WHOLE conversation;
// forks share one sequence space, so it is safe only on a fork-less conversation.
describe('canRegenerate — a no-forkId regenerate is refused once the conversation has forks', () => {
  const base = { conversationId: 'c1', targetMessageId: 'target', userId: CALLER };

  it('requires a forkId when the conversation has forks and none was supplied', async () => {
    const stores = fakeStores({ members: [CALLER], forkList: [{ id: 'fork-1' }] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('fork-required');
  });

  it('allows a no-forkId regenerate on a fork-less conversation', async () => {
    const stores = fakeStores({
      members: [CALLER],
      forkList: [],
      rows: [userMsg('target', null, CALLER)],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });

  it('skips the fork-required gate when a forkId is supplied', async () => {
    const stores = fakeStores({
      members: [CALLER],
      forkList: [{ id: 'fork-1' }],
      forkTip: 'target',
      rows: [userMsg('target', null, CALLER)],
    });
    const decision = await canRegenerate(stores, { ...base, forkId: 'fork-1' });
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });
});

// The regenerate/edit anchor MUST be the caller's OWN user message. The
// settlement deletes the anchor's reply(s) (edit/retry-all delete by sequence
// from the anchor), so anchoring on another member's turn — or an assistant /
// scrubbed message — would destroy content the caller does not own. The
// tip→target walk is exclusive of the target, so a foreign anchor slips past
// every other gate; this ownership check is the root fix.
describe("canRegenerate — the anchor must be the caller's own user message", () => {
  const base = { conversationId: 'c1', targetMessageId: 'm3', userId: CALLER };

  it("blocks anchoring on another member's user message (edit / retry-all)", async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'm4',
      rows: [
        userMsg('m1', null, CALLER),
        assistant('a1', 'm1'),
        userMsg('m3', 'a1', OTHER),
        assistant('m4', 'm3'),
      ],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it("blocks anchoring on another member's message even with a valid replaceAssistantId (retry-one)", async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'm4',
      rows: [userMsg('m3', 'a1', OTHER), assistant('m4', 'm3')],
    });
    const decision = await canRegenerate(stores, { ...base, replaceAssistantId: 'm4' });
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks anchoring on an assistant message (not a user turn)', async () => {
    const stores = fakeStores({
      members: [CALLER],
      rows: [userMsg('m1', null, CALLER), assistant('m3', 'm1')],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('blocks anchoring on a scrubbed (null senderId) user message', async () => {
    const stores = fakeStores({ members: [CALLER], rows: [userMsg('m3', null, null)] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it('fails closed (blocked) when the target is absent from the sender chain', async () => {
    const stores = fakeStores({ present: true, members: [CALLER], rows: [] });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('blocked');
  });

  it("allows anchoring on the caller's own user message in a group turn", async () => {
    const stores = fakeStores({
      members: [CALLER, OTHER],
      latestId: 'tip',
      rows: [userMsg('m3', null, CALLER), assistant('tip', 'm3')],
    });
    const decision = await canRegenerate(stores, base);
    expect(decision._unsafeUnwrap().decision).toBe('allowed');
  });
});
