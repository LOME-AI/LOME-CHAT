import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: { isDevServer: true },
}));

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ href: '/chat' }),
}));

// The shared badge is exercised in @hushbox/ui; here we only assert the web
// wrapper's gate and that it forwards the resolved origin.
vi.mock('@hushbox/ui', () => ({
  CrawlerEye: ({ origin }: { origin: string }) => <div data-testid="badge" data-origin={origin} />,
}));

vi.stubEnv('VITE_CRAWLER_VIEW_URL', 'http://localhost:7200');

async function loadComponent(): Promise<typeof import('./crawler-eye')> {
  return import('./crawler-eye');
}

describe('CrawlerEye (web mount)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('under the dev server', () => {
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = { isDevServer: true } as typeof envModule.env;
    });

    it('mounts the shared badge with the resolved crawler-view origin', async () => {
      const { CrawlerEye } = await loadComponent();
      render(<CrawlerEye />);
      expect(screen.getByTestId('badge')).toHaveAttribute('data-origin', 'http://localhost:7200');
    });

    it('fails fast when the crawler-view URL is unset', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
      vi.stubEnv('VITE_CRAWLER_VIEW_URL', undefined);
      const { CrawlerEye } = await loadComponent();
      expect(() => render(<CrawlerEye />)).toThrow('VITE_CRAWLER_VIEW_URL');
      vi.stubEnv('VITE_CRAWLER_VIEW_URL', 'http://localhost:7200');
    });
  });

  describe('outside the dev server (E2E, vitest, production)', () => {
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = { isDevServer: false } as typeof envModule.env;
    });

    it('renders nothing even though the crawler-view URL is set', async () => {
      const { CrawlerEye } = await loadComponent();
      const { container } = render(<CrawlerEye />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
    });
  });
});
