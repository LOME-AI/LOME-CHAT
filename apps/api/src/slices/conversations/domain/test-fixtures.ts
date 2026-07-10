import { okAsync } from '../../../lib/result/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ConversationRecord, ConversationsStores, MemberRecord } from '../ports/index.js';

/**
 * Fake-store scaffolding for domain unit tests. Only the methods a test
 * overrides exist; any other store call is a test defect and throws with the
 * offending method name. Lives outside *.test.ts so every defect-arm test
 * shares one honest fake instead of six divergent ones.
 */

type StoreOverrides = {
  [K in keyof ConversationsStores]?: Partial<ConversationsStores[K]>;
};

export function fakeStores(overrides: StoreOverrides): ConversationsStores {
  function group<K extends keyof ConversationsStores>(key: K): ConversationsStores[K] {
    const provided: object = overrides[key] ?? {};
    return new Proxy(provided, {
      get: (target, property) => {
        if (property in target) return (target as Record<string | symbol, unknown>)[property];
        throw new Error(`unexpected store call: ${key}.${String(property)}`);
      },
    }) as ConversationsStores[K];
  }
  return {
    conversations: group('conversations'),
    members: group('members'),
    epochs: group('epochs'),
    users: group('users'),
    messages: group('messages'),
    forks: group('forks'),
    sharedLinks: group('sharedLinks'),
    sharedMessages: group('sharedMessages'),
  };
}

export function conversationRecord(
  overrides: Partial<ConversationRecord> = {}
): ConversationRecord {
  return {
    id: 'c1',
    ownerUserId: 'owner',
    title: new Uint8Array(0),
    titleEpochNumber: 1,
    currentEpoch: 1,
    nextSequence: 1,
    conversationBudgetNanoUsd: 0n,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function memberRecord(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: 'm1',
    userId: 'owner',
    privilege: 'owner',
    visibleFromEpoch: 1,
    joinedAt: new Date(0),
    acceptedAt: new Date(0),
    muted: false,
    pinned: false,
    ...overrides,
  };
}

export function userRow(
  id: string,
  publicKey: Uint8Array
): ResultAsync<{ id: string; username: string; publicKey: Uint8Array } | null, DomainError> {
  return okAsync({ id, username: `user-${id}`, publicKey });
}
