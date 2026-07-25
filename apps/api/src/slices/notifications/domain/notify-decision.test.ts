import { describe, it, expect } from 'vitest';
import { selectNotifyRecipients } from './notify-decision.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { NotificationCategory } from '@hushbox/shared';
import type { ConversationMemberView, NotificationPreferences } from '../ports/index.js';

const NOON_UTC = new Date('2026-01-15T12:00:00Z');

function member(userId: string, muted = false): ConversationMemberView {
  return { userId, muted };
}

function prefs(overrides: Partial<NotificationPreferences>): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...overrides };
}

function decide(params: {
  members: readonly ConversationMemberView[];
  category?: NotificationCategory;
  prefsByUser?: ReadonlyMap<string, NotificationPreferences>;
  presentUserIds?: readonly string[];
  actorUserId?: string | null;
  now?: Date;
}): readonly string[] {
  return selectNotifyRecipients({
    members: params.members,
    category: params.category ?? 'message',
    prefsByUser: params.prefsByUser ?? new Map(),
    presentUserIds: params.presentUserIds ?? [],
    actorUserId: params.actorUserId ?? null,
    now: params.now ?? NOON_UTC,
  });
}

describe('selectNotifyRecipients', () => {
  it('notifies an eligible member with no preferences row (defaults apply)', () => {
    expect(decide({ members: [member('u1')] })).toEqual(['u1']);
  });

  it('excludes the actor from a message they sent', () => {
    expect(
      decide({ members: [member('u1'), member('u2')], category: 'message', actorUserId: 'u1' })
    ).toEqual(['u2']);
  });

  it('excludes the actor from a membership change they made', () => {
    expect(
      decide({ members: [member('u1'), member('u2')], category: 'membership', actorUserId: 'u1' })
    ).toEqual(['u2']);
  });

  it('notifies the actor when the run they started completes', () => {
    expect(
      decide({
        members: [member('u1'), member('u2')],
        category: 'runCompletion',
        actorUserId: 'u1',
      })
    ).toEqual(['u1', 'u2']);
  });

  it('notifies the sole member of a solo conversation when their run completes', () => {
    expect(
      decide({ members: [member('u1')], category: 'runCompletion', actorUserId: 'u1' })
    ).toEqual(['u1']);
  });

  it('still suppresses the actor of a completed run while they are watching it', () => {
    expect(
      decide({
        members: [member('u1')],
        category: 'runCompletion',
        actorUserId: 'u1',
        presentUserIds: ['u1'],
      })
    ).toEqual([]);
  });

  it('excludes a present member', () => {
    expect(decide({ members: [member('u1'), member('u2')], presentUserIds: ['u2'] })).toEqual([
      'u1',
    ]);
  });

  it('excludes a muted member', () => {
    expect(decide({ members: [member('u1'), member('u2', true)] })).toEqual(['u1']);
  });

  it('excludes a member with the global switch off', () => {
    const prefsByUser = new Map([['u1', prefs({ globalEnabled: false })]]);
    expect(decide({ members: [member('u1'), member('u2')], prefsByUser })).toEqual(['u2']);
  });

  it('excludes a member whose message category toggle is off', () => {
    const prefsByUser = new Map([['u1', prefs({ messages: false })]]);
    expect(
      decide({ members: [member('u1'), member('u2')], category: 'message', prefsByUser })
    ).toEqual(['u2']);
  });

  it('excludes a member whose runCompletion category toggle is off', () => {
    const prefsByUser = new Map([['u1', prefs({ runCompletion: false })]]);
    expect(
      decide({ members: [member('u1'), member('u2')], category: 'runCompletion', prefsByUser })
    ).toEqual(['u2']);
  });

  it('excludes a member whose membership category toggle is off', () => {
    const prefsByUser = new Map([['u1', prefs({ membership: false })]]);
    expect(
      decide({ members: [member('u1'), member('u2')], category: 'membership', prefsByUser })
    ).toEqual(['u2']);
  });

  it('honors a category toggle independently of the others', () => {
    // messages off but runCompletion on: a runCompletion event still reaches u1.
    const prefsByUser = new Map([['u1', prefs({ messages: false, runCompletion: true })]]);
    expect(decide({ members: [member('u1')], category: 'runCompletion', prefsByUser })).toEqual([
      'u1',
    ]);
  });

  it('suppresses a member inside their quiet hours', () => {
    // 07:00 NY at NOON_UTC; window 06:00–08:00 → inside.
    const prefsByUser = new Map([
      [
        'u1',
        prefs({
          quietHoursStartMinutes: 6 * 60,
          quietHoursEndMinutes: 8 * 60,
          timezone: 'America/New_York',
        }),
      ],
    ]);
    expect(decide({ members: [member('u1'), member('u2')], prefsByUser })).toEqual(['u2']);
  });

  it('does not suppress a member outside their quiet hours', () => {
    // 07:00 NY; window 22:00–06:00 → outside.
    const prefsByUser = new Map([
      [
        'u1',
        prefs({
          quietHoursStartMinutes: 22 * 60,
          quietHoursEndMinutes: 6 * 60,
          timezone: 'America/New_York',
        }),
      ],
    ]);
    expect(decide({ members: [member('u1')], prefsByUser })).toEqual(['u1']);
  });

  it('suppresses in the early arm of a cross-midnight window', () => {
    const earlyMorning = new Date('2026-01-16T10:00:00Z'); // 05:00 NY
    const prefsByUser = new Map([
      [
        'u1',
        prefs({
          quietHoursStartMinutes: 22 * 60,
          quietHoursEndMinutes: 6 * 60,
          timezone: 'America/New_York',
        }),
      ],
    ]);
    expect(decide({ members: [member('u1')], prefsByUser, now: earlyMorning })).toEqual([]);
  });

  it('evaluates quiet hours in the member stored zone, not the server zone', () => {
    // 21:00 Tokyo at NOON_UTC; window 20:00–06:00 → inside.
    const prefsByUser = new Map([
      [
        'u1',
        prefs({
          quietHoursStartMinutes: 20 * 60,
          quietHoursEndMinutes: 6 * 60,
          timezone: 'Asia/Tokyo',
        }),
      ],
    ]);
    expect(decide({ members: [member('u1')], prefsByUser })).toEqual([]);
  });

  it('ignores quiet hours when the window is unset even with a timezone absent', () => {
    // Default prefs carry null quiet-hours fields → never suppressed.
    expect(decide({ members: [member('u1')], now: new Date('2026-01-16T03:00:00Z') })).toEqual([
      'u1',
    ]);
  });

  it('applies every filter together', () => {
    const prefsByUser = new Map([
      ['actor', prefs({})],
      ['present', prefs({})],
      ['muted', prefs({})],
      ['off', prefs({ globalEnabled: false })],
      [
        'quiet',
        prefs({
          quietHoursStartMinutes: 6 * 60,
          quietHoursEndMinutes: 8 * 60,
          timezone: 'America/New_York',
        }),
      ],
      ['ok', prefs({})],
    ]);
    const members = [
      member('actor'),
      member('present'),
      member('muted', true),
      member('off'),
      member('quiet'),
      member('ok'),
    ];
    expect(
      decide({ members, prefsByUser, actorUserId: 'actor', presentUserIds: ['present'] })
    ).toEqual(['ok']);
  });
});
