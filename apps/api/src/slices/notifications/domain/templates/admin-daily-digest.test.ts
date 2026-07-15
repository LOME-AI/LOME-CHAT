import { describe, it, expect } from 'vitest';
import { adminDailyDigestEmail, adminDailyDigestSubject } from './admin-daily-digest.js';

const actions = [
  {
    opName: 'user.lock',
    actorEmail: 'admin@hushbox.ai',
    targetType: 'user',
    targetId: '0198a7e2-1111-7000-8000-000000000001',
    occurredAt: '2026-07-12T09:15:00.000Z',
  },
  {
    opName: 'wallet.credit',
    actorEmail: 'founder@hushbox.ai',
    targetType: 'wallet',
    targetId: '0198a7e2-3333-7000-8000-000000000003',
    occurredAt: '2026-07-12T17:42:00.000Z',
  },
];

describe('adminDailyDigestSubject', () => {
  it('names the digest day', () => {
    expect(adminDailyDigestSubject({ day: '2026-07-12' })).toContain('2026-07-12');
  });
});

describe('adminDailyDigestEmail', () => {
  it('renders the digest day in both bodies', () => {
    const result = adminDailyDigestEmail({ day: '2026-07-12', actions });

    expect(result.html).toContain('2026-07-12');
    expect(result.text).toContain('2026-07-12');
  });

  it('renders every action with op name, actor, target, and time', () => {
    const result = adminDailyDigestEmail({ day: '2026-07-12', actions });

    for (const action of actions) {
      for (const body of [result.html, result.text]) {
        expect(body).toContain(action.opName);
        expect(body).toContain(action.actorEmail);
        expect(body).toContain(action.targetId);
        expect(body).toContain(action.occurredAt);
      }
    }
  });

  it('states the action count when actions exist', () => {
    const result = adminDailyDigestEmail({ day: '2026-07-12', actions });

    expect(result.text).toContain('2 admin action');
  });

  it('renders a zero-actions variant', () => {
    const result = adminDailyDigestEmail({ day: '2026-07-12', actions: [] });

    expect(result.html).toContain('No admin actions');
    expect(result.text).toContain('No admin actions');
  });

  it('escapes html in action fields', () => {
    const result = adminDailyDigestEmail({
      day: '2026-07-12',
      actions: [{ ...actions[0]!, opName: '<img src=x>' }],
    });

    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('&lt;img');
  });
});
