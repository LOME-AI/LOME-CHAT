import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { defineSliceManifest, routeClass } from './pipeline-manifest.js';
import type { AppEnv, SliceRouteManifest } from './pipeline-manifest.js';

function fixtureRoutes(): Hono<AppEnv> {
  return new Hono<AppEnv>().get('/greeting', routeClass('public'), (c) =>
    c.json({ greeting: 'hello' })
  );
}

describe('defineSliceManifest', () => {
  it('returns the manifest entry unchanged, satisfying the contract type', () => {
    const routes = fixtureRoutes();
    const manifest: SliceRouteManifest = defineSliceManifest({ basePath: '/fixture', routes });
    expect(manifest.basePath).toBe('/fixture');
    expect(manifest.routes).toBe(routes);
  });

  it('rejects a basePath without a leading slash', () => {
    expect(() =>
      defineSliceManifest({ basePath: 'fixture' as `/${string}`, routes: fixtureRoutes() })
    ).toThrow(/basePath/);
  });

  it('rejects a bare-root basePath', () => {
    expect(() => defineSliceManifest({ basePath: '/', routes: fixtureRoutes() })).toThrow(
      /basePath/
    );
  });

  it('rejects a basePath with a trailing slash', () => {
    expect(() => defineSliceManifest({ basePath: '/fixture/', routes: fixtureRoutes() })).toThrow(
      /basePath/
    );
  });
});
