import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { securityHeaders } from './security.js';

describe('securityHeaders middleware', () => {
  function createApp(): Hono {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/test', (c) => c.json({ success: true }));
    app.post('/test', (c) => c.json({ success: true }));
    return app;
  }

  describe('Content-Security-Policy', () => {
    it('sets CSP header on GET response', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBeDefined();
    });

    it('includes default-src self directive', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("default-src 'self'");
    });

    it('includes script-src self directive', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src 'self'");
    });

    it('includes style-src with unsafe-inline for Tailwind', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    });

    it('includes img-src with data and blob for images', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("img-src 'self' data: blob:");
    });

    it('includes connect-src self directive', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("connect-src 'self'");
    });

    it('includes frame-ancestors none to prevent clickjacking', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('includes base-uri self directive', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("base-uri 'self'");
    });

    it('includes form-action self directive', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toContain("form-action 'self'");
    });
  });

  describe('X-Content-Type-Options', () => {
    it('sets nosniff header', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });
  });

  describe('X-Frame-Options', () => {
    it('sets DENY header', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });

  describe('Referrer-Policy', () => {
    it('sets no-referrer to prevent share link URL leakage', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'GET' });

      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });
  });

  describe('headers on different methods', () => {
    it('sets security headers on POST responses', async () => {
      const app = createApp();

      const res = await app.request('/test', { method: 'POST' });

      expect(res.headers.get('Content-Security-Policy')).toBeDefined();
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
