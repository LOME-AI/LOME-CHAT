import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { NewsletterSignup } from './NewsletterSignup';

const SUCCESS_TEXT = 'Check your inbox to confirm.';

function mockFetch(response: { ok: boolean; status: number } | 'reject'): ReturnType<typeof vi.fn> {
  const function_ =
    response === 'reject'
      ? vi.fn(() => Promise.reject(new Error('network down')))
      : vi.fn(() =>
          Promise.resolve({
            ok: response.ok,
            status: response.status,
            json: () => Promise.resolve(response.ok ? { ok: true } : { code: 'RATE_LIMITED' }),
          })
        );
  vi.stubGlobal('fetch', function_);
  return function_;
}

async function submitValidEmail(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'reader@example.com');
  await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
}

describe('NewsletterSignup', () => {
  beforeEach(() => {
    mockFetch({ ok: true, status: 200 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the email input with its test id', () => {
    render(<NewsletterSignup />);
    expect(screen.getByTestId(TEST_IDS.newsletterSignupInput)).toBeInTheDocument();
  });

  it('renders the Subscribe submit button with its test id', () => {
    render(<NewsletterSignup />);
    const button = screen.getByTestId(TEST_IDS.newsletterSignupSubmit);
    expect(button).toHaveTextContent('Subscribe');
  });

  it('shows the confirmation microcopy in the full variant', () => {
    render(<NewsletterSignup />);
    expect(screen.getByText("One confirmation email, then you're in.")).toBeInTheDocument();
  });

  it('shows the one-line pitch instead of the microcopy in the compact variant', () => {
    render(<NewsletterSignup compact />);
    expect(screen.getByText('A few letters a year, written by humans.')).toBeInTheDocument();
    expect(screen.queryByText("One confirmation email, then you're in.")).not.toBeInTheDocument();
  });

  it('rejects an invalid email with a validation message and no request', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'not-an-email');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email address.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the validation message once a corrected email is submitted', async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);
    await user.type(screen.getByTestId(TEST_IDS.newsletterSignupInput), 'nope');
    await user.click(screen.getByTestId(TEST_IDS.newsletterSignupSubmit));
    await user.clear(screen.getByTestId(TEST_IDS.newsletterSignupInput));
    await submitValidEmail();
    await waitFor(() => {
      expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('POSTs the email as JSON to /newsletter/subscribe', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200 });
    render(<NewsletterSignup />);
    await submitValidEmail();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/newsletter/subscribe');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ email: 'reader@example.com' }));
  });

  // Enumeration safety is server-side; the UI pins one identical outcome for
  // every response so a probe can never read list membership off the screen.
  it.each([
    ['ok', { ok: true, status: 200 }] as const,
    ['server error', { ok: false, status: 500 }] as const,
    ['rate limited', { ok: false, status: 429 }] as const,
    ['network failure', 'reject'] as const,
  ])('shows the identical success state on %s', async (_label, response) => {
    mockFetch(response);
    render(<NewsletterSignup />);
    await submitValidEmail();
    await waitFor(() => {
      expect(screen.getByText(SUCCESS_TEXT)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.newsletterSignupInput)).not.toBeInTheDocument();
  });

  it('emits the readiness signal once hydrated', async () => {
    const { container } = render(<NewsletterSignup />);
    await waitFor(() => {
      expect(container.querySelector(`[${TEST_SIGNALS.newsletterReady}]`)).not.toBeNull();
    });
  });

  it('does not carry the readiness signal in server-rendered markup', () => {
    const html = renderToStaticMarkup(<NewsletterSignup />);
    expect(html).not.toContain(TEST_SIGNALS.newsletterReady);
  });
});
