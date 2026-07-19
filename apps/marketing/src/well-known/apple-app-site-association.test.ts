import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Validates the deployed asset served from public/.well-known/.
const AASA_PATH = path.join(
  import.meta.dirname,
  '../../public/.well-known/apple-app-site-association'
);

interface AASADetail {
  appIDs: string[];
  components: { '/': string }[];
}

interface AASA {
  applinks: {
    details: AASADetail[];
  };
}

function readAASA(): AASA {
  const content = readFileSync(AASA_PATH, 'utf8');
  return JSON.parse(content) as AASA;
}

describe('apple-app-site-association', () => {
  it('is valid JSON', () => {
    expect(() => readAASA()).not.toThrow();
  });

  it('has applinks.details array', () => {
    const aasa = readAASA();
    expect(aasa.applinks).toBeDefined();
    expect(aasa.applinks.details).toBeInstanceOf(Array);
    expect(aasa.applinks.details).toHaveLength(1);
  });

  it('has an appID with the correct bundle identifier', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    expect(detail.appIDs).toHaveLength(1);
    expect(detail.appIDs[0]).toMatch(/\.ai\.hushbox\.app$/);
  });

  it('includes /chat/* path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/chat/*');
  });

  it('includes /billing path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/billing');
  });

  it('includes /settings path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/settings');
  });

  it('does not include token-sensitive /login or /signup (excluded from the deep-link allowlist)', () => {
    // The native deep-link allowlist (use-deep-links.ts) deliberately excludes
    // /login and /signup so an attacker-supplied universal link cannot drive
    // navigation with query tokens. AASA must not register them either, or the
    // link opens the app and then bounces to `/` — a UX dead-end.
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).not.toContain('/login');
    expect(paths).not.toContain('/signup');
  });

  it('does not include /privacy or /terms (legal pages open in browser)', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).not.toContain('/privacy');
    expect(paths).not.toContain('/terms');
  });
});
