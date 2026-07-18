import * as React from 'react';
import { getApiUrl } from '../../lib/api-url';

export type TokenActionStatus = 'missing' | 'pending' | 'success' | 'error';

export interface TokenActionState {
  status: TokenActionStatus;
  /** API error code from the failure body, when it provided one. */
  code: string | null;
}

/**
 * Shared engine for the confirm/unsubscribe link-landing pages: reads
 * `?token` from the URL on mount and POSTs it once to the given path.
 * `missing` (no token, no request) is distinct from `error` so the pages
 * can render a neutral state instead of an accusatory one.
 */
export function useTokenAction(path: string): TokenActionState {
  // Starts pending unconditionally: the URL is only readable client-side, and
  // Astro server-renders this island's HTML, where `location` does not exist.
  const [state, setState] = React.useState<TokenActionState>({ status: 'pending', code: null });

  React.useEffect(() => {
    const token = new URLSearchParams(globalThis.location.search).get('token');
    if (token === null || token === '') {
      setState({ status: 'missing', code: null });
      return;
    }
    // Per-run cancellation: each effect run captures its own flag, so a
    // response from a superseded run can never overwrite a newer run's
    // state. Boxed in an object because TS narrows a plain `let` to its
    // initial value inside the closure below.
    const run = { cancelled: false };
    void (async (): Promise<void> => {
      let next: TokenActionState;
      try {
        const response = await fetch(`${getApiUrl()}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (response.ok) {
          next = { status: 'success', code: null };
        } else {
          let code: string | null = null;
          try {
            const body: unknown = await response.json();
            if (
              typeof body === 'object' &&
              body !== null &&
              'code' in body &&
              typeof body.code === 'string'
            ) {
              code = body.code;
            }
          } catch {
            // Non-JSON failure body; fall through to the generic message.
          }
          next = { status: 'error', code };
        }
      } catch {
        next = { status: 'error', code: null };
      }
      if (!run.cancelled) setState(next);
    })();
    return (): void => {
      run.cancelled = true;
    };
  }, [path]);

  return state;
}
