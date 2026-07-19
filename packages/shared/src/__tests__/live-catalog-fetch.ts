/**
 * Helpers backing the live catalog drift watchdog.
 *
 * Exported separately from `live-catalog-fetch.test.ts` so the retry logic can
 * be unit-tested without hitting the real network. Production code does not
 * import from here — this is test infrastructure.
 */
import { z } from 'zod';

import { publicModelEntrySchema, type PublicModelEntry } from '../models/fetch.js';

const liveResponseSchema = z.object({
  object: z.literal('list').optional(),
  data: z.array(publicModelEntrySchema),
});

export interface FetchLiveResult {
  byId: Map<string, PublicModelEntry>;
  all: PublicModelEntry[];
}

export type WatchdogFetchErrorKind = 'abort' | 'network' | 'http' | 'schema';

/**
 * Typed error for the drift watchdog's fetch path. Structured fields let
 * `fetchWithRetry` decide whether to retry without parsing free-form messages
 * (which broke across Node and browser fetch implementations historically).
 */
export class WatchdogFetchError extends Error {
  public readonly kind: WatchdogFetchErrorKind;
  public readonly httpStatus: number | undefined;

  constructor(kind: WatchdogFetchErrorKind, httpStatus: number | undefined, message: string) {
    super(message);
    this.name = 'WatchdogFetchError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export interface FetchLiveOptions {
  url: string;
  timeoutMs: number;
}

export async function fetchLiveModelsRaw(options: FetchLiveOptions): Promise<FetchLiveResult> {
  const { url, timeoutMs } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      throw new WatchdogFetchError(
        'abort',
        undefined,
        `Live /v1/models fetch aborted after ${String(timeoutMs)}ms`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WatchdogFetchError('network', undefined, `Live /v1/models network error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new WatchdogFetchError(
      'http',
      response.status,
      `Live /v1/models returned HTTP ${String(response.status)} ${response.statusText}`
    );
  }

  const body: unknown = await response.json();
  const parsed = liveResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new WatchdogFetchError(
      'schema',
      undefined,
      `Live /v1/models response failed schema validation: ${JSON.stringify(parsed.error.issues)}`
    );
  }

  return {
    byId: new Map(parsed.data.data.map((entry) => [entry.id, entry])),
    all: parsed.data.data,
  };
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof WatchdogFetchError)) return false;
  if (error.kind === 'abort') return true;
  if (error.kind === 'http' && error.httpStatus !== undefined && error.httpStatus >= 500) {
    return true;
  }
  return false;
}

export async function fetchWithRetry(options: FetchLiveOptions): Promise<FetchLiveResult> {
  try {
    return await fetchLiveModelsRaw(options);
  } catch (error) {
    if (shouldRetry(error)) {
      return await fetchLiveModelsRaw(options);
    }
    throw error;
  }
}
