import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cors } from './cors.js';

describe('cors middleware', () => {
  describe('without FRONTEND_URL', () => {
    it('rejects all non-Capacitor origins when no URLs configured', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Origin: 'http://localhost:5173' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('rejects requests from disallowed origins', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Origin: 'http://evil.com' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('with FRONTEND_URL (development)', () => {
    it('allows requests from FRONTEND_URL', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        { headers: { Origin: 'http://localhost:5173' } },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('handles preflight OPTIONS requests', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:5173',
            'Access-Control-Request-Method': 'POST',
          },
        },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });
  });

  describe('with FRONTEND_URL (production)', () => {
    it('allows requests from production origin', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'https://hushbox.ai' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://hushbox.ai');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('rejects localhost when only production FRONTEND_URL is set', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'http://localhost:5173' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('handles preflight OPTIONS for production origin', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://hushbox.ai',
            'Access-Control-Request-Method': 'POST',
          },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://hushbox.ai');
    });

    it('rejects requests from disallowed origins in production', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'http://evil.com' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('with FRONTEND_PREVIEW_URL', () => {
    it('allows requests from preview origin', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string; FRONTEND_PREVIEW_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        { headers: { Origin: 'http://localhost:4173' } },
        { FRONTEND_URL: 'http://localhost:5173', FRONTEND_PREVIEW_URL: 'http://localhost:4173' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4173');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });
  });

  describe('public namespace (/api/public/*)', () => {
    // The /api/public/* prefix is the documented home for unauthenticated,
    // CDN-cached endpoints (currently just /api/public/roadmap). Wildcard CORS
    // without credentials is the correct policy: any origin can fetch, no
    // cookies are ever sent, so there is no cross-origin authentication risk.
    it('allows any origin under /api/public/', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/api/public/anything', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/api/public/anything',
        { headers: { Origin: 'http://localhost:4321' } },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('omits Allow-Credentials under /api/public/ (wildcard requires no credentials)', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/api/public/roadmap', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/api/public/roadmap',
        { headers: { Origin: 'https://anyone.example' } },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('handles preflight OPTIONS under /api/public/', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/api/public/roadmap', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/api/public/roadmap',
        {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost:4321',
            'Access-Control-Request-Method': 'GET',
          },
        },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('does not relax CORS for non-public routes', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/api/conversations', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/api/conversations',
        { headers: { Origin: 'http://localhost:4321' } },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });

  describe('Capacitor native origins', () => {
    it('allows requests from capacitor://localhost', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'capacitor://localhost' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('allows requests from http://localhost (Android WebView)', async () => {
      const app = new Hono<{ Bindings: { FRONTEND_URL: string } }>();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request(
        '/test',
        {
          headers: { Origin: 'http://localhost' },
        },
        { FRONTEND_URL: 'https://hushbox.ai' }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('allows Capacitor origins in development too', async () => {
      const app = new Hono();
      app.use('*', cors());
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Origin: 'capacitor://localhost' },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
    });
  });
});
