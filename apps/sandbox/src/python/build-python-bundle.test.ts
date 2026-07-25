import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPythonBundle, writePythonBundle, PYTHON_BUNDLE_PATH } from './build-python-bundle.js';

describe('Python runtime bundle', () => {
  it('produces a classic-script IIFE (not an ES module)', async () => {
    const bundle = await buildPythonBundle();
    expect(bundle.startsWith('"use strict";(()=>')).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps the committed public/python.js in sync with the source', async () => {
    const fresh = await buildPythonBundle();
    const committed = readFileSync(PYTHON_BUNDLE_PATH, 'utf8');
    expect(committed).toBe(fresh);
  }, 30_000);

  it('writePythonBundle rewrites the committed bundle from source', async () => {
    await writePythonBundle();
    expect(readFileSync(PYTHON_BUNDLE_PATH, 'utf8')).toBe(await buildPythonBundle());
  }, 30_000);

  // The sandbox origin is credential-free by design. The bundle must never embed
  // the backend env-config registry: its production var names and dev-mode
  // secret-shaped values would then be served in the clear from a public origin.
  // This guards against the whole-barrel import that inlines it.
  it('embeds no backend env-config registry names, values, or markers', async () => {
    const bundle = await buildPythonBundle();
    const forbidden = [
      'DATABASE_URL',
      'OPAQUE_MASTER_SECRET',
      'CF_ACCESS',
      'ADMIN_SQL_PANEL_DATABASE_URL',
      'VAPID_PRIVATE_KEY',
      'IRON_SESSION_SECRET',
      'to:["backend"]',
    ];
    const present = forbidden.filter((needle) => bundle.includes(needle));
    expect(present).toEqual([]);
  }, 30_000);
});
