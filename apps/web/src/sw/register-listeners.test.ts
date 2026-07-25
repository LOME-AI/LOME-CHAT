import { describe, it, expect, vi } from 'vitest';
import { registerServiceWorkerListeners } from './register-listeners.js';
import type { ServiceWorkerScope } from './handlers.js';

type Listener = (event: unknown) => void;

const alphabetical = (values: readonly string[]): string[] =>
  [...values].toSorted((a, b) => a.localeCompare(b));

function makeScope(): { scope: ServiceWorkerScope; listeners: Map<string, Listener> } {
  const listeners = new Map<string, Listener>();
  const scope = {
    clients: {
      matchAll: vi.fn(() => Promise.resolve([])),
      openWindow: vi.fn(() => Promise.resolve()),
    },
    registration: {
      showNotification: vi.fn(() => Promise.resolve()),
      pushManager: { subscribe: vi.fn(() => Promise.resolve({ toJSON: () => ({}) })) },
    },
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, listener);
    }),
  } as unknown as ServiceWorkerScope;
  return { scope, listeners };
}

describe('registerServiceWorkerListeners', () => {
  it('registers the three push lifecycle listeners', () => {
    const { scope, listeners } = makeScope();
    registerServiceWorkerListeners(scope);
    expect(alphabetical([...listeners.keys()])).toEqual([
      'notificationclick',
      'push',
      'pushsubscriptionchange',
    ]);
  });

  it('never registers a fetch listener — the worker does push only, never serving', () => {
    const { scope, listeners } = makeScope();
    registerServiceWorkerListeners(scope);
    expect(listeners.has('fetch')).toBe(false);
  });

  it('wires each listener through waitUntil so the browser keeps the worker alive', () => {
    const { scope, listeners } = makeScope();
    registerServiceWorkerListeners(scope);

    const pushEvent = { waitUntil: vi.fn(), data: null };
    listeners.get('push')!(pushEvent);
    expect(pushEvent.waitUntil).toHaveBeenCalledOnce();

    const clickEvent = { waitUntil: vi.fn(), notification: { data: null, close: vi.fn() } };
    listeners.get('notificationclick')!(clickEvent);
    expect(clickEvent.waitUntil).toHaveBeenCalledOnce();

    const changeEvent = { waitUntil: vi.fn(), oldSubscription: null };
    listeners.get('pushsubscriptionchange')!(changeEvent);
    expect(changeEvent.waitUntil).toHaveBeenCalledOnce();
  });
});
