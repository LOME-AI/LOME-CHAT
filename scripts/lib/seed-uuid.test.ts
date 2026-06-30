import { describe, it, expect } from 'vitest';
import { seedUUID } from './seed-uuid.js';

describe('seedUUID', () => {
  it('returns the same UUID for the same name', () => {
    expect(seedUUID('screenshot-conv-group-chat')).toBe(seedUUID('screenshot-conv-group-chat'));
  });

  it('returns different UUIDs for different names', () => {
    expect(seedUUID('screenshot-conv-chat')).not.toBe(seedUUID('screenshot-conv-code'));
  });

  it('returns a v4-shaped UUID', () => {
    expect(seedUUID('anything')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  // Pinned values: deterministic IDs derived from seed keys are persisted in
  // external artifacts (e.g. store screenshots reference seeded conversation
  // IDs). An algorithm change silently re-derives every ID — catch it here.
  it('derives the historically pinned UUID for a known name', () => {
    expect(seedUUID('screenshot-conv-chat')).toBe('00000000-0000-4000-8000-000070213956');
    expect(seedUUID('dev-user-alice')).toBe('00000000-0000-4000-8000-000029694ab6');
  });
});
