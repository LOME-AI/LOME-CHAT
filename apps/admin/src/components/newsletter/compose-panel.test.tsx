import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { ComposePanel, toUtcIso } from './compose-panel.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'newsletter.schedule',
      title: 'Schedule newsletter issue',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'newsletter.cancel',
      fields: ['subject', 'bodyMarkdown', 'scheduledAt', 'reason'],
    },
    {
      name: 'newsletter.testSend',
      title: 'Send newsletter test email',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['subject', 'bodyMarkdown', 'reason'],
    },
  ],
};

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.includes('/admin/ops')) {
        return Promise.resolve(Response.json(CATALOG));
      }
      return Promise.resolve(Response.json({ html: '<p>preview</p>' }));
    })
  );
}

function renderPanel(): void {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <ComposePanel />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

async function fillDraft(): Promise<void> {
  await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterSubject), 'July notes');
  await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterBody), '# hello');
  await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterReason), 'monthly issue');
}

describe('toUtcIso', () => {
  it('converts a minutes-precision picker value to a UTC ISO instant', () => {
    expect(toUtcIso('2030-01-02T09:30')).toBe('2030-01-02T09:30:00.000Z');
  });

  it('converts a seconds-bearing picker value without corrupting the instant', () => {
    expect(toUtcIso('2030-01-02T09:30:15')).toBe('2030-01-02T09:30:15.000Z');
  });
});

describe('ComposePanel', () => {
  it('renders subject, markdown body, UTC schedule picker, and reason fields', () => {
    renderPanel();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterSubject)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterBody)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminNewsletterReason)).toBeInTheDocument();
    expect(screen.getByText(/UTC/)).toBeInTheDocument();
  });

  it('keeps Schedule disabled until the full draft is present', async () => {
    renderPanel();
    const schedule = screen.getByTestId(TEST_IDS.adminNewsletterSchedule);
    expect(schedule).toBeDisabled();
    await fillDraft();
    expect(schedule).toBeDisabled();
    await userEvent.type(
      screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt),
      '2030-01-02T09:30'
    );
    expect(schedule).toBeEnabled();
  });

  it('launches newsletter.schedule through the OpModal with the draft prefilled as UTC ISO', async () => {
    renderPanel();
    await fillDraft();
    await userEvent.type(
      screen.getByTestId(TEST_IDS.adminNewsletterScheduledAt),
      '2030-01-02T09:30'
    );
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterSchedule));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Schedule newsletter issue')).toBeInTheDocument();
    expect(within(modal).getByLabelText('subject')).toHaveValue('July notes');
    expect(within(modal).getByLabelText('bodyMarkdown')).toHaveValue('# hello');
    expect(within(modal).getByLabelText('scheduledAt')).toHaveValue('2030-01-02T09:30:00.000Z');
    expect(within(modal).getByLabelText('reason')).toHaveValue('monthly issue');
  });

  it('launches newsletter.testSend through the OpModal with the draft prefilled', async () => {
    renderPanel();
    await fillDraft();
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterTestSend));

    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Send newsletter test email')).toBeInTheDocument();
    expect(within(modal).getByLabelText('subject')).toHaveValue('July notes');
    expect(within(modal).getByLabelText('bodyMarkdown')).toHaveValue('# hello');
    expect(within(modal).getByLabelText('reason')).toHaveValue('monthly issue');
  });

  it('keeps Send-test disabled until subject and body are present', async () => {
    renderPanel();
    const testSend = screen.getByTestId(TEST_IDS.adminNewsletterTestSend);
    expect(testSend).toBeDisabled();
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterSubject), 'July notes');
    await userEvent.type(screen.getByTestId(TEST_IDS.adminNewsletterBody), '# hello');
    expect(testSend).toBeEnabled();
  });
});
