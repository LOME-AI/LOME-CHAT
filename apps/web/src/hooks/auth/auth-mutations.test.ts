import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { useChangePassword } from '@/hooks/auth/auth-mutations';

vi.mock('@/lib/auth', () => ({
  changePassword: vi.fn(),
}));

import { changePassword } from '@/lib/auth';

const mockChangePassword = vi.mocked(changePassword);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useChangePassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to changePassword with current and new password', async () => {
    mockChangePassword.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useChangePassword(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ currentPassword: 'oldpass', newPassword: 'newpass' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockChangePassword).toHaveBeenCalledWith('oldpass', 'newpass');
  });

  it('rejects when changePassword returns success=false so the mutation reports error', async () => {
    mockChangePassword.mockResolvedValueOnce({ success: false, error: 'INVALID_CREDENTIALS' });

    const { result } = renderHook(() => useChangePassword(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ currentPassword: 'wrong', newPassword: 'newpass' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('INVALID_CREDENTIALS');
  });

  it('falls back to CHANGE_PASSWORD_FAILED when success=false carries no error', async () => {
    mockChangePassword.mockResolvedValueOnce({ success: false });

    const { result } = renderHook(() => useChangePassword(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ currentPassword: 'wrong', newPassword: 'newpass' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('CHANGE_PASSWORD_FAILED');
  });

  it('exposes the success result data to consumers', async () => {
    mockChangePassword.mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useChangePassword(), { wrapper: createWrapper() });

    act(() => {
      result.current.mutate({ currentPassword: 'oldpass', newPassword: 'newpass' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ success: true });
  });
});
