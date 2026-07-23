import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

interface LifecycleCallbacks {
  onResume?: () => void;
  onPause?: () => void;
}

const { mockCheckForUpdate, mockApplyUpdate, mockIsNative } = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn(),
  mockApplyUpdate: vi.fn(),
  mockIsNative: vi.fn(() => false),
}));

vi.mock('../live-update.js', () => ({
  checkForUpdate: mockCheckForUpdate,
  applyUpdate: mockApplyUpdate,
}));

vi.mock('../platform.js', () => ({
  isNative: mockIsNative,
}));

let capturedCallbacks: LifecycleCallbacks | undefined;
vi.mock('./use-app-lifecycle.js', () => ({
  useAppLifecycle: vi.fn((callbacks?: LifecycleCallbacks) => {
    capturedCallbacks = callbacks;
  }),
}));

import { useAppVersionStore } from '@/stores/app-version';
import { useLiveUpdate } from './use-live-update';

describe('useLiveUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = undefined;
    useAppVersionStore.setState({ upgradeRequired: false });
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
  });

  it('does not check for updates on web', () => {
    mockIsNative.mockReturnValue(false);

    renderHook(() => {
      useLiveUpdate();
    });

    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it('checks for updates on mount when native', async () => {
    mockIsNative.mockReturnValue(true);

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('surfaces the upgrade modal on mount when an update is available, without applying', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
    });
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('leaves upgradeRequired untouched on mount when no update is available', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('registers app lifecycle listener with onResume', async () => {
    const { useAppLifecycle } = vi.mocked(await import('./use-app-lifecycle.js'));

    renderHook(() => {
      useLiveUpdate();
    });

    expect(useAppLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ onResume: expect.any(Function) })
    );
  });

  it('checks for update on resume when native', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    mockCheckForUpdate.mockClear();

    capturedCallbacks?.onResume?.();

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('surfaces the upgrade modal on resume when an update is available', async () => {
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });

    renderHook(() => {
      useLiveUpdate();
    });

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    mockCheckForUpdate.mockClear();
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v3' });

    capturedCallbacks?.onResume?.();

    await vi.waitFor(() => {
      expect(useAppVersionStore.getState().upgradeRequired).toBe(true);
    });
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('does not check for updates on resume when web', () => {
    mockIsNative.mockReturnValue(false);

    renderHook(() => {
      useLiveUpdate();
    });

    capturedCallbacks?.onResume?.();

    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });
});
