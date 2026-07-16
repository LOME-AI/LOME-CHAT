import { describe, it, expect } from 'vitest';
import { router } from './router.js';
import { queryClient } from './providers/query-provider.js';

describe('router', () => {
  it('is constructed from the generated route tree', () => {
    expect(router.routeTree).toBeDefined();
  });

  it('carries the shared query client in context', () => {
    expect(router.options.context).toEqual({ queryClient });
  });
});
