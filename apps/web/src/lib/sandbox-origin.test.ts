import { describe, it, expect, vi, afterEach } from 'vitest';
import { sandboxOrigin, sandboxPageUrl } from './sandbox-origin';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sandboxOrigin', () => {
  it('returns the configured sandbox origin', () => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'http://localhost:7400');
    expect(sandboxOrigin()).toBe('http://localhost:7400');
  });

  it('fails fast when the origin is unset (a config defect — every mode defines it)', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', undefined);
    expect(() => sandboxOrigin()).toThrow('VITE_SANDBOX_ORIGIN_URL');
  });
});

describe('sandboxPageUrl', () => {
  it('points html at the web renderer page', () => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'https://sandbox.hushbox.ai');
    expect(sandboxPageUrl('html')).toBe('https://sandbox.hushbox.ai/render.html');
  });

  it('points js at the web renderer page', () => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'https://sandbox.hushbox.ai');
    expect(sandboxPageUrl('js')).toBe('https://sandbox.hushbox.ai/render.html');
  });

  it('points react at the web renderer page', () => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'https://sandbox.hushbox.ai');
    expect(sandboxPageUrl('react')).toBe('https://sandbox.hushbox.ai/render.html');
  });

  it('points python at the Pyodide runtime page', () => {
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'https://sandbox.hushbox.ai');
    expect(sandboxPageUrl('python')).toBe('https://sandbox.hushbox.ai/python.html');
  });
});
