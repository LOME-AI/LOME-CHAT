import * as React from 'react';
import { getApiUrl } from './api-url';
import type { ZodType } from 'zod';

const API_URL = getApiUrl();

export interface PublicQueryState<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
}

/**
 * Minimal data-fetching hook for the public marketing API endpoints. We
 * deliberately don't pull in TanStack Query for the marketing site — one
 * fetch on mount, no refetch, no cache invalidation, no mutations. A small
 * `useEffect` is cheaper and simpler than a 30KB library dependency.
 *
 * The response is Zod-validated client-side too as a sanity guard: if the
 * API shape drifts, the island fails closed to an error state instead of
 * rendering garbage.
 *
 * `errorLabel` names the island in error messages ("roadmap request
 * failed: 503"). Callers pass module-level constants for all three
 * arguments, so the effect runs once on mount.
 */
export function usePublicQuery<T>(
  path: string,
  schema: ZodType<T>,
  errorLabel: string
): PublicQueryState<T> {
  const [state, setState] = React.useState<PublicQueryState<T>>({
    data: null,
    error: null,
    isLoading: true,
  });

  const cancelledRef = React.useRef(false);

  React.useEffect(() => {
    cancelledRef.current = false;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${API_URL}${path}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`${errorLabel} request failed: ${String(response.status)}`);
        }
        const raw: unknown = await response.json();
        const parsed = schema.parse(raw);
        if (cancelledRef.current) return;
        setState({ data: parsed, error: null, isLoading: false });
      } catch (error) {
        if (cancelledRef.current) return;
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(`unknown ${errorLabel} error`),
          isLoading: false,
        });
      }
    })();
    return () => {
      cancelledRef.current = true;
      controller.abort();
    };
  }, [path, schema, errorLabel]);

  return state;
}
