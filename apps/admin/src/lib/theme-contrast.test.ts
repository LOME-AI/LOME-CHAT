import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * WCAG AA floor for the error text token on the two card surfaces it renders
 * over in this app (negative balances, clawback amounts on cards and page
 * background). Guards the shared theme tokens in
 * packages/config/tailwind/index.css: a token edit that regresses below
 * 4.5:1 for small text fails here, per theme.
 */
function tokensCssPath(): string {
  // Walk up from the test runner's cwd to the workspace root (jsdom rewrites
  // import.meta.url to an http scheme, so path resolution anchors on cwd).
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'packages/config/tailwind/index.css');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('packages/config/tailwind/index.css not found above cwd');
    }
    dir = parent;
  }
}

function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = channels as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** The nth match wins theme selection: 0 = light (`:root`), 1 = dark (`.dark`). */
function tokenValue(css: string, name: string, themeIndex: 0 | 1): string {
  const matches = [...css.matchAll(new RegExp(String.raw`--${name}:\s*(#[0-9a-fA-F]{6})\b`, 'g'))];
  const match = matches[themeIndex];
  if (match?.[1] === undefined) {
    throw new Error(`token --${name} not found for theme index ${String(themeIndex)}`);
  }
  return match[1].toLowerCase();
}

describe('error token contrast (WCAG AA, small text)', () => {
  const css = readFileSync(tokensCssPath(), 'utf8');

  const pairings = [
    {
      theme: 'light',
      error: tokenValue(css, 'error', 0),
      surface: tokenValue(css, 'background-paper', 0),
    },
    {
      theme: 'light',
      error: tokenValue(css, 'error', 0),
      surface: tokenValue(css, 'background', 0),
    },
    {
      theme: 'dark',
      error: tokenValue(css, 'error', 1),
      surface: tokenValue(css, 'background-paper', 1),
    },
    {
      theme: 'dark',
      error: tokenValue(css, 'error', 1),
      surface: tokenValue(css, 'background', 1),
    },
  ] as const;

  it.each(pairings)('$theme --error on $surface meets >= 4.5:1', ({ error, surface }) => {
    expect(contrastRatio(error, surface)).toBeGreaterThanOrEqual(4.5);
  });
});
