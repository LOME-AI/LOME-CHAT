import { describe, expect, it } from 'vitest';
import { WorkflowDefinition } from '@hushbox/shared';
import {
  MAX_RESUME_STREAMS,
  clientMessageSchema,
  evictBodySchema,
  runStartBodySchema,
  runStopBodySchema,
  serializeFrame,
  socketAttachmentSchema,
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
      runKey: 'key-1',
      bodyHash: 'body-hash-1',
      definition: definitionInput(),
      inputs: { prompt: { kind: 'text', text: 'hi' } },
      userId: 'u1',
      senderId: 'sender-1',
      walletId: 'w1',
      epochNumber: 2,
    };
  }

  it('parses a valid run-start body carrying the run identity', () => {
    const body = runStartBodySchema.parse(validBody());
    expect(body.runKey).toBe('key-1');
    expect(WorkflowDefinition.parse(body.definition)).toBeDefined();
    expect(body).toMatchObject({
      userId: 'u1',
      senderId: 'sender-1',
      walletId: 'w1',
      epochNumber: 2,
    });
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
