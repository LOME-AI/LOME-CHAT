import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError } from '@/lib/api-client';
import { requestUrl } from '@/test-utils/request-url';
import { executeOp, previewOp } from './op-run.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchInput = string | URL | Request;

function requestInit(call: readonly unknown[]): RequestInit {
  return (call[1] ?? {}) as RequestInit;
}

function requestBody(call: readonly unknown[]): unknown {
  return JSON.parse(requestInit(call).body as string) as unknown;
}

describe('previewOp', () => {
  it('posts the input envelope to the preview endpoint', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({ effects: [{ label: 'wallet.balance' }], inverseInput: { a: 1 } })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await previewOp('wallet.credit', { walletId: 'w', reason: 'r' });

    expect(result.effects).toEqual([{ label: 'wallet.balance' }]);
    expect(result.inverseInput).toEqual({ a: 1 });
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      '/api/admin/ops/wallet.credit/preview'
    );
    const body = requestBody(fetchMock.mock.calls[0]!);
    expect(body).toEqual({ input: { walletId: 'w', reason: 'r' } });
  });

  it('rejects a malformed preview payload (shared-schema re-validation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ effects: [{ label: 7 }], inverseInput: null })))
    );

    await expect(previewOp('wallet.credit', {})).rejects.toThrow();
  });

  it('throws an ApiError carrying the wire code on refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'GUARDRAIL' }, { status: 422 })))
    );

    await expect(previewOp('wallet.credit', {})).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.message === 'GUARDRAIL'
    );
  });
});

describe('executeOp', () => {
  it('posts with the Idempotency-Key header and returns the run result', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          auditId: '018f6b3a-0000-7000-8000-000000000000',
          effects: [],
          inverseInput: { walletId: 'w' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeOp({
      name: 'wallet.credit',
      input: { walletId: 'w' },
      idempotencyKey: 'key-123',
    });

    expect(result.auditId).toBe('018f6b3a-0000-7000-8000-000000000000');
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      '/api/admin/ops/wallet.credit/execute'
    );
    const headers = new Headers(requestInit(fetchMock.mock.calls[0]!).headers);
    expect(headers.get('Idempotency-Key')).toBe('key-123');
    const body = requestBody(fetchMock.mock.calls[0]!);
    expect(body).toEqual({ input: { walletId: 'w' } });
  });

  it('includes undoes in the body when executing an undo', async () => {
    const fetchMock = vi.fn((_input: FetchInput, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          auditId: '018f6b3a-0000-7000-8000-000000000001',
          effects: [],
          inverseInput: null,
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await executeOp({
      name: 'wallet.clawback',
      input: { walletId: 'w' },
      idempotencyKey: 'key-456',
      undoes: 'audit-1',
    });

    const body = requestBody(fetchMock.mock.calls[0]!);
    expect(body).toEqual({ input: { walletId: 'w' }, undoes: 'audit-1' });
  });

  it('rejects a malformed execute payload (shared-schema re-validation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ auditId: 'not-a-uuid', effects: [], inverseInput: null }))
      )
    );

    await expect(
      executeOp({ name: 'wallet.credit', input: {}, idempotencyKey: 'key-789' })
    ).rejects.toThrow();
  });
});
