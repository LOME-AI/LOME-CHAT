import * as React from 'react';
import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';

const API_URL = ((): string => {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (typeof fromEnv !== 'string' || fromEnv.length === 0) {
    throw new Error(
      'VITE_API_URL is required for the roadmap React island. Check envConfig and run pnpm generate:env.'
    );
  }
  return fromEnv;
})();

export interface RoadmapQueryState {
  data: RoadmapResponse | null;
  error: Error | null;
  isLoading: boolean;
}

/**
 * Minimal data-fetching hook for the /public/roadmap endpoint. We deliberately
 * don't pull in TanStack Query for the marketing site — one fetch on mount,
 * no refetch, no cache invalidation, no mutations. A 14-line `useEffect` is
 * cheaper and simpler than a 30KB library dependency.
 *
 * Response is Zod-validated client-side too as a sanity guard: if the API
 * shape drifts, the UI fails closed to an error state instead of rendering
 * garbage positions.
 */
export function useRoadmapQuery(): RoadmapQueryState {
  const [state, setState] = React.useState<RoadmapQueryState>({
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
        const response = await fetch(`${API_URL}/public/roadmap`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`roadmap request failed: ${String(response.status)}`);
        const raw: unknown = await response.json();
        const parsed = roadmapResponseSchema.parse(raw);
        if (cancelledRef.current) return;
        setState({ data: parsed, error: null, isLoading: false });
      } catch (error) {
        if (cancelledRef.current) return;
        setState({
          data: null,
          error: error instanceof Error ? error : new Error('unknown roadmap error'),
          isLoading: false,
        });
      }
    })();
    return () => {
      cancelledRef.current = true;
      controller.abort();
    };
  }, []);

  return state;
}
