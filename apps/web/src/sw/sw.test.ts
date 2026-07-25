import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const alphabetical = (values: readonly string[]): string[] =>
  [...values].toSorted((a, b) => a.localeCompare(b));

describe('service worker entry', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers its push lifecycle listeners against the worker global on load', async () => {
    const addEventListener = vi.spyOn(globalThis, 'addEventListener').mockImplementation(() => {});

    await import('./sw.js');

    const registered = addEventListener.mock.calls.map((call) => call[0]);
    expect(alphabetical(registered)).toEqual([
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
    expect(registered).not.toContain('fetch');
  });
});
