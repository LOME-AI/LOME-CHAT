import { describe, it, expect } from 'vitest';

// Pure-IO CLI wiring: the readiness logic is tested in
// lib/minio-bucket-ready-docker.test.ts and lib/minio-bucket-ready.test.ts.
// This smoke test only pins that the entry module loads cleanly (ESM `.js`
// resolution, no top-level throw) without running its main guard — importing
// it under Vitest never matches `isMainModule`, so no docker command fires.
describe('db-bucket-ready entry', () => {
  it('imports without executing its CLI main', async () => {
    const entryModule = await import('./db-bucket-ready.js');
    expect(entryModule).toBeDefined();
  });
});
