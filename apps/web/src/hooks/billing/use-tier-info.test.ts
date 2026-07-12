import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeBalance } from '@/test-utils/balance-fixture';
import { renderHook } from '@testing-library/react';
import { useTierInfo } from '@/hooks/billing/use-tier-info.js';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/billing/billing.js', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/lib/link-guest-auth', () => ({
  getLinkGuestAuth: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useBalance } from '@/hooks/billing/billing.js';
import { getLinkGuestAuth } from '@/lib/link-guest-auth';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);
const mockedGetLinkGuestAuth = vi.mocked(getLinkGuestAuth);

describe('useTierInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetLinkGuestAuth.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns trial tier when not authenticated', () => {
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: null } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('trial');
    expect(result.current!.canAccessPremium).toBe(false);
    expect(result.current!.balanceCents).toBe(0);
    expect(result.current!.freeAllowanceCents).toBe(0);
  });

  it('returns null when session is loading', () => {
    mockedUseSession.mockReturnValue({ data: null, isPending: true } as unknown as ReturnType<
      typeof useSession
    >);
    mockedUseBalance.mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useBalance
    >);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current).toBeNull();
  });

  it('returns free tier when authenticated with zero balance', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: makeBalance('0', '1000000000'),
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('free');
    expect(result.current!.canAccessPremium).toBe(false);
    expect(result.current!.balanceCents).toBe(0);
    expect(result.current!.freeAllowanceCents).toBe(100);
  });

  it('returns paid tier when authenticated with positive balance', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: makeBalance('10500000000', '0'),
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('paid');
    expect(result.current!.canAccessPremium).toBe(true);
    expect(result.current!.balanceCents).toBe(1050);
    expect(result.current!.freeAllowanceCents).toBe(0);
  });

  it('returns guest tier when link guest auth is set and not authenticated', () => {
    mockedGetLinkGuestAuth.mockReturnValue('some-public-key');
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: null } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.tier).toBe('guest');
    expect(result.current!.canAccessPremium).toBe(false);
  });

  it('returns canAccessPremium: true only for paid tier', () => {
    // Trial
    mockedUseSession.mockReturnValue({ data: null } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: null } as unknown as ReturnType<typeof useBalance>);
    const { result: trialResult } = renderHook(() => useTierInfo());
    expect(trialResult.current!.canAccessPremium).toBe(false);

    // Free
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: makeBalance('0', '1000000000'),
    } as unknown as ReturnType<typeof useBalance>);
    const { result: freeResult } = renderHook(() => useTierInfo());
    expect(freeResult.current!.canAccessPremium).toBe(false);

    // Paid
    mockedUseBalance.mockReturnValue({
      data: makeBalance('5000000000', '0'),
    } as unknown as ReturnType<typeof useBalance>);
    const { result: paidResult } = renderHook(() => useTierInfo());
    expect(paidResult.current!.canAccessPremium).toBe(true);
  });

  it('returns null when authenticated but balance not loaded', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({ data: undefined } as unknown as ReturnType<
      typeof useBalance
    >);

    const { result } = renderHook(() => useTierInfo());

    // While balance is loading, return null — don't guess the tier
    expect(result.current).toBeNull();
  });

  it('correctly converts balance string to cents', () => {
    mockedUseSession.mockReturnValue({
      data: { user: { id: 'user-123' } },
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: makeBalance('123450000000', '500000000'),
    } as unknown as ReturnType<typeof useBalance>);

    const { result } = renderHook(() => useTierInfo());

    expect(result.current!.balanceCents).toBe(12_345);
    expect(result.current!.freeAllowanceCents).toBe(50);
  });
});
