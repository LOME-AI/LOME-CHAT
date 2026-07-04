import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './dev.emails';

vi.mock('@/lib/env', () => ({
  env: {
    isDev: true,
    isLocalDev: true,
    isProduction: false,
    isCI: false,
    isE2E: false,
    requiresRealServices: false,
  },
}));

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      dev: {
        emails: {
          $get: vi.fn(),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]): unknown => mockFetchJson(...args),
}));

interface EmailTemplate {
  name: string;
  label: string;
  html: string;
}

const mockTemplates: EmailTemplate[] = [
  {
    name: 'verification',
    label: 'Email Verification',
    html: '<html><body><h1>Verify your email</h1></body></html>',
  },
  {
    name: 'password-changed',
    label: 'Password Changed',
    html: '<html><body><h1>Password changed</h1></body></html>',
  },
  {
    name: 'welcome',
    label: 'Welcome',
    html: '<html><body><h1>Welcome to HushBox</h1></body></html>',
  },
];

describe('EmailsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loading state', () => {
    it('shows loading indicator when fetching templates', () => {
      mockFetchJson.mockReturnValue(new Promise(() => {})); // never resolves

      renderRoute(Route);

      expect(screen.getByText(/loading email templates/i)).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when fetch fails', async () => {
      mockFetchJson.mockRejectedValue(new Error('Network error'));

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(/failed to load email templates/i)).toBeInTheDocument();
      });
    });
  });

  describe('templates display', () => {
    it('sizes the page to its container, not the viewport', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      // The title also renders in the loading branch, so wait on a
      // loaded-only marker before asserting against the loaded layout.
      await waitFor(() => {
        expect(screen.getByText(mockTemplates[0]!.label)).toBeInTheDocument();
      });
      // min-h-full, not min-h-dvh: the root route's h-dvh banner-row layout
      // owns the viewport height; the page fills the flex-1 content region
      // below the app-wide banner.
      const page = screen.getByText('Email Templates').parentElement?.parentElement;
      expect(page).toHaveClass('min-h-full');
    });

    it('renders a heading for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        for (const template of mockTemplates) {
          expect(screen.getByText(template.label)).toBeInTheDocument();
        }
      });
    });

    it('renders an iframe for each template', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframes = screen.getAllByTitle(/email template preview/i);
        expect(iframes).toHaveLength(mockTemplates.length);
      });
    });

    it('sets iframe srcDoc to template html', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        for (const template of mockTemplates) {
          const iframe = screen.getByTestId(TEST_ID_BUILDERS.emailIframe(template.name));
          expect(iframe).toHaveAttribute('srcDoc', template.html);
        }
      });
    });

    it('sandboxes iframes to prevent script execution', async () => {
      mockFetchJson.mockResolvedValue({ templates: mockTemplates });

      renderRoute(Route);

      await waitFor(() => {
        const iframes = screen.getAllByTitle(/email template preview/i);
        for (const iframe of iframes) {
          expect(iframe).toHaveAttribute('sandbox', '');
        }
      });
    });
  });

  describe('empty state', () => {
    it('shows empty message when no templates returned', async () => {
      mockFetchJson.mockResolvedValue({ templates: [] });

      renderRoute(Route);

      await waitFor(() => {
        expect(screen.getByText(/no email templates found/i)).toBeInTheDocument();
      });
    });
  });

  it('renders page title', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email templates/i })).toBeInTheDocument();
    });
  });

  it('shows template count in subtitle', async () => {
    mockFetchJson.mockResolvedValue({ templates: mockTemplates });

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByText(/3 templates/i)).toBeInTheDocument();
    });
  });
});
