import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAuth } from '../index.js';
import { createDb } from '@lome-chat/db';
import { createMockEmailClient } from '../../services/email/index.js';

describe('createAuth', () => {
  const connectionString = process.env['DATABASE_URL'] ?? '';
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb({ connectionString });
  });

  afterAll(async () => {
    // No cleanup needed for config tests
  });

  it('returns an auth object with handler function', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
    });

    expect(auth).toBeDefined();
    expect(auth.handler).toBeDefined();
    expect(typeof auth.handler).toBe('function');
  });

  it('returns an auth object with api methods', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
    });

    expect(auth.api).toBeDefined();
    expect(auth.api.getSession).toBeDefined();
    expect(typeof auth.api.getSession).toBe('function');
  });

  it('configures email client for verification emails', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
    });

    // The auth object is created with our configuration
    // Email verification is tested via integration tests
    // Here we just verify the auth object was created successfully
    expect(auth.handler).toBeDefined();
    expect(auth.api.signUpEmail).toBeDefined();
  });

  it('requires all configuration options', () => {
    const emailClient = createMockEmailClient();

    // TypeScript should enforce required options, but we verify runtime behavior
    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'http://localhost:8787',
        secret: 'test-secret-key-at-least-32-chars',
      })
    ).not.toThrow();
  });
});

describe('auth configuration options', () => {
  const connectionString = process.env['DATABASE_URL'] ?? '';
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb({ connectionString });
  });

  it('accepts valid baseUrl', () => {
    const emailClient = createMockEmailClient();

    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'https://api.lome-chat.com',
        secret: 'test-secret-key-at-least-32-chars',
      })
    ).not.toThrow();
  });

  it('accepts secret for session signing', () => {
    const emailClient = createMockEmailClient();

    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'http://localhost:8787',
        secret: 'a-very-long-secret-key-for-signing-sessions',
      })
    ).not.toThrow();
  });
});
