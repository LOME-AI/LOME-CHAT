import { describe, expect, it } from 'vitest';
import {
  ADMIN_TARGET_PERSONA,
  BASE_TEST_PERSONAS,
  DEV_PERSONAS,
  E2E_PROJECT_NAMES,
  MOBILE_TEST_PERSONA,
  SEED_REMOTE_REFUSAL_MESSAGE,
  TEST_2FA_TOTP_SECRET,
  TEST_PERSONAS,
  assertLocalDatabaseUrl,
  assertNoSeedArgs,
  buildPersonaSampleConversations,
  isLocalDatabaseUrl,
  personasWithSampleData,
  screenshotConversationTitle,
  seedUUID,
  testPersonaName,
} from './seed.js';

describe('assertLocalDatabaseUrl remote-DB guard', () => {
  it('refuses a remote (non-local) DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable DATABASE_URL (fails closed)', () => {
    expect(() => {
      assertLocalDatabaseUrl('not a valid url');
    }).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('accepts a 127.0.0.1 DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@127.0.0.1:4444/hushbox');
    }).not.toThrow();
  });

  it('accepts a bracketed IPv6 loopback DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@[::1]:5432/hushbox');
    }).not.toThrow();
  });

  it('accepts a localhost DATABASE_URL', () => {
    expect(() => {
      assertLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox');
    }).not.toThrow();
  });
});

describe('isLocalDatabaseUrl', () => {
  it('is true for a loopback host', () => {
    expect(isLocalDatabaseUrl('postgres://postgres:postgres@localhost:5432/hushbox')).toBe(true);
  });

  it('is false for a remote host', () => {
    expect(isLocalDatabaseUrl('postgres://user:pass@db.prod.neon.tech/hushbox')).toBe(false);
  });

  it('is false (fail-closed) for an unparseable URL', () => {
    expect(isLocalDatabaseUrl('::::')).toBe(false);
  });
});

describe('assertNoSeedArgs', () => {
  it('accepts an empty argv', () => {
    expect(() => {
      assertNoSeedArgs([]);
    }).not.toThrow();
  });

  it('rejects the removed --profile flag with a clear error', () => {
    expect(() => {
      assertNoSeedArgs(['--profile', 'e2e']);
    }).toThrow(/profiles were removed.*seeds everything/);
  });

  it('rejects any unexpected argument (fail-fast, never silently ignored)', () => {
    expect(() => {
      assertNoSeedArgs(['--anything']);
    }).toThrow(/unexpected argument "--anything"/);
  });
});

describe('e2e re-exports (imported from scripts/seed.js)', () => {
  it('exposes the base and cross-product persona rosters', () => {
    expect(BASE_TEST_PERSONAS).toHaveLength(11);
    expect(TEST_PERSONAS).toHaveLength(BASE_TEST_PERSONAS.length * E2E_PROJECT_NAMES.length);
  });

  it('exposes the mobile and dev personas', () => {
    expect(MOBILE_TEST_PERSONA.name).toBe('test-mobile');
    expect(DEV_PERSONAS.map((persona) => persona.name)).toStrictEqual(['alice', 'bob', 'charlie']);
  });

  it('exposes the project names and the 2FA secret constant', () => {
    expect([...E2E_PROJECT_NAMES]).toContain('chromium');
    expect(TEST_2FA_TOTP_SECRET).toBe('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  });

  it('exposes the deterministic derivations', () => {
    expect(testPersonaName('test-alice', 'chromium')).toBe('test-alice-chromium');
    expect(seedUUID('anything')).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  });
});

describe('screenshotConversationTitle', () => {
  it('derives a "Screenshot: <name>" title from a screenshot seed key', () => {
    expect(screenshotConversationTitle('screenshot-conv-chat')).toBe('Screenshot: chat');
    expect(screenshotConversationTitle('screenshot-conv-group-chat')).toBe(
      'Screenshot: group-chat'
    );
  });
});

describe('buildPersonaSampleConversations (bulk per-persona sample data)', () => {
  it('produces one conversation per requested count (alice: 150)', () => {
    expect(buildPersonaSampleConversations('alice', 150)).toHaveLength(150);
  });

  it('scales with the requested count for a smaller roster', () => {
    expect(buildPersonaSampleConversations('bob', 3)).toHaveLength(3);
  });

  it('titles the third conversation as the search-tool demo, the rest per-persona', () => {
    const conversations = buildPersonaSampleConversations('alice', 5);
    expect(conversations[0]?.title).toBe('alice Conversation 1');
    expect(conversations[2]?.title).toBe('Quantum Computing Research');
    expect(conversations[4]?.title).toBe('alice Conversation 5');
  });

  it('gives generic conversations 3 + (index % 3) messages, alternating user/ai', () => {
    const conversations = buildPersonaSampleConversations('bob', 6);
    expect(conversations[0]?.messages).toHaveLength(3);
    expect(conversations[1]?.messages).toHaveLength(4);
    expect(conversations[3]?.messages).toHaveLength(3);
    expect(conversations[0]?.messages.map((message) => message.senderType)).toEqual([
      'user',
      'ai',
      'user',
    ]);
    expect(conversations[0]?.messages[0]?.content).toBe('bob message 1-1');
  });

  it('gives the search conversation the four canned search-tool messages', () => {
    const conversations = buildPersonaSampleConversations('alice', 3);
    expect(conversations[2]?.messages).toHaveLength(4);
    expect(conversations[2]?.messages.map((message) => message.senderType)).toEqual([
      'user',
      'ai',
      'user',
      'ai',
    ]);
  });

  it('assigns deterministic per-persona conversation ids', () => {
    const conversations = buildPersonaSampleConversations('alice', 3);
    expect(conversations[0]?.id).toBe(seedUUID('alice-conv-1'));
    expect(conversations[2]?.id).toBe(seedUUID('alice-conv-3'));
  });
});

describe('personasWithSampleData (hasSampleData gate)', () => {
  it('selects only personas whose hasSampleData is set, with their conversation count', () => {
    const selected = personasWithSampleData([...DEV_PERSONAS, ADMIN_TARGET_PERSONA]);
    expect(selected.map((persona) => persona.name)).toEqual(['alice']);
    expect(selected[0]?.sampleConversationCount).toBe(150);
  });

  it('excludes non-hasSampleData personas (bob, charlie, mallory)', () => {
    const selected = personasWithSampleData([...DEV_PERSONAS, ADMIN_TARGET_PERSONA]);
    const names = selected.map((persona) => persona.name);
    expect(names).not.toContain('bob');
    expect(names).not.toContain('charlie');
    expect(names).not.toContain('mallory');
  });
});

describe('admin op-target persona', () => {
  it('carries a negative purchased balance and stays out of the demo roster', () => {
    expect(ADMIN_TARGET_PERSONA.balanceNanoUsd < 0n).toBe(true);
    expect(DEV_PERSONAS.map((persona) => persona.name)).not.toContain(ADMIN_TARGET_PERSONA.name);
  });
});
