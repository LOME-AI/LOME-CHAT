import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { FeedbackDetailRow } from './feedback-detail-row.js';
import type { FeedbackInboxRowWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  ops: [
    {
      name: 'feedback.setStatus',
      title: 'Set feedback status',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'feedback.setStatus',
      fields: ['feedbackId', 'status', 'reason'],
    },
  ],
};

const ROW: FeedbackInboxRowWire = {
  id: '018f6b3a-0000-7000-8000-00000000000a',
  kind: 'bug',
  status: 'new',
  bodyPreview: 'The composer freezes when…',
  createdAt: '2026-07-14T09:00:00.000Z',
  userId: '018f6b3a-0000-7000-8000-000000000001',
};

const FULL_BODY = 'The composer freezes when I paste a very long message and then hit send twice.';

const DETAIL = {
  id: ROW.id,
  kind: ROW.kind,
  status: ROW.status,
  body: FULL_BODY,
  createdAt: ROW.createdAt,
  userId: ROW.userId,
};

type Handler = (url: string) => Record<string, unknown> | Response;

function stubApi(handler: Handler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const result = handler(requestUrl(input));
    return Promise.resolve(result instanceof Response ? result : Response.json(result));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetail(): { fetchMock: ReturnType<typeof vi.fn> } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = stubApi((url) =>
    url.includes(`/admin/feedback/${ROW.id}`) ? DETAIL : CATALOG
  );
  render(
    <QueryClientProvider client={client}>
      <OpModalProvider>
        <table>
          <tbody>
            <FeedbackDetailRow row={ROW} columnCount={6} />
          </tbody>
        </table>
      </OpModalProvider>
    </QueryClientProvider>
  );
  return { fetchMock };
}

describe('FeedbackDetailRow', () => {
  it('reads and shows the full message body via the lazy detail read', async () => {
    renderDetail();
    const detail = screen.getByTestId(TEST_IDS.adminFeedbackDetail);
    expect(await within(detail).findByText(FULL_BODY)).toBeInTheDocument();
  });

  it('wraps the message body so a long unbroken string cannot overflow', async () => {
    renderDetail();
    const detail = screen.getByTestId(TEST_IDS.adminFeedbackDetail);
    const body = await within(detail).findByText(FULL_BODY);
    expect(body).toHaveClass('break-all', 'whitespace-pre-wrap');
  });

  it('issues exactly one detail read for the expanded row', async () => {
    const { fetchMock } = renderDetail();
    await screen.findByText(FULL_BODY);
    const detailCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).includes(`/admin/feedback/${ROW.id}`)
    );
    expect(detailCalls).toHaveLength(1);
  });

  it('shows a loading state while the message is in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModalProvider>
          <table>
            <tbody>
              <FeedbackDetailRow row={ROW} columnCount={6} />
            </tbody>
          </table>
        </OpModalProvider>
      </QueryClientProvider>
    );
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows an error state when the message read fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubApi((url) =>
      url.includes(`/admin/feedback/${ROW.id}`)
        ? Response.json({ code: 'UNAVAILABLE' }, { status: 503 })
        : CATALOG
    );
    render(
      <QueryClientProvider client={client}>
        <OpModalProvider>
          <table>
            <tbody>
              <FeedbackDetailRow row={ROW} columnCount={6} />
            </tbody>
          </table>
        </OpModalProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Failed to load the message.')).toBeInTheDocument();
  });

  it('runs the set-status op with the feedback id prefilled', async () => {
    renderDetail();
    await screen.findByText(FULL_BODY);
    await userEvent.click(screen.getByRole('button', { name: /set status/i }));
    const modal = await screen.findByTestId(TEST_IDS.adminOpModal);
    expect(within(modal).getByLabelText('feedbackId')).toHaveValue(ROW.id);
  });
});
