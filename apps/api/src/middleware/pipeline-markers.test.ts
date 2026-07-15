import { describe, it, expect, vi } from 'vitest';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
import {
  routeClass,
  readRouteClass,
  markPipelineHandler,
  isPipelineHandler,
} from './pipeline-markers.js';
import type { RouteClass } from '../lib/context/index.js';
import type { Context, Next } from 'hono';

describe('routeClass', () => {
  it('returns a middleware that passes through to next', async () => {
    const next = vi.fn<Next>(() => Promise.resolve());
    await routeClass('public')({} as Context, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('declares the class readable via readRouteClass', () => {
    expect(readRouteClass(routeClass('pending-2fa'))).toBe('pending-2fa');
  });

  it('throws at registration time for a value outside the closed union', () => {
    expect(() => routeClass('superuser' as RouteClass)).toThrow(/route class/i);
  });
});

describe('readRouteClass', () => {
  it('returns undefined for an unmarked handler', () => {
    expect(readRouteClass(() => {})).toBeUndefined();
  });

  it('returns undefined for a non-function value', () => {
    expect(readRouteClass('not-a-handler')).toBeUndefined();
  });

  it('unwraps a sub-app-composed handler to find the declaration', () => {
    const composed = Object.assign(() => {}, {
      [COMPOSED_HANDLER]: routeClass('session'),
    });
    expect(readRouteClass(composed)).toBe('session');
  });
});

describe('pipeline handler marking', () => {
  it('marks a handler as pipeline-owned', () => {
    const marked = markPipelineHandler(async (_c, next) => next());
    expect(isPipelineHandler(marked)).toBe(true);
  });

  it('does not mark unrelated handlers', () => {
    expect(isPipelineHandler(() => {})).toBe(false);
  });

  it('does not mark non-function values', () => {
    expect(isPipelineHandler(null)).toBe(false);
  });
});
