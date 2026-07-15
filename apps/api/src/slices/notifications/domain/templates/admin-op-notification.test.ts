import { describe, it, expect } from 'vitest';
import { adminOpNotificationEmail, adminOpNotificationSubject } from './admin-op-notification.js';

const baseInput = {
  opName: 'user.lock',
  actorEmail: 'admin@hushbox.ai',
  targetType: 'user',
  targetId: '0198a7e2-1111-7000-8000-000000000001',
  reason: 'Chargeback investigation',
  occurredAt: '2026-07-12T14:30:00.000Z',
  isUndo: false,
  auditId: '0198a7e2-2222-7000-8000-000000000002',
};

describe('adminOpNotificationSubject', () => {
  it('names the operation', () => {
    expect(adminOpNotificationSubject({ opName: 'user.lock', isUndo: false })).toContain(
      'user.lock'
    );
  });

  it('marks an undo distinctly from a forward execution', () => {
    const forward = adminOpNotificationSubject({ opName: 'user.lock', isUndo: false });
    const undo = adminOpNotificationSubject({ opName: 'user.lock', isUndo: true });

    expect(undo).not.toBe(forward);
    expect(undo).toContain('Undo');
  });
});

describe('adminOpNotificationEmail', () => {
  it('renders the operation name in both bodies', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.html).toContain('user.lock');
    expect(result.text).toContain('user.lock');
  });

  it('renders the actor email in both bodies', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.html).toContain('admin@hushbox.ai');
    expect(result.text).toContain('admin@hushbox.ai');
  });

  it('renders the target type and id in both bodies', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.html).toContain('user');
    expect(result.html).toContain(baseInput.targetId);
    expect(result.text).toContain(baseInput.targetId);
  });

  it('renders the admin-authored reason', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.html).toContain('Chargeback investigation');
    expect(result.text).toContain('Chargeback investigation');
  });

  it('renders the timestamp and audit row id', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.text).toContain(baseInput.occurredAt);
    expect(result.text).toContain(baseInput.auditId);
    expect(result.html).toContain(baseInput.auditId);
  });

  it('labels a forward execution without undo wording', () => {
    const result = adminOpNotificationEmail(baseInput);

    expect(result.html).not.toContain('Undo');
    expect(result.text).not.toContain('Undo');
  });

  it('labels an undo execution distinguishably', () => {
    const result = adminOpNotificationEmail({ ...baseInput, isUndo: true });

    expect(result.html).toContain('Undo');
    expect(result.text).toContain('Undo');
  });

  it('escapes html in admin-authored fields', () => {
    const result = adminOpNotificationEmail({
      ...baseInput,
      reason: '<script>alert(1)</script>',
    });

    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });
});
