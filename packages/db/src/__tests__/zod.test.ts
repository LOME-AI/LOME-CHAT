import { describe, expect, it } from 'vitest';

import {
  insertConversationSchema,
  insertMessageSchema,
  insertProjectSchema,
  insertUserSchema,
  selectConversationSchema,
  selectMessageSchema,
  selectProjectSchema,
  selectUserSchema,
} from '../zod/index';

describe('insertUserSchema', () => {
  it('accepts valid user data', () => {
    const result = insertUserSchema.safeParse({
      email: 'test@example.com',
      name: 'Test User',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing email', () => {
    const result = insertUserSchema.safeParse({
      name: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = insertUserSchema.safeParse({
      email: 'test@example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectUserSchema', () => {
  it('accepts complete user data', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: false,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = selectUserSchema.safeParse({
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: false,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

describe('insertConversationSchema', () => {
  it('accepts valid conversation data', () => {
    const result = insertConversationSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Test Conversation',
    });
    expect(result.success).toBe(true);
  });

  it('accepts conversation without title (has default)', () => {
    const result = insertConversationSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing userId', () => {
    const result = insertConversationSchema.safeParse({
      title: 'Test',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectConversationSchema', () => {
  it('accepts complete conversation data', () => {
    const result = selectConversationSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      title: 'Test Conversation',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertMessageSchema', () => {
  it('accepts valid message data', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'user',
      content: 'Hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts message with optional model', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'assistant',
      content: 'Hello back',
      model: 'gpt-4',
    });
    expect(result.success).toBe(true);
  });

  it('accepts all valid roles', () => {
    const roles = ['user', 'assistant', 'system'] as const;
    for (const role of roles) {
      const result = insertMessageSchema.safeParse({
        conversationId: '550e8400-e29b-41d4-a716-446655440000',
        role,
        content: 'Test',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid role', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'invalid',
      content: 'Hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing content', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      role: 'user',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectMessageSchema', () => {
  it('accepts complete message data', () => {
    const result = selectMessageSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      role: 'user',
      content: 'Hello',
      model: null,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertProjectSchema', () => {
  it('accepts valid project data', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test Project',
    });
    expect(result.success).toBe(true);
  });

  it('accepts project with optional description', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test Project',
      description: 'A test project',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectProjectSchema', () => {
  it('accepts complete project data', () => {
    const result = selectProjectSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      name: 'Test Project',
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});
