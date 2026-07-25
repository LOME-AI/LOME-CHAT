import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRenderBundle, writeRenderBundle, RENDER_BUNDLE_PATH } from './build-bundle.js';

describe('renderer bundle', () => {
  it('produces a classic-script IIFE (not an ES module)', async () => {
    const bundle = await buildRenderBundle();
    // The page loads the renderer as a classic script, which runs immediately
    // and pulls nothing over the network; esbuild's iife format wraps everything
    // in a self-invoking function with no top-level import/export.
    expect(bundle.startsWith('"use strict";(()=>')).toBe(true);
    expect(bundle.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps the committed public/render.js in sync with the source', async () => {
    const fresh = await buildRenderBundle();
    const committed = readFileSync(RENDER_BUNDLE_PATH, 'utf8');
    expect(committed).toBe(fresh);
  }, 30_000);

  it('writeRenderBundle rewrites the committed bundle from source', async () => {
    await writeRenderBundle();
    expect(readFileSync(RENDER_BUNDLE_PATH, 'utf8')).toBe(await buildRenderBundle());
  }, 30_000);

  // The sandbox origin is credential-free by design — nothing to steal. The bundle
  // must never embed the backend env-config registry: its production var names and
  // its dev-mode secret-shaped values would then be served in the clear from a
  // public origin. This is the guard against the whole-barrel import that inlines it.
  it('embeds no backend env-config registry names, values, or markers', async () => {
    const bundle = await buildRenderBundle();
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
