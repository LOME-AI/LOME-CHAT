import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { IssuesTable } from './issues-table.js';
import type { NewsletterIssueWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'newsletter.cancel',
      title: 'Cancel scheduled newsletter issue',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'newsletter.schedule',
      fields: ['issueId', 'reason'],
    },
  ],
};

const SCHEDULED: NewsletterIssueWire = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  subject: 'July product notes',
  status: 'scheduled',
  scheduledAt: '2026-07-20T09:00:00.000Z',
  canceledAt: null,
  sentAt: null,
  recipientCount: null,
  sentCount: null,
  failedCount: null,
  createdBy: 'lome@lome-ai.com',
  createdAt: '2026-07-17T09:00:00.000Z',
};

const SENT: NewsletterIssueWire = {
  id: '018f6b3a-0000-7000-8000-00000000000b',
  subject: 'June recap',
  status: 'sent',
  scheduledAt: '2026-06-20T09:00:00.000Z',
  canceledAt: null,
  sentAt: '2026-06-20T09:01:00.000Z',
  recipientCount: 41,
  sentCount: 40,
  failedCount: 1,
  createdBy: 'lome@lome-ai.com',
  createdAt: '2026-06-17T09:00:00.000Z',
};

function renderTable(rows: readonly NewsletterIssueWire[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(CATALOG)))
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <IssuesTable rows={rows} />
      </OpModalProvider>
    </QueryClientProvider>
  );
}

describe('IssuesTable', () => {
  it('renders one dense row per issue with subject and status', () => {
    renderTable([SCHEDULED, SENT]);
    const table = screen.getByTestId(TEST_IDS.adminNewsletterTable);
    expect(within(table).getByText('July product notes')).toBeInTheDocument();
    expect(within(table).getByText('June recap')).toBeInTheDocument();
    expect(within(table).getByText('scheduled')).toBeInTheDocument();
    expect(within(table).getByText('sent')).toBeInTheDocument();
  });

  it('shows sent/recipient/failed counts and em-dashes the not-yet-sent row', () => {
    renderTable([SCHEDULED, SENT]);
    const table = screen.getByTestId(TEST_IDS.adminNewsletterTable);
    expect(within(table).getByText('40 / 41')).toBeInTheDocument();
    expect(within(table).getByText('1')).toBeInTheDocument();
  });

  it('offers Cancel only on scheduled rows', () => {
    renderTable([SCHEDULED, SENT]);
    expect(screen.getAllByTestId(TEST_IDS.adminNewsletterCancel)).toHaveLength(1);
  });

  it('launches the cancel op through the OpModal with the row issueId prefilled', async () => {
    renderTable([SCHEDULED]);
    await userEvent.click(screen.getByTestId(TEST_IDS.adminNewsletterCancel));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByText('Cancel scheduled newsletter issue')).toBeInTheDocument();
    expect(within(modal).getByLabelText('issueId')).toHaveValue(SCHEDULED.id);
  });
});
