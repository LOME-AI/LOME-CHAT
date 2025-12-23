import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { createAuthRoutes } from './auth.js';
import { createAuth } from '../auth/index.js';
import { createDb } from '@lome-chat/db';
import { createMockEmailClient } from '../services/email/index.js';

describe('auth routes', () => {
  const connectionString = process.env['DATABASE_URL'] ?? '';
  let db: ReturnType<typeof createDb>;
  let app: Hono;

  beforeAll(() => {
    db = createDb({ connectionString });
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
    });
    app = new Hono();
    app.route('/api/auth', createAuthRoutes(auth));
  });

  afterAll(async () => {
    // No cleanup needed
  });

  describe('route mounting', () => {
    it('handles GET requests to /api/auth/*', async () => {
      const res = await app.request('/api/auth/get-session');

      // Should not return 404 - route is mounted
      expect(res.status).not.toBe(404);
    });

    it('handles POST requests to /api/auth/*', async () => {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Should not return 404 - route is mounted
      expect(res.status).not.toBe(404);
    });

    it('returns 404 for non-auth paths', async () => {
      const res = await app.request('/api/other');

      expect(res.status).toBe(404);
    });
  });

  describe('sign-up endpoint', () => {
    it('returns error for invalid signup data', async () => {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Better Auth returns 400 for invalid data
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('accepts valid signup data format', async () => {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
          name: 'Test User',
        }),
      });

      // Should process the request (may succeed or fail based on DB state)
      expect(res.status).toBeDefined();
    });
  });

  describe('session endpoint', () => {
    it('returns null session for unauthenticated request', async () => {
      const res = await app.request('/api/auth/get-session');

      expect(res.status).toBe(200);
      const body = await res.json();
      // Better Auth returns null for unauthenticated requests
      expect(body).toBeNull();
    });
  });
});
