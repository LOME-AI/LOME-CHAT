import { describe, it, expect } from 'vitest';
import { selectPushRecipients } from './push-recipients.js';

const base = {
  members: [
    { userId: 'sender', muted: false },
    { userId: 'muted-member', muted: true },
    { userId: 'present-member', muted: false },
    { userId: 'absent-member', muted: false },
  ],
  presentUserIds: ['present-member'],
  senderUserId: 'sender',
};

describe('selectPushRecipients', () => {
  it('selects absent unmuted members', () => {
    expect(selectPushRecipients(base)).toEqual(['absent-member']);
  });

  it('excludes muted members', () => {
    expect(selectPushRecipients(base)).not.toContain('muted-member');
  });

  it('excludes present members', () => {
    expect(selectPushRecipients(base)).not.toContain('present-member');
  });

  it('excludes the sender', () => {
    expect(selectPushRecipients(base)).not.toContain('sender');
  });

  it('selects nobody when every member is filtered out', () => {
    const recipients = selectPushRecipients({
      ...base,
      members: base.members.slice(0, 3),
    });

    expect(recipients).toEqual([]);
  });
});
