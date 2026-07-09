import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import {
  broadcastMemberAdded,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  broadcastRotationComplete,
} from './member-events.js';
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

describe('member event broadcasts', () => {
  it('broadcasts member:added with the member id, user id, and privilege', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastMemberAdded(realtime, {
      conversationId: 'c1',
      memberId: 'm1',
      userId: 'u1',
      privilege: 'write',
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.conversationId).toBe('c1');
    expect(events[0]?.event).toMatchObject({
      type: 'member:added',
      conversationId: 'c1',
      memberId: 'm1',
      userId: 'u1',
      privilege: 'write',
    });
  });

  it('omits userId from member:added when not provided', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastMemberAdded(realtime, {
      conversationId: 'c1',
      memberId: 'm1',
      privilege: 'read',
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).not.toHaveProperty('userId');
  });

  it('broadcasts member:removed with the member id and user id', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastMemberRemoved(realtime, {
      conversationId: 'c1',
      memberId: 'm1',
      userId: 'u1',
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).toMatchObject({
      type: 'member:removed',
      memberId: 'm1',
      userId: 'u1',
    });
  });

  it('broadcasts member:privilege-changed with the new privilege', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastMemberPrivilegeChanged(realtime, {
      conversationId: 'c1',
      memberId: 'm1',
      privilege: 'admin',
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).toMatchObject({
      type: 'member:privilege-changed',
      memberId: 'm1',
      privilege: 'admin',
    });
  });

  it('broadcasts rotation:complete with the new epoch number', async () => {
    const { events, realtime } = recordingRealtime();
    const result = await broadcastRotationComplete(realtime, {
      conversationId: 'c1',
      newEpochNumber: 3,
    });
    expect(result.isOk()).toBe(true);
    expect(events[0]?.event).toMatchObject({
      type: 'rotation:complete',
      conversationId: 'c1',
      newEpochNumber: 3,
    });
  });
});
