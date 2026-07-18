import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CrawlerEye } from './crawler-eye';

const ORIGIN = 'http://localhost:7200';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CrawlerEye', () => {
  it('renders a green pass dot when no audience has findings', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verdict: { ai: [], search: [], social: [] } }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: all audiences pass' })
      ).toBeInTheDocument();
    });
  });

  it('renders a red fail dot and failure count when an audience fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            verdict: { ai: [{ level: 'fail' }], search: [{ level: 'warn' }], social: [] },
          }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: 1 failure' })
      ).toBeInTheDocument();
    });
  });

  it('renders an amber warn dot and warning count when only warnings exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            verdict: { ai: [{ level: 'warn' }], search: [{ level: 'warn' }], social: [] },
          }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: 2 warnings' })
      ).toBeInTheDocument();
    });
  });

  it('renders a singular warning label for exactly one warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ verdict: { ai: [{ level: 'warn' }], search: [], social: [] } }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: 1 warning' })
      ).toBeInTheDocument();
    });
  });

  it('renders a plural failures label for multiple failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            verdict: { ai: [{ level: 'fail' }], search: [{ level: 'fail' }], social: [] },
          }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: 2 failures' })
      ).toBeInTheDocument();
    });
  });

  it('opens the crawler-view dashboard focused on the current URL when clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verdict: { ai: [], search: [], social: [] } }),
      })
    );
    const open = vi.fn();
    vi.stubGlobal('open', open);
    render(<CrawlerEye origin={ORIGIN} />);

    const button = await screen.findByRole('button');
    fireEvent.click(button);

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:7200/?url='),
      '_blank',
      'noopener'
    );
  });

  it('shows a pointer cursor to signal the badge is clickable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ verdict: { ai: [], search: [], social: [] } }),
      })
    );
    render(<CrawlerEye origin={ORIGIN} />);

    const button = await screen.findByRole('button');
    expect(button.className).toContain('cursor-pointer');
  });

  it('audits the origin it is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ verdict: { ai: [], search: [], social: [] } }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<CrawlerEye origin="http://localhost:9999" />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:9999/api/crawl?url='),
        expect.anything()
      );
    });
  });

  it('degrades to an offline dot when the crawler-view server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: crawler-view server offline' })
      ).toBeInTheDocument();
    });
  });

  it('degrades to an offline dot on a non-ok crawl response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<CrawlerEye origin={ORIGIN} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Crawler visibility: crawler-view server offline' })
      ).toBeInTheDocument();
    });
  });

  it('does not update state after unmount when the in-flight request is aborted', async () => {
    let rejectFetch!: (reason: unknown) => void;
    const pending = new Promise((_resolve, reject) => {
      rejectFetch = reject;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(<CrawlerEye origin={ORIGIN} />);
    unmount(); // cleanup aborts the controller
    await act(async () => {
      rejectFetch(new Error('aborted'));
      await pending.catch(() => {});
    });

    // The aborted guard skips setState, so no setState-after-unmount warning.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
