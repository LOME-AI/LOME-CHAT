import { describe, it, expect, vi } from 'vitest';

// router.ts is pure composition glue: it wires the generated route tree and the
// shared query client into createRouter. Mock the three inputs so the test
// asserts the wiring without booting the whole route tree.
const { createRouterMock } = vi.hoisted(() => ({
  createRouterMock: vi.fn((options: unknown) => ({ __router: true, options })),
}));

vi.mock('@tanstack/react-router', () => ({
  createRouter: createRouterMock,
}));
vi.mock('./routeTree.gen', () => ({ routeTree: { __routeTree: true } }));
vi.mock('./providers/query-provider', () => ({ queryClient: { __queryClient: true } }));

describe('router', () => {
  it('builds the router from the generated route tree and shared query client', async () => {
    const { router } = await import('./router');

    expect(createRouterMock).toHaveBeenCalledTimes(1);
    const options = createRouterMock.mock.calls[0]![0] as {
      routeTree: unknown;
      context: { queryClient: unknown };
    };
    expect(options.routeTree).toEqual({ __routeTree: true });
    expect(options.context).toEqual({ queryClient: { __queryClient: true } });
    expect(router).toBeDefined();
  });
});
