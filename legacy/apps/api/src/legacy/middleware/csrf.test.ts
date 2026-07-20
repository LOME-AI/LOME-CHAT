import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { csrfProtection } from './csrf.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface TestEnv {
  Bindings: {
    FRONTEND_URL: string;
  };
}

describe('csrfProtection middleware', () => {
  function createApp(frontendUrl: string): Hono<TestEnv> {
    const app = new Hono<TestEnv>();

    app.use('*', async (c, next) => {
      c.env = { FRONTEND_URL: frontendUrl };
      await next();
    });

    app.use('*', csrfProtection());

    app.get('/test', (c) => c.json({ success: true }));
    app.post('/test', (c) => c.json({ success: true }));
    app.put('/test', (c) => c.json({ success: true }));
    app.delete('/test', (c) => c.json({ success: true }));
    app.patch('/test', (c) => c.json({ success: true }));

    return app;
  }

  describe('GET requests', () => {
    it('allows GET requests without Origin header', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'GET',
      });

      expect(res.status).toBe(200);
    });

    it('allows GET requests with any Origin header', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'GET',
        headers: {
          Origin: 'http://malicious-site.com',
        },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('POST requests', () => {
    it('allows POST without Origin header (same-origin)', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'POST',
      });

      expect(res.status).toBe(200);
    });

    it('allows POST with matching Origin header', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects POST with mismatched Origin header', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://malicious-site.com',
        },
      });

      expect(res.status).toBe(403);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('CSRF_REJECTED');
    });
  });

  describe('PUT requests', () => {
    it('allows PUT with matching Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'PUT',
        headers: {
          Origin: 'https://hushbox.ai',
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects PUT with mismatched Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'PUT',
        headers: {
          Origin: 'https://attacker.com',
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE requests', () => {
    it('allows DELETE with matching Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'DELETE',
        headers: {
          Origin: 'https://hushbox.ai',
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects DELETE with mismatched Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'DELETE',
        headers: {
          Origin: 'https://attacker.com',
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH requests', () => {
    it('allows PATCH with matching Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'PATCH',
        headers: {
          Origin: 'https://hushbox.ai',
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects PATCH with mismatched Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'PATCH',
        headers: {
          Origin: 'https://attacker.com',
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('production URL handling', () => {
    it('correctly validates production URLs', async () => {
      const app = createApp('https://app.hushbox.ai');

      const validRes = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'https://app.hushbox.ai',
        },
      });
      expect(validRes.status).toBe(200);

      const invalidRes = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'https://hushbox.ai', // Different subdomain
        },
      });
      expect(invalidRes.status).toBe(403);
    });
  });

  describe('missing FRONTEND_URL', () => {
    it('rejects cross-origin requests when FRONTEND_URL is not configured', async () => {
      // Create app without FRONTEND_URL (omit property to test missing case)
      const app = new Hono<{ Bindings: { FRONTEND_URL?: string } }>();

      app.use('*', async (c, next) => {
        c.env = {};
        await next();
      });

      app.use('*', csrfProtection());
      app.post('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://some-origin.com',
        },
      });

      expect(res.status).toBe(403);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('CSRF_REJECTED');
    });
  });

  describe('URL normalization', () => {
    it('allows POST when FRONTEND_URL has trailing slash but Origin does not', async () => {
      const app = createApp('http://localhost:5173/');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(200);
    });

    it('allows POST when Origin has trailing slash but FRONTEND_URL does not', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173/',
        },
      });

      expect(res.status).toBe(200);
    });

    it('allows POST when default HTTPS port is explicit in Origin', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'https://hushbox.ai:443',
        },
      });

      expect(res.status).toBe(200);
    });

    it('allows POST when default HTTP port is explicit in Origin', async () => {
      const app = createApp('http://localhost');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:80',
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects POST when non-default ports differ', async () => {
      const app = createApp('http://localhost:3000');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3001',
        },
      });

      expect(res.status).toBe(403);
    });

    it('rejects POST when Origin is an invalid URL', async () => {
      const app = createApp('http://localhost:5173');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'not-a-valid-url',
        },
      });

      expect(res.status).toBe(403);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('CSRF_REJECTED');
    });

    it('rejects POST when FRONTEND_URL is an invalid URL', async () => {
      const app = createApp('not-a-valid-url');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
        },
      });

      expect(res.status).toBe(403);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe('CSRF_REJECTED');
    });
  });

  describe('Capacitor native origins', () => {
    it('allows POST from capacitor://localhost', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'capacitor://localhost',
        },
      });

      expect(res.status).toBe(200);
    });

    it('allows POST from http://localhost (Android WebView)', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost',
        },
      });

      expect(res.status).toBe(200);
    });

    it('allows DELETE from capacitor://localhost', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'DELETE',
        headers: {
          Origin: 'capacitor://localhost',
        },
      });

      expect(res.status).toBe(200);
    });

    it('still rejects other unknown origins', async () => {
      const app = createApp('https://hushbox.ai');

      const res = await app.request('/test', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:9999',
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe('preview origin', () => {
    it('allows POST from FRONTEND_PREVIEW_URL', async () => {
      const app = new Hono<{
        Bindings: { FRONTEND_URL: string; FRONTEND_PREVIEW_URL: string };
      }>();
      app.use('*', async (c, next) => {
        c.env = {
          FRONTEND_URL: 'http://localhost:5173',
          FRONTEND_PREVIEW_URL: 'http://localhost:4173',
        };
        await next();
      });
      app.use('*', csrfProtection());
      app.post('/test', (c) => c.json({ success: true }));

      const res = await app.request('/test', {
        method: 'POST',
        headers: { Origin: 'http://localhost:4173' },
      });

      expect(res.status).toBe(200);
    });
  });
});
