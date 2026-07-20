import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAsyncAction, UserMessageError } from './use-async-action';
import { useAsyncActivityStore } from '../stores/async-activity-store';

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}));

describe('useAsyncAction', () => {
  beforeEach(() => {
    toastErrorMock.mockReset();
  });

  describe('initial state', () => {
    it('starts idle with no error', () => {
      const { result } = renderHook(() => useAsyncAction());
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.errorKey).toBe(0);
    });
  });

  describe('run() on success', () => {
    it('returns { ok: true, value } on success', async () => {
      const { result } = renderHook(() => useAsyncAction());
      let returned: unknown;
      await act(async () => {
        returned = await result.current.run(() => Promise.resolve('value'));
      });
      expect(returned).toEqual({ ok: true, value: 'value' });
    });

    it('returns ok:true with undefined value when the action returns undefined', async () => {
      // Discriminator must distinguish "successful return of undefined" from
      // "failure" — otherwise modals can't tell whether to close.
      const { result } = renderHook(() => useAsyncAction());
      let returned: unknown;
      await act(async () => {
        returned = await result.current.run(() => Promise.resolve());
      });
      expect(returned).toEqual({ ok: true, value: undefined });
    });

    it('does not set error on success', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.resolve('ok'));
      });
      expect(result.current.error).toBeNull();
    });
  });

  describe('run() on failure', () => {
    it('resolves with { ok: false } and never re-throws', async () => {
      const { result } = renderHook(() => useAsyncAction());
      let returned: unknown = 'sentinel';
      await act(async () => {
        returned = await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(returned).toEqual({ ok: false });
    });

    it('translates error.message via friendlyErrorMessage', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(result.current.error).toBe('The conversation keys changed. Refresh and try again.');
    });

    it('falls back to a generic message when no known code is on the error', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('TypeError: cannot read x')));
      });
      expect(result.current.error).toBe('Something went wrong. Please try again.');
    });

    it('clears isPending in the finally branch', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(result.current.isPending).toBe(false);
    });

    it('bumps errorKey on each new error so consumers can re-trigger shake', async () => {
      const { result } = renderHook(() => useAsyncAction());

      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      const firstKey = result.current.errorKey;

      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(result.current.errorKey).toBeGreaterThan(firstKey);
    });

    it('surfaces a UserMessageError message verbatim, bypassing translation', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() =>
          Promise.reject(new UserMessageError('Current password is incorrect'))
        );
      });
      expect(result.current.error).toBe('Current password is incorrect');
    });

    it('falls back to INTERNAL when the thrown error carries no usable message', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        // eslint-disable-next-line unicorn/error-message -- deliberately empty to exercise the INTERNAL fallback
        await result.current.run(() => Promise.reject(new Error('')));
      });
      expect(result.current.error).toBe('Something went wrong. Please try again later.');
    });

    it('falls back to INTERNAL when a non-object value is thrown', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising the non-Error throw path
        await result.current.run(() => Promise.reject('bare string'));
      });
      expect(result.current.error).toBe('Something went wrong. Please try again later.');
    });
  });

  describe('setError()', () => {
    it('sets a pre-localized message directly, bypassing translation', () => {
      const { result } = renderHook(() => useAsyncAction());
      act(() => {
        result.current.setError('A ready-made message');
      });
      expect(result.current.error).toBe('A ready-made message');
    });
  });

  describe('clearError()', () => {
    it('resets error to null', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(result.current.error).not.toBeNull();

      act(() => {
        result.current.clearError();
      });
      expect(result.current.error).toBeNull();
    });

    it('does not bump errorKey (only new errors bump)', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      const keyAfterError = result.current.errorKey;

      act(() => {
        result.current.clearError();
      });
      expect(result.current.errorKey).toBe(keyAfterError);
    });
  });

  describe('simulateFailure()', () => {
    it('sets error to friendlyErrorMessage(code) without running an action', () => {
      const { result } = renderHook(() => useAsyncAction());
      act(() => {
        result.current.simulateFailure('STALE_EPOCH');
      });
      expect(result.current.error).toBe('The conversation keys changed. Refresh and try again.');
    });

    it('bumps errorKey so the shake animation re-fires on repeat clicks', () => {
      const { result } = renderHook(() => useAsyncAction());
      act(() => {
        result.current.simulateFailure('STALE_EPOCH');
      });
      const firstKey = result.current.errorKey;
      act(() => {
        result.current.simulateFailure('STALE_EPOCH');
      });
      expect(result.current.errorKey).toBeGreaterThan(firstKey);
    });

    it('does not flip isPending', () => {
      const { result } = renderHook(() => useAsyncAction());
      act(() => {
        result.current.simulateFailure('STALE_EPOCH');
      });
      expect(result.current.isPending).toBe(false);
    });
  });

  describe("fallback: 'toast'", () => {
    it('calls toast.error with the friendly message on failure', async () => {
      const { result } = renderHook(() => useAsyncAction({ fallback: 'toast' }));
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        'The conversation keys changed. Refresh and try again.'
      );
    });

    it("leaves local error null when fallback is 'toast'", async () => {
      const { result } = renderHook(() => useAsyncAction({ fallback: 'toast' }));
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(result.current.error).toBeNull();
    });

    it("uses toast for simulateFailure too when fallback is 'toast'", () => {
      const { result } = renderHook(() => useAsyncAction({ fallback: 'toast' }));
      act(() => {
        result.current.simulateFailure('STALE_EPOCH');
      });
      expect(toastErrorMock).toHaveBeenCalledWith(
        'The conversation keys changed. Refresh and try again.'
      );
      expect(result.current.error).toBeNull();
    });
  });

  describe('global activity tracking (drives useIsSettled)', () => {
    beforeEach(() => {
      useAsyncActivityStore.setState({ activeCount: 0 });
    });

    it('increments and decrements the global active count around a successful run', async () => {
      const { result } = renderHook(() => useAsyncAction());
      expect(useAsyncActivityStore.getState().activeCount).toBe(0);

      let resolveAction: (() => void) | undefined;
      const blocking = new Promise<void>((resolve) => {
        resolveAction = resolve;
      });

      let runPromise: Promise<unknown> | undefined;
      act(() => {
        runPromise = result.current.run(async () => {
          await blocking;
        });
      });

      await waitFor(() => {
        expect(useAsyncActivityStore.getState().activeCount).toBe(1);
      });

      await act(async () => {
        resolveAction!();
        await runPromise;
      });

      expect(useAsyncActivityStore.getState().activeCount).toBe(0);
    });

    it('decrements on failure too so a thrown action does not leak activity', async () => {
      const { result } = renderHook(() => useAsyncAction());
      await act(async () => {
        await result.current.run(() => Promise.reject(new Error('STALE_EPOCH')));
      });
      expect(useAsyncActivityStore.getState().activeCount).toBe(0);
    });

    it('tracks concurrent runs additively', async () => {
      const { result: a } = renderHook(() => useAsyncAction());
      const { result: b } = renderHook(() => useAsyncAction());

      let resolveA: (() => void) | undefined;
      let resolveB: (() => void) | undefined;
      const blockA = new Promise<void>((resolve) => {
        resolveA = resolve;
      });
      const blockB = new Promise<void>((resolve) => {
        resolveB = resolve;
      });

      let aPromise: Promise<unknown> | undefined;
      let bPromise: Promise<unknown> | undefined;
      act(() => {
        aPromise = a.current.run(async () => {
          await blockA;
        });
        bPromise = b.current.run(async () => {
          await blockB;
        });
      });

      await waitFor(() => {
        expect(useAsyncActivityStore.getState().activeCount).toBe(2);
      });

      await act(async () => {
        resolveA!();
        await aPromise;
      });

      expect(useAsyncActivityStore.getState().activeCount).toBe(1);

      await act(async () => {
        resolveB!();
        await bPromise;
      });

      expect(useAsyncActivityStore.getState().activeCount).toBe(0);
    });
  });

  describe('isPending observability', () => {
    it('isPending is true while the action awaits', async () => {
      const { result } = renderHook(() => useAsyncAction());
      let resolveAction: (() => void) | undefined;
      const blocking = new Promise<void>((resolve) => {
        resolveAction = resolve;
      });

      let runPromise: Promise<unknown> | undefined;
      act(() => {
        runPromise = result.current.run(async () => {
          await blocking;
          return 'done';
        });
      });

      await waitFor(() => {
        expect(result.current.isPending).toBe(true);
      });

      await act(async () => {
        resolveAction!();
        await runPromise;
      });

      expect(result.current.isPending).toBe(false);
    });
  });
});
