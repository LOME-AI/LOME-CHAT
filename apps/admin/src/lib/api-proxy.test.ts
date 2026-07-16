import { describe, it, expect } from 'vitest';
import { stripApiPrefix } from './api-proxy.js';

describe('stripApiPrefix', () => {
  it('strips the leading /api segment so the Worker sees its root-mounted paths', () => {
    expect(stripApiPrefix('/api/admin/dashboard')).toBe('/admin/dashboard');
  });

  it('strips /api from the dev token mint path', () => {
    expect(stripApiPrefix('/api/dev/admin-token?email=admin%40hushbox.test')).toBe(
      '/dev/admin-token?email=admin%40hushbox.test'
    );
  });

  it('only strips a leading prefix, never an interior /api segment', () => {
    expect(stripApiPrefix('/admin/api/thing')).toBe('/admin/api/thing');
  });
});
