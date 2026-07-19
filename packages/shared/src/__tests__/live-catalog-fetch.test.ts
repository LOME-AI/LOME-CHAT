import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WatchdogFetchError, fetchLiveModelsRaw, fetchWithRetry } from './live-catalog-fetch.js';

const mockFetch = vi.fn();

const PUBLIC_MODELS_URL = 'https://test.example/v1/models';

function asAbortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

const validBody = { object: 'list', data: [] };

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('WatchdogFetchError', () => {
  it('captures the abort kind without a status', () => {
    const error = new WatchdogFetchError('abort', undefined, 'timed out');
    expect(error.kind).toBe('abort');
    expect(error.httpStatus).toBeUndefined();
    expect(error.name).toBe('WatchdogFetchError');
  });

  it('captures the http kind and status', () => {
    const error = new WatchdogFetchError('http', 503, 'service unavailable');
    expect(error.kind).toBe('http');
    expect(error.httpStatus).toBe(503);
  });
});

describe('fetchLiveModelsRaw', () => {
  it('throws WatchdogFetchError with kind=abort when fetch throws AbortError', async () => {
    mockFetch.mockRejectedValue(asAbortError());

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 10 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('abort');
  });

  it('throws WatchdogFetchError with kind=network when fetch throws a non-abort error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('network');
  });

  it('throws WatchdogFetchError with kind=network for a non-Error rejection', async () => {
    mockFetch.mockRejectedValue('weird string rejection');

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('network');
  });

  it('throws WatchdogFetchError with kind=http and status on non-2xx response', async () => {
    mockFetch.mockResolvedValue(errorResponse(503, 'Service Unavailable'));

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('http');
    expect((error as WatchdogFetchError).httpStatus).toBe(503);
  });

  it('returns the parsed result on success', async () => {
    mockFetch.mockResolvedValue(okResponse(validBody));

    const result = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 });

    expect(result.all).toEqual([]);
    expect(result.byId.size).toBe(0);
  });

  it('throws WatchdogFetchError with kind=schema when the body fails validation', async () => {
    mockFetch.mockResolvedValue(okResponse({ data: [{ id: 42 }] }));

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('schema');
  });

  it('aborts a hung fetch after the configured timeout', async () => {
    // The hanging promise rejects only when the internal timeout fires the
    // AbortSignal — proving the watchdog's own timer, not the stub, ends it.
    mockFetch.mockImplementation(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(asAbortError());
          });
        })
    );

    const error = await fetchLiveModelsRaw({ url: PUBLIC_MODELS_URL, timeoutMs: 10 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('abort');
    expect((error as WatchdogFetchError).message).toContain('10ms');
  });
});

describe('fetchWithRetry', () => {
  it('retries on abort and returns the second response', async () => {
    mockFetch.mockRejectedValueOnce(asAbortError()).mockResolvedValueOnce(okResponse(validBody));

    const result = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 });

    expect(result.all).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx and returns the second response', async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(502, 'Bad Gateway'))
      .mockResolvedValueOnce(okResponse(validBody));

    const result = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 });

    expect(result.all).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    mockFetch.mockResolvedValue(errorResponse(404, 'Not Found'));

    const error = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).httpStatus).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-abort network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    const error = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('network');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows the second failure if the retry also fails', async () => {
    mockFetch.mockRejectedValueOnce(asAbortError()).mockRejectedValueOnce(asAbortError());

    const error = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(WatchdogFetchError);
    expect((error as WatchdogFetchError).kind).toBe('abort');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a defect that is not a WatchdogFetchError', async () => {
    // A body that fails JSON decoding escapes fetchLiveModelsRaw unwrapped;
    // retry classification must treat it as a defect, not a transient fault.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as Response);

    const error = await fetchWithRetry({ url: PUBLIC_MODELS_URL, timeoutMs: 1000 }).catch(
      (error_: unknown) => error_
    );

    expect(error).toBeInstanceOf(SyntaxError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
