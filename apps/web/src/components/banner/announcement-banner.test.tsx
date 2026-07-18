import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createBanner } from '@hushbox/ui/banner';
import { useSession } from '@/lib/auth';
import {
  fetchServerDismissal,
  saveServerDismissal,
  useBannerQuery,
} from '@/hooks/announcements/use-banner';
import { isDemoPath } from '@/lib/is-demo-path';
import { AnnouncementBanner } from './announcement-banner';
import { TEST_SIGNALS, type BannerResponse } from '@hushbox/shared';

// The component is a thin wiring shell; mock exactly its seams. The controller
// (`createBanner`) owns markup/motion/dismissal and has its own tests in
// packages/ui — here we only assert the wiring hands it the right inputs and
// disposes it at the right times.
vi.mock('@hushbox/ui/banner', () => ({
  createBanner: vi.fn(() => vi.fn()),
}));

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/announcements/use-banner', () => ({
  useBannerQuery: vi.fn(),
  fetchServerDismissal: vi.fn(),
  saveServerDismissal: vi.fn(),
}));

vi.mock('@/lib/is-demo-path', () => ({
  isDemoPath: vi.fn(() => false),
}));

const mockCreateBanner = vi.mocked(createBanner);
const mockUseBannerQuery = vi.mocked(useBannerQuery);
const mockUseSession = vi.mocked(useSession);
const mockIsDemoPath = vi.mocked(isDemoPath);

function bannerData(overrides: Partial<BannerResponse> = {}): BannerResponse {
  return {
    hash: 'hash-1',
    messages: [{ text: 'Scheduled maintenance tonight', variant: 'info' }],
    ...overrides,
  };
}

function setQueryData(data: BannerResponse | undefined, isError = false): void {
  mockUseBannerQuery.mockReturnValue({ data, isError } as ReturnType<typeof useBannerQuery>);
}

function setAuthenticated(isAuthenticated: boolean): void {
  mockUseSession.mockReturnValue({
    data: isAuthenticated ? { user: { id: 'user-1' } } : null,
  } as ReturnType<typeof useSession>);
}

function disposerAt(callIndex: number): ReturnType<typeof vi.fn> {
  return mockCreateBanner.mock.results[callIndex]!.value as ReturnType<typeof vi.fn>;
}

describe('AnnouncementBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateBanner.mockImplementation(() => vi.fn());
    mockIsDemoPath.mockReturnValue(false);
  });

  it('renders an empty mount node when no banner data is available', () => {
    setQueryData(undefined);
    setAuthenticated(false);

    const { container } = render(<AnnouncementBanner />);

    expect(container.firstElementChild).toBeInstanceOf(HTMLDivElement);
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('does not create the banner controller when no data is available', () => {
    setQueryData(undefined);
    setAuthenticated(false);

    render(<AnnouncementBanner />);

    expect(mockCreateBanner).not.toHaveBeenCalled();
  });

  it('does not create the banner controller on the demo path even when data is available', () => {
    mockIsDemoPath.mockReturnValue(true);
    setQueryData(bannerData());
    setAuthenticated(true);

    const { container } = render(<AnnouncementBanner />);

    expect(mockCreateBanner).not.toHaveBeenCalled();
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('creates the controller once with the mount node, payload, auth state, and dismissal fns', () => {
    const data = bannerData();
    setQueryData(data);
    setAuthenticated(true);

    const { container } = render(<AnnouncementBanner />);

    expect(mockCreateBanner).toHaveBeenCalledTimes(1);
    expect(mockCreateBanner).toHaveBeenCalledWith(container.firstElementChild, {
      data,
      isAuthenticated: true,
      fetchServerDismissal,
      saveServerDismissal,
    });
  });

  it('passes isAuthenticated false when there is no session user', () => {
    setQueryData(bannerData());
    setAuthenticated(false);

    render(<AnnouncementBanner />);

    expect(mockCreateBanner).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({ isAuthenticated: false })
    );
  });

  it('disposes and recreates the controller when the payload changes', () => {
    setQueryData(bannerData());
    setAuthenticated(true);
    const { rerender } = render(<AnnouncementBanner />);

    setQueryData(
      bannerData({ hash: 'hash-2', messages: [{ text: 'New announcement', variant: 'info' }] })
    );
    rerender(<AnnouncementBanner />);

    expect(disposerAt(0)).toHaveBeenCalledTimes(1);
    expect(mockCreateBanner).toHaveBeenCalledTimes(2);
  });

  it('disposes and recreates the controller when the auth state flips', () => {
    setQueryData(bannerData());
    setAuthenticated(false);
    const { rerender } = render(<AnnouncementBanner />);

    setAuthenticated(true);
    rerender(<AnnouncementBanner />);

    expect(disposerAt(0)).toHaveBeenCalledTimes(1);
    expect(mockCreateBanner).toHaveBeenCalledTimes(2);
    expect(mockCreateBanner).toHaveBeenLastCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({ isAuthenticated: true })
    );
  });

  it('does not mark the mount node settled while the banner fetch is in flight', () => {
    setQueryData(undefined);
    setAuthenticated(false);

    const { container } = render(<AnnouncementBanner />);

    expect(container.firstElementChild).not.toHaveAttribute(TEST_SIGNALS.bannerSettled);
  });

  it('marks the mount node settled once the banner data resolves and is applied', () => {
    setQueryData(bannerData());
    setAuthenticated(false);

    const { container } = render(<AnnouncementBanner />);

    expect(container.firstElementChild).toHaveAttribute(TEST_SIGNALS.bannerSettled, 'true');
    expect(mockCreateBanner).toHaveBeenCalledTimes(1);
  });

  it('marks the mount node settled when the banner fetch errors (no banner shown)', () => {
    setQueryData(undefined, true);
    setAuthenticated(false);

    const { container } = render(<AnnouncementBanner />);

    expect(container.firstElementChild).toHaveAttribute(TEST_SIGNALS.bannerSettled, 'true');
    expect(mockCreateBanner).not.toHaveBeenCalled();
  });

  it('disposes the controller on unmount', () => {
    setQueryData(bannerData());
    setAuthenticated(true);
    const { unmount } = render(<AnnouncementBanner />);

    unmount();

    expect(disposerAt(0)).toHaveBeenCalledTimes(1);
  });
});
