import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// Validates the deployed static file served from public/robots.txt.
const ROBOTS_PATH = path.join(import.meta.dirname, '../../public/robots.txt');

function readRobots(): string {
  return readFileSync(ROBOTS_PATH, 'utf8');
}

function directives(prefix: 'Allow' | 'Disallow'): string[] {
  return readRobots()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${prefix}:`))
    .map((line) => line.slice(`${prefix}:`.length).trim());
}

describe('robots.txt', () => {
  it('does not Allow the empty SPA-shell routes /chat, /login, /signup', () => {
    const allows = directives('Allow');
    expect(allows).not.toContain('/chat');
    expect(allows).not.toContain('/login');
    expect(allows).not.toContain('/signup');
  });

  it('disallows the interactive /demo route', () => {
    expect(directives('Disallow')).toContain('/demo');
  });

  it('still allows the public marketing pages', () => {
    const allows = directives('Allow');
    expect(allows).toContain('/terms');
    expect(allows).toContain('/privacy');
    expect(allows).toContain('/blog');
  });
});
