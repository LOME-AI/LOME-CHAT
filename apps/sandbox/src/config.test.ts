import { describe, it, expect } from 'vitest';
import { buildSandboxConfigScript, SANDBOX_CONFIG_GLOBAL } from './config.js';

describe('buildSandboxConfigScript', () => {
  it('assigns the resolved config to the agreed global', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://esm.sh' });
    expect(script.startsWith(`globalThis[${JSON.stringify(SANDBOX_CONFIG_GLOBAL)}] = `)).toBe(true);
  });

  it('carries the esm CDN base URL through', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://esm.sh' });
    const json = script.slice(script.indexOf('= ') + 2, script.lastIndexOf(';'));
    expect(JSON.parse(json)).toEqual({ esmCdnUrl: 'https://esm.sh' });
  });

  it('preserves a stub CDN URL pointing back at the sandbox origin', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'http://localhost:7400/esm-stub' });
    const json = script.slice(script.indexOf('= ') + 2, script.lastIndexOf(';'));
    expect(JSON.parse(json)).toEqual({ esmCdnUrl: 'http://localhost:7400/esm-stub' });
  });

  it('JSON-encodes the value so a hostile URL cannot break out of the script', () => {
    const script = buildSandboxConfigScript({ ESM_CDN_URL: 'https://x</script>y' });
    expect(script).not.toContain('</script>');
  });

  it('fails fast when ESM_CDN_URL is absent (no silent fallback)', () => {
    expect(() => buildSandboxConfigScript({})).toThrow(/ESM_CDN_URL/);
  });

  it('fails fast when ESM_CDN_URL is an empty string', () => {
    expect(() => buildSandboxConfigScript({ ESM_CDN_URL: '' })).toThrow(/ESM_CDN_URL/);
  });
});
