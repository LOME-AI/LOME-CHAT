import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { jobQueueWireSchema, type JobQueueWire } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

/** The server's queue-filter statuses; `discarded` selects marked dead rows. */
export type JobStatusFilter =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'cancelled'
  | 'dead'
  | 'discarded';

export interface JobsFilter {
  readonly status?: JobStatusFilter | undefined;
  readonly type?: string | undefined;
}

export const jobsKeys = {
  all: ['admin', 'jobs'] as const,
  list: (filter: JobsFilter) =>
    ['admin', 'jobs', filter.status ?? 'all', filter.type ?? ''] as const,
};

// Each page is re-validated with the shared wire schema (the web app's
// response re-validation mechanic) so a drifting API shape fails the query
// loudly instead of rendering a garbage queue.
async function fetchJobsPage(
  filter: JobsFilter,
  cursor: string | undefined
): Promise<JobQueueWire> {
  const raw = await fetchJson<unknown>(
    client.admin.jobs.$get({
      query: {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(filter.type === undefined || filter.type === '' ? {} : { type: filter.type }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
  );
  return jobQueueWireSchema.parse(raw);
}

export function useJobsQueue(
  filter: JobsFilter
): UseInfiniteQueryResult<InfiniteData<JobQueueWire>> {
  return useInfiniteQuery({
    queryKey: jobsKeys.list(filter),
    queryFn: ({ pageParam }) => fetchJobsPage(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
