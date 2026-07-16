import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DEV_ADMIN_ACTORS,
  getDevActor,
  setDevActor,
  subscribeDevActor,
  useDevActor,
} from './dev-actor.js';

afterEach(() => {
  setDevActor(DEV_ADMIN_ACTORS[0]);
});

describe('dev actor store', () => {
  it('exposes exactly the two allowlisted dev actors', () => {
    expect(DEV_ADMIN_ACTORS).toEqual(['admin@hushbox.test', 'ops@hushbox.test']);
  });

  it('defaults to the first allowlisted actor', () => {
    expect(getDevActor()).toBe('admin@hushbox.test');
  });

  it('switches the current actor', () => {
    setDevActor('ops@hushbox.test');
    expect(getDevActor()).toBe('ops@hushbox.test');
  });

  it('notifies subscribers on actor change', () => {
    let calls = 0;
    const unsubscribe = subscribeDevActor(() => {
      calls += 1;
    });
    setDevActor('ops@hushbox.test');
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('does not notify when setting the same actor', () => {
    let calls = 0;
    const unsubscribe = subscribeDevActor(() => {
      calls += 1;
    });
    setDevActor(getDevActor());
    expect(calls).toBe(0);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeDevActor(() => {
      calls += 1;
    });
    unsubscribe();
    setDevActor('ops@hushbox.test');
    expect(calls).toBe(0);
  });

  it('useDevActor reflects the current actor reactively', () => {
    const { result } = renderHook(() => useDevActor());
    expect(result.current).toBe('admin@hushbox.test');
    act(() => {
      setDevActor('ops@hushbox.test');
    });
    expect(result.current).toBe('ops@hushbox.test');
  });
});
