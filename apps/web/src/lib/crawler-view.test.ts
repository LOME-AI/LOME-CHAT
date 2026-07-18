import { describe, it, expect, vi, afterEach } from 'vitest';
import { crawlerViewOrigin } from './crawler-view';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('crawlerViewOrigin', () => {
  it('returns the configured crawler-view origin', () => {
    vi.stubEnv('VITE_CRAWLER_VIEW_URL', 'http://localhost:7200');
    expect(crawlerViewOrigin()).toBe('http://localhost:7200');
  });

  it('fails fast when the origin is unset (a config defect behind the dev-server gate)', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
    vi.stubEnv('VITE_CRAWLER_VIEW_URL', undefined);
    expect(() => crawlerViewOrigin()).toThrow('VITE_CRAWLER_VIEW_URL');
  });
});
