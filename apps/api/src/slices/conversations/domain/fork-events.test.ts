import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { broadcastForkCreated, broadcastForkDeleted, broadcastForkRenamed } from './fork-events.js';
import type { RealtimeBroadcast } from '../ports/index.js';
import type { RealtimeEvent } from '@hushbox/realtime/events';

function recordingRealtime(): {
  readonly events: { conversationId: string; event: RealtimeEvent }[];
  readonly realtime: RealtimeBroadcast;
} {
  const events: { conversationId: string; event: RealtimeEvent }[] = [];
  const realtime = {
    broadcast: (conversationId: string, event: RealtimeEvent) => {
      events.push({ conversationId, event });
      return okAsync({ delivered: 1, paused: 0, evicted: 0 });
    },
  } as unknown as RealtimeBroadcast;
  return { events, realtime };
}

describe('fork event broadcasts', () => {
  it('broadcasts fork:created with the new branch name and tip', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastForkCreated(realtime, {
      conversationId: 'c1',
      forkId: 'f1',
      name: 'Branch',
      tipMessageId: 'msg-3',
    });
    expect(result.isOk()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.conversationId).toBe('c1');
    expect(events[0]?.event).toMatchObject({
      type: 'fork:created',
      forkId: 'f1',
      conversationId: 'c1',
      name: 'Branch',
      tipMessageId: 'msg-3',
    });
  });

  it('broadcasts fork:renamed with the new name', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastForkRenamed(realtime, {
      conversationId: 'c1',
      forkId: 'f1',
      name: 'Renamed',
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).toMatchObject({ type: 'fork:renamed', forkId: 'f1', name: 'Renamed' });
  });

  it('broadcasts fork:deleted with the fork id', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastForkDeleted(realtime, { conversationId: 'c1', forkId: 'f1' });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).toMatchObject({
      type: 'fork:deleted',
      forkId: 'f1',
      conversationId: 'c1',
    });
  });
});
