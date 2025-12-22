import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../../client';
import { users, conversations, messages, projects } from '../../schema/index';
import { userFactory, projectFactory, conversationFactory, messageFactory } from '../index';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:4444/lome_chat';

describe('userFactory', () => {
  it('builds a complete user object', () => {
    const user = userFactory.build();

    expect(user.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(user.email).toContain('@');
    expect(user.name).toBeTruthy();
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const user = userFactory.build({ name: 'Custom Name' });
    expect(user.name).toBe('Custom Name');
  });

  it('builds a list with unique IDs', () => {
    const userList = userFactory.buildList(3);
    expect(userList).toHaveLength(3);
    const ids = new Set(userList.map((u) => u.id));
    expect(ids.size).toBe(3);
  });
});

describe('projectFactory', () => {
  it('builds a complete project object', () => {
    const project = projectFactory.build();

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.name).toBeTruthy();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const project = projectFactory.build({ name: 'Custom Project' });
    expect(project.name).toBe('Custom Project');
  });

  it('builds a list with unique IDs', () => {
    const projectList = projectFactory.buildList(3);
    expect(projectList).toHaveLength(3);
    const ids = new Set(projectList.map((p) => p.id));
    expect(ids.size).toBe(3);
  });
});

describe('conversationFactory', () => {
  it('builds a complete conversation object', () => {
    const conversation = conversationFactory.build();

    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.title).toBeTruthy();
    expect(conversation.createdAt).toBeInstanceOf(Date);
    expect(conversation.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const conversation = conversationFactory.build({ title: 'Custom Title' });
    expect(conversation.title).toBe('Custom Title');
  });

  it('builds a list with unique IDs', () => {
    const conversationList = conversationFactory.buildList(3);
    expect(conversationList).toHaveLength(3);
    const ids = new Set(conversationList.map((c) => c.id));
    expect(ids.size).toBe(3);
  });
});

describe('messageFactory', () => {
  it('builds a complete message object', () => {
    const message = messageFactory.build();

    expect(message.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(message.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(['user', 'assistant', 'system']).toContain(message.role);
    expect(message.content).toBeTruthy();
    expect(message.createdAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const message = messageFactory.build({ role: 'system', content: 'Custom content' });
    expect(message.role).toBe('system');
    expect(message.content).toBe('Custom content');
  });

  it('builds a list with unique IDs', () => {
    const messageList = messageFactory.buildList(3);
    expect(messageList).toHaveLength(3);
    const ids = new Set(messageList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });
});

describe('factory integration', () => {
  let db: Database;
  const createdUserIds: string[] = [];
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];
  const createdProjectIds: string[] = [];

  beforeAll(() => {
    db = createDb({
      connectionString: DATABASE_URL,
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  afterAll(async () => {
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (createdProjectIds.length > 0) {
      await db.delete(projects).where(inArray(projects.id, createdProjectIds));
    }
    if (createdUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, createdUserIds));
    }
  });

  it('inserts factory-built records with proper relationships', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning();
    if (user === undefined) {
      throw new Error('User insert failed - no record returned');
    }
    createdUserIds.push(user.id);

    const [conv] = await db
      .insert(conversations)
      .values(conversationFactory.build({ userId: user.id }))
      .returning();
    if (conv === undefined) {
      throw new Error('Conversation insert failed - no record returned');
    }
    createdConversationIds.push(conv.id);

    const [msg] = await db
      .insert(messages)
      .values(messageFactory.build({ conversationId: conv.id }))
      .returning();
    if (msg === undefined) {
      throw new Error('Message insert failed - no record returned');
    }
    createdMessageIds.push(msg.id);

    const [proj] = await db
      .insert(projects)
      .values(projectFactory.build({ userId: user.id }))
      .returning();
    if (proj === undefined) {
      throw new Error('Project insert failed - no record returned');
    }
    createdProjectIds.push(proj.id);

    expect(conv.userId).toBe(user.id);
    expect(msg.conversationId).toBe(conv.id);
    expect(proj.userId).toBe(user.id);
  });

  it('fails to insert with non-existent FK (safety net)', async () => {
    const conv = conversationFactory.build();
    await expect(db.insert(conversations).values(conv)).rejects.toThrow();
  });
});
