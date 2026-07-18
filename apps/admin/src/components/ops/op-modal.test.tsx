import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { requestUrl } from '@/test-utils/request-url';
import { OpModal } from './op-modal.js';
import type { AdminOpWire } from '@hushbox/shared';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const OPS: readonly AdminOpWire[] = [
  {
    name: 'wallet.credit',
    title: 'Credit wallet',
    kind: 'mutation',
    effectClass: 'durable',
    inverse: 'wallet.clawback',
    fields: ['walletId', 'amountNanoUsd', 'reason'],
  },
  {
    name: 'wallet.clawback',
    title: 'Claw back wallet credit',
    kind: 'mutation',
    effectClass: 'durable',
    inverse: 'wallet.credit',
    fields: ['walletId', 'amountNanoUsd', 'reason'],
  },
];

const UUID = '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40';
const AUDIT_ID = '01890a5c-0000-7000-8000-000000000001';

interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function stubOpsFetch(handlers: {
  preview?: (req: RecordedRequest) => Response;
  execute?: (req: RecordedRequest) => Response;
}): { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      const req: RecordedRequest = {
        url,
        headers: new Headers(init?.headers),
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      };
      calls.push(req);
      if (url.includes('/preview')) {
        return Promise.resolve(
          handlers.preview?.(req) ??
            Response.json({
              effects: [{ label: 'wallet.balanceNanoUsd', before: '0', after: '5000000000' }],
              inverseInput: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'undo credit' },
            })
        );
      }
      if (url.includes('/execute')) {
        return Promise.resolve(
          handlers.execute?.(req) ??
            Response.json({
              auditId: AUDIT_ID,
              effects: [{ label: 'wallet.balanceNanoUsd', before: '0', after: '5000000000' }],
              inverseInput: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'undo credit' },
            })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
  return { calls };
}

function renderModal(onClose = vi.fn()): {
  onClose: ReturnType<typeof vi.fn>;
  client: QueryClient;
} {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OpModal ops={OPS} start={{ opName: 'wallet.credit' }} onClose={onClose} />
    </QueryClientProvider>
  );
  return { onClose, client };
}

async function fillAndPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText('walletId'), UUID);
  await user.type(screen.getByLabelText('amountNanoUsd'), '5000000000');
  await user.type(screen.getByLabelText('reason'), 'test credit');
  await user.click(screen.getByRole('button', { name: 'Preview changes' }));
}

describe('OpModal', () => {
  // Regression guard for the reorder+prepend hang: a tall op form (repeatable
  // groups grow unbounded) must scroll inside the centered fixed dialog, or the
  // submit button falls below the fold and becomes unreachable — no window
  // scroll can reach a fixed element's overflow. jsdom has no layout, so this
  // asserts the affordance; the banner e2e's reorder leg is the behavioral net.
  it('caps its height and scrolls internally so a tall form stays reachable', () => {
    stubOpsFetch({});
    renderModal();
    const modal = screen.getByTestId(TEST_IDS.adminOpModal);
    expect(modal.className).toContain('overflow-y-auto');
    expect(modal.className).toMatch(/max-h-\[/);
  });

  it('invalidates the admin query-key root after a successful execute', async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    const { client } = renderModal();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    expect(invalidate).not.toHaveBeenCalled();
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin'] });
  });

  it('does not invalidate admin queries when the execute fails', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      execute: () => Response.json({ code: 'GUARDRAIL_VIOLATION' }, { status: 422 }),
    });
    const { client } = renderModal();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('opens on the form step with the op title', () => {
    stubOpsFetch({});
    renderModal();
    expect(screen.getByTestId(TEST_IDS.adminOpModal)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Credit wallet' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
  });

  it('previews on submit and labels execute with the consequence, never Confirm', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpDiff)).toBeInTheDocument();
    });
    expect(calls[0]?.url).toContain('/api/admin/ops/wallet.credit/preview');
    expect(calls[0]?.body).toEqual({
      input: { walletId: UUID, amountNanoUsd: '5000000000', reason: 'test credit' },
    });
    const execute = screen.getByTestId(TEST_IDS.adminOpExecute);
    expect(execute).toHaveTextContent('Credit wallet (1 change)');
    expect(execute).not.toHaveTextContent('Confirm');
  });

  it('blocks at the preview step on a guardrail refusal', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      preview: () => Response.json({ code: 'GUARDRAIL_EXCEEDED' }, { status: 422 }),
    });
    renderModal();

    await fillAndPreview(user);

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpError)).toHaveTextContent('GUARDRAIL_EXCEEDED');
    expect(screen.queryByTestId(TEST_IDS.adminOpExecute)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to form' }));
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
    expect(screen.getByLabelText('walletId')).toHaveValue(UUID);
  });

  it('preserves group rows and booleans across a back-to-form round trip', async () => {
    const user = userEvent.setup();
    stubOpsFetch({
      preview: () => Response.json({ code: 'GUARDRAIL_EXCEEDED' }, { status: 422 }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const bannerOps: readonly AdminOpWire[] = [
      {
        name: 'banner.set',
        title: 'Set banner',
        kind: 'mutation',
        effectClass: 'durable',
        inverse: 'banner.set',
        fields: ['enabled', 'messages', 'reason'],
      },
    ];
    render(
      <QueryClientProvider client={client}>
        <OpModal ops={bannerOps} start={{ opName: 'banner.set' }} onClose={vi.fn()} />
      </QueryClientProvider>
    );

    await user.click(screen.getByRole('switch', { name: 'enabled' }));
    const row = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    await user.click(within(row).getByRole('combobox', { name: 'variant' }));
    await user.click(screen.getByRole('option', { name: 'info' }));
    await user.type(within(row).getByLabelText('text'), 'Maintenance at noon');
    await user.type(screen.getByLabelText('reason'), 'round trip');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await user.click(await screen.findByRole('button', { name: 'Back to form' }));

    expect(screen.getByRole('switch', { name: 'enabled' })).toHaveAttribute(
      'data-state',
      'checked'
    );
    const restoredRow = screen.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', 0));
    expect(within(restoredRow).getByLabelText('text')).toHaveValue('Maintenance at noon');
  });

  it('executes with an Idempotency-Key and shows the audit id with a copy affordance', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));

    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpAuditId)).toHaveTextContent(AUDIT_ID);
    const executeCall = calls.find((call) => call.url.includes('/execute'));
    expect(executeCall?.headers.get('Idempotency-Key')).toMatch(/[0-9a-f-]{36}/);

    await user.click(screen.getByTestId(TEST_IDS.adminOpCopyAudit));
    expect(writeText).toHaveBeenCalledWith(AUDIT_ID);
  });

  it('reuses the same Idempotency-Key when retrying a failed execute', async () => {
    const user = userEvent.setup();
    let executeAttempts = 0;
    const { calls } = stubOpsFetch({
      execute: () => {
        executeAttempts += 1;
        if (executeAttempts === 1) {
          return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
        }
        return Response.json({ auditId: AUDIT_ID, effects: [], inverseInput: null });
      },
    });
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    const executeCalls = calls.filter((call) => call.url.includes('/execute'));
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[0]?.headers.get('Idempotency-Key')).toBe(
      executeCalls[1]?.headers.get('Idempotency-Key')
    );
  });

  it('mints a fresh Idempotency-Key for a new form submission', async () => {
    const user = userEvent.setup();
    const { calls } = stubOpsFetch({});
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    const firstKey = calls
      .find((call) => call.url.includes('/execute'))
      ?.headers.get('Idempotency-Key');

    // Undo starts a NEW submission of the inverse op: new form, new key.
    await user.click(screen.getByTestId(TEST_IDS.adminOpUndo));
    expect(screen.getByRole('heading', { name: 'Claw back wallet credit' })).toBeInTheDocument();
    expect(screen.getByLabelText('reason')).toHaveValue('undo credit');
    await user.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });

    const executeCalls = calls.filter((call) => call.url.includes('/execute'));
    expect(executeCalls).toHaveLength(2);
    expect(executeCalls[1]?.url).toContain('/api/admin/ops/wallet.clawback/execute');
    expect(executeCalls[1]?.body).toMatchObject({ undoes: AUDIT_ID });
    expect(executeCalls[1]?.headers.get('Idempotency-Key')).not.toBe(firstKey);
  });

  it('shows the generic error for a non-API failure at preview', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network down')))
    );
    renderModal();

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpError)).toBeInTheDocument();
    });
    expect(screen.getByTestId(TEST_IDS.adminOpError)).toHaveTextContent('INTERNAL');
  });

  it('falls back to the op name and wire fields for an op missing from the shared contracts', () => {
    stubOpsFetch({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OpModal
          ops={[
            {
              name: 'future.op',
              title: 'Future op',
              kind: 'mutation',
              effectClass: 'ephemeral',
              inverse: null,
              fields: ['targetId', 'reason'],
            },
          ]}
          start={{ opName: 'mystery.op' }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>
    );
    expect(screen.getByRole('heading', { name: 'mystery.op' })).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.adminOpForm)).toBeInTheDocument();
  });

  it('closes through the Done button', async () => {
    const user = userEvent.setup();
    stubOpsFetch({});
    const onClose = vi.fn();
    renderModal(onClose);

    await fillAndPreview(user);
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpExecute)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.adminOpExecute));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.adminOpResult)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
