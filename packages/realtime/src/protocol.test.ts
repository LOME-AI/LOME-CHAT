import { describe, expect, it } from 'vitest';
import { WorkflowDefinition } from '@hushbox/shared';
import {
  MAX_RESUME_STREAMS,
  TRIAL_ROOM_PREFIX,
  clientMessageSchema,
  evictBodySchema,
  isTrialRoomSelf,
  runStartBodySchema,
  runStopBodySchema,
  serializeFrame,
  socketAttachmentSchema,
  trialRoomName,
} from './protocol.js';

function definitionInput(): unknown {
  return {
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat-admission', settlement: 'chat-settlement' },
    nodes: [
      {
        id: 'n1',
        version: 1,
        out: 'out',
        type: 'modelCall',
        model: 'test-model',
        params: {},
        in: { node: 'n1', port: 'in' },
      },
    ],
    edges: [],
  };
}

describe('clientMessageSchema', () => {
  it('parses a typing:start event', () => {
    const message = clientMessageSchema.parse({
      type: 'typing:start',
      timestamp: 1000,
      conversationId: 'c1',
      userId: 'u1',
    });
    expect(message.type).toBe('typing:start');
  });

  it('parses a typing:stop event', () => {
    const message = clientMessageSchema.parse({
      type: 'typing:stop',
      timestamp: 1000,
      conversationId: 'c1',
      userId: 'u1',
    });
    expect(message.type).toBe('typing:stop');
  });

  it('parses a resume request with per-stream cursors', () => {
    const message = clientMessageSchema.parse({
      type: 'resume',
      streams: [{ streamId: 's1', lastEventId: 4 }],
    });
    expect(message).toEqual({ type: 'resume', streams: [{ streamId: 's1', lastEventId: 4 }] });
  });

  it('rejects an unknown message type', () => {
    const result = clientMessageSchema.safeParse({ type: 'message:new', timestamp: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a resume request with a negative lastEventId', () => {
    const result = clientMessageSchema.safeParse({
      type: 'resume',
      streams: [{ streamId: 's1', lastEventId: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a resume request exceeding the stream cap', () => {
    const streams = Array.from({ length: MAX_RESUME_STREAMS + 1 }, (_, index) => ({
      streamId: `s${String(index)}`,
      lastEventId: 0,
    }));
    const result = clientMessageSchema.safeParse({ type: 'resume', streams });
    expect(result.success).toBe(false);
  });
});

describe('runStartBodySchema', () => {
  function validBody(): Record<string, unknown> {
    return {
      mode: 'paid',
      runKey: 'key-1',
      bodyHash: 'body-hash-1',
      definition: definitionInput(),
      inputs: { prompt: { kind: 'text', text: 'hi' } },
      userId: 'u1',
      senderId: 'sender-1',
      walletId: 'w1',
      epochNumber: 2,
      userMessage: { id: 'um1', content: 'hi' },
    };
  }

  function validTrialBody(): Record<string, unknown> {
    return {
      mode: 'trial',
      runKey: 'key-1',
      bodyHash: 'body-hash-1',
      definition: definitionInput(),
      inputs: { prompt: { kind: 'text', text: 'hi' } },
      sessionId: 'session-1',
    };
  }

  it('parses a valid paid run-start body carrying the run identity', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body.runKey).toBe('key-1');
    expect(WorkflowDefinition.parse(body.definition)).toBeDefined();
    expect(body).toMatchObject({
      mode: 'paid',
      userId: 'u1',
      senderId: 'sender-1',
      walletId: 'w1',
      epochNumber: 2,
    });
  });

  it('parses a paid body carrying a regenerate action', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
    expect(body).toMatchObject({
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', replaceAssistantId: 'a1' },
    });
  });

  it('parses a paid regenerate carrying an observed fork tip', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: 'tip-1' },
    });
    expect(body).toMatchObject({
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: 'tip-1' },
    });
  });

  it('parses a paid regenerate with a null observed fork tip', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: null },
    });
    expect(body).toMatchObject({
      regenerate: { action: 'retry', targetMessageId: 'anchor-1', observedForkTipId: null },
    });
  });

  it('parses a paid edit regenerate without a replaceAssistantId', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      regenerate: { action: 'edit', targetMessageId: 'anchor-1' },
    });
    expect(body).toMatchObject({ regenerate: { action: 'edit', targetMessageId: 'anchor-1' } });
  });

  it('rejects a regenerate action with an unknown action verb', () => {
    expect(
      runStartBodySchema.safeParse({
        ...validBody(),
        regenerate: { action: 'delete', targetMessageId: 'anchor-1' },
      }).success
    ).toBe(false);
  });

  it('parses a paid body carrying a user sender principal with a memberId', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      sender: { kind: 'user', userId: 'u1', memberId: 'm1' },
    });
    expect(body).toMatchObject({ sender: { kind: 'user', userId: 'u1', memberId: 'm1' } });
  });

  it('parses a paid body carrying a link-guest sender principal (linkId + memberId)', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      sender: { kind: 'linkGuest', linkId: 'l1', memberId: 'm1' },
    });
    expect(body).toMatchObject({ sender: { kind: 'linkGuest', linkId: 'l1', memberId: 'm1' } });
  });

  it('parses a paid body with no sender (the existing user shape stays valid)', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body).not.toHaveProperty('sender');
  });

  it('rejects a link-guest sender missing its memberId', () => {
    expect(
      runStartBodySchema.safeParse({
        ...validBody(),
        sender: { kind: 'linkGuest', linkId: 'l1' },
      }).success
    ).toBe(false);
  });

  it('rejects a link-guest sender missing its linkId', () => {
    expect(
      runStartBodySchema.safeParse({
        ...validBody(),
        sender: { kind: 'linkGuest', memberId: 'm1' },
      }).success
    ).toBe(false);
  });

  it('rejects a sender carrying an unknown principal kind', () => {
    expect(
      runStartBodySchema.safeParse({
        ...validBody(),
        sender: { kind: 'robot', userId: 'u1', memberId: 'm1' },
      }).success
    ).toBe(false);
  });

  it('parses a valid trial run-start body carrying only the session id', () => {
    const body = runStartBodySchema.parse(validTrialBody());
    expect(body).toMatchObject({ mode: 'trial', sessionId: 'session-1' });
    // A trial body has no wallet or epoch — the discriminant keeps the shapes disjoint.
    expect(body).not.toHaveProperty('walletId');
  });

  it('defaults an absent history to the empty array on a paid body', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body.history).toEqual([]);
  });

  it('defaults an absent history to the empty array on a trial body', () => {
    const body = runStartBodySchema.parse(validTrialBody());
    expect(body.history).toEqual([]);
  });

  it('omits mockDirectives when the body carries none (production shape)', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body).not.toHaveProperty('mockDirectives');
  });

  it('parses a paid body carrying per-request mockDirectives', () => {
    const body = runStartBodySchema.parse({
      ...validBody(),
      mockDirectives: { classifierResolution: 'a/model', failingModels: ['m1'] },
    });
    expect(body).toMatchObject({
      mockDirectives: { classifierResolution: 'a/model', failingModels: ['m1'] },
    });
  });

  it('parses a trial body carrying per-request mockDirectives', () => {
    const body = runStartBodySchema.parse({
      ...validTrialBody(),
      mockDirectives: { classifierFailure: true },
    });
    expect(body).toMatchObject({ mockDirectives: { classifierFailure: true } });
  });

  it('rejects a malformed mockDirectives field', () => {
    expect(
      runStartBodySchema.safeParse({ ...validBody(), mockDirectives: { failingModels: [] } })
        .success
    ).toBe(false);
  });

  it('parses a paid body carrying role-tagged history', () => {
    const history = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ];
    const body = runStartBodySchema.parse({ ...validBody(), history });
    expect(body.history).toEqual(history);
  });

  it('parses a trial body carrying role-tagged history', () => {
    const history = [{ role: 'user', content: 'earlier' }];
    const body = runStartBodySchema.parse({ ...validTrialBody(), history });
    expect(body.history).toEqual(history);
  });

  it('rejects a history entry with an unknown role', () => {
    expect(
      runStartBodySchema.safeParse({
        ...validBody(),
        history: [{ role: 'system', content: 'x' }],
      }).success
    ).toBe(false);
  });

  it('rejects a trial body without a sessionId', () => {
    expect(
      runStartBodySchema.safeParse({ ...validTrialBody(), sessionId: undefined }).success
    ).toBe(false);
  });

  it('rejects a body with an unknown mode', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), mode: 'other' }).success).toBe(false);
  });

  it('rejects a body without a runKey', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), runKey: undefined }).success).toBe(false);
  });

  it('rejects a body without a bodyHash', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), bodyHash: undefined }).success).toBe(
      false
    );
  });

  it('rejects a body without the paying userId', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), userId: undefined }).success).toBe(false);
  });

  it('rejects a body without a walletId', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), walletId: undefined }).success).toBe(
      false
    );
  });

  it('rejects a non-positive epochNumber', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), epochNumber: 0 }).success).toBe(false);
  });

  it('rejects a paid body without the user message', () => {
    expect(runStartBodySchema.safeParse({ ...validBody(), userMessage: undefined }).success).toBe(
      false
    );
  });

  it('parses the paid body carrying the user message', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body).toMatchObject({ userMessage: { id: 'um1', content: 'hi' } });
  });
});

describe('control bodies', () => {
  it('parses an evict body', () => {
    expect(evictBodySchema.parse({ principalId: 'u1' })).toEqual({ principalId: 'u1' });
  });

  it('rejects an evict body with an empty principalId', () => {
    expect(evictBodySchema.safeParse({ principalId: '' }).success).toBe(false);
  });

  it('parses a user-stop body', () => {
    expect(runStopBodySchema.parse({ reason: 'user-stop' })).toEqual({ reason: 'user-stop' });
  });

  it('rejects a stop body with the deadline reason', () => {
    expect(runStopBodySchema.safeParse({ reason: 'deadline' }).success).toBe(false);
  });
});

describe('socketAttachmentSchema', () => {
  it('parses a guest attachment with a display name', () => {
    const attachment = socketAttachmentSchema.parse({
      principalId: 'link-1',
      conversationId: 'c1',
      displayName: 'Guest',
      isGuest: true,
      connectedAt: 123,
    });
    expect(attachment.isGuest).toBe(true);
  });

  it('rejects an attachment without a conversationId', () => {
    const result = socketAttachmentSchema.safeParse({
      principalId: 'u1',
      isGuest: false,
      connectedAt: 123,
    });
    expect(result.success).toBe(false);
  });
});

describe('serializeFrame', () => {
  it('serializes a stream frame as JSON', () => {
    const json = serializeFrame({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
    expect(JSON.parse(json)).toEqual({
      type: 'stream',
      streamId: 's1',
      cursor: 1,
      event: { kind: 'text-delta', index: 0, content: 'hi' },
    });
  });
});

describe('trial room naming', () => {
  const SESSION = '11111111-1111-4111-8111-111111111111';

  it('prefixes the session id to form the trial room name', () => {
    expect(trialRoomName(SESSION)).toBe(`${TRIAL_ROOM_PREFIX}${SESSION}`);
  });

  it('recognizes a trial session streaming its own room', () => {
    const room = trialRoomName(SESSION);
    expect(isTrialRoomSelf(room, room)).toBe(true);
  });

  it('rejects a trial principal addressing another trial room', () => {
    expect(isTrialRoomSelf(trialRoomName('other'), trialRoomName(SESSION))).toBe(false);
  });

  it('rejects a conversation member (bare uuid ids never carry the prefix)', () => {
    expect(isTrialRoomSelf('conv-1', 'user-1')).toBe(false);
  });

  it('rejects a trial principal whose id matches a bare conversation id', () => {
    // The room id must itself be prefixed — equality alone is not enough.
    expect(isTrialRoomSelf('conv-1', 'conv-1')).toBe(false);
  });
});
