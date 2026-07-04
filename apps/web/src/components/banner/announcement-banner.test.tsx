import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createBanner } from '@hushbox/ui/banner';
import { useSession } from '@/lib/auth';
import {
  fetchServerDismissal,
  saveServerDismissal,
  useBannerQuery,
} from '@/hooks/announcements/use-banner';
import { AnnouncementBanner } from './announcement-banner';
import type { BannerResponse } from '@hushbox/shared';

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

const mockCreateBanner = vi.mocked(createBanner);
const mockUseBannerQuery = vi.mocked(useBannerQuery);
const mockUseSession = vi.mocked(useSession);

function bannerData(overrides: Partial<BannerResponse> = {}): BannerResponse {
  return {
    hash: 'hash-1',
    variant: 'info',
    messages: [{ text: 'Scheduled maintenance tonight' }],
    ...overrides,
  };
}

function setQueryData(data: BannerResponse | undefined): void {
  mockUseBannerQuery.mockReturnValue({ data } as ReturnType<typeof useBannerQuery>);
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

    setQueryData(bannerData({ hash: 'hash-2', messages: [{ text: 'New announcement' }] }));
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

  it('disposes the controller on unmount', () => {
    setQueryData(bannerData());
    setAuthenticated(true);
    const { unmount } = render(<AnnouncementBanner />);

    unmount();

    expect(disposerAt(0)).toHaveBeenCalledTimes(1);
  });
});
