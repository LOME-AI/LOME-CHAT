import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { isDev: true },
}));

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ href: '/chat' }),
}));

// The badge reads the crawler-view origin from this dev-only env var.
vi.stubEnv('VITE_CRAWLER_VIEW_URL', 'http://localhost:7200');

async function loadComponent(): Promise<typeof import('./crawler-eye')> {
  return import('./crawler-eye');
}

describe('CrawlerEye', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('in development mode', () => {
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = { isDev: true } as typeof envModule.env;
    });

    it('renders a green pass dot when no audience has findings', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ verdict: { ai: [], search: [], social: [] } }),
        })
      );
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
              verdict: {
                ai: [{ level: 'fail' }],
                search: [{ level: 'warn' }],
                social: [],
              },
            }),
        })
      );
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

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
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

      const button = await screen.findByRole('button');
      expect(button.className).toContain('cursor-pointer');
    });

    it('degrades to an offline dot when the crawler-view server is unreachable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Crawler visibility: crawler-view server offline' })
        ).toBeInTheDocument();
      });
    });

    it('degrades to an offline dot on a non-ok crawl response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: 'Crawler visibility: crawler-view server offline' })
        ).toBeInTheDocument();
      });
    });

    it('renders nothing when the crawler-view URL is not configured', async () => {
      // vi.stubEnv requires the value arg; `undefined` unsets the var (an empty
      // string would not trip the `=== undefined` guard the badge renders on).
      // eslint-disable-next-line unicorn/no-useless-undefined -- see comment above
      vi.stubEnv('VITE_CRAWLER_VIEW_URL', undefined);
      const { CrawlerEye } = await loadComponent();
      const { container } = render(<CrawlerEye />);
      expect(container).toBeEmptyDOMElement();
      vi.stubEnv('VITE_CRAWLER_VIEW_URL', 'http://localhost:7200');
    });
  });

  describe('outside development mode', () => {
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = { isDev: false } as typeof envModule.env;
    });

    it('renders nothing', async () => {
      const { CrawlerEye } = await loadComponent();
      const { container } = render(<CrawlerEye />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });
});
