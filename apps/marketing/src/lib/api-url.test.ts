import { describe, it, expect, vi, afterEach } from 'vitest';
import { getApiUrl } from './api-url';

describe('getApiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns VITE_API_URL when set', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    expect(getApiUrl()).toBe('https://api.example.test');
  });

  it('throws a clear error when VITE_API_URL is empty', () => {
    vi.stubEnv('VITE_API_URL', '');
    expect(() => getApiUrl()).toThrow(/VITE_API_URL is required/);
  });
});
