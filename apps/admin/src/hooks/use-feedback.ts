import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  feedbackInboxWireSchema,
  feedbackDetailWireSchema,
  type FeedbackInboxWire,
  type FeedbackDetailWire,
  type FeedbackStatus,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

/** The inbox's only filter dimension: the triage status, or all statuses. */
export interface FeedbackFilter {
  readonly status?: FeedbackStatus | undefined;
}

export const feedbackKeys = {
  all: ['admin', 'feedback'] as const,
  inbox: (filter: FeedbackFilter) =>
    ['admin', 'feedback', 'inbox', filter.status ?? 'all'] as const,
  detail: (id: string) => ['admin', 'feedback', 'detail', id] as const,
};

// Each page is re-validated with the shared wire schema (the web app's
// response re-validation mechanic) so a drifting API shape fails the query
// loudly instead of rendering a garbage inbox.
async function fetchInboxPage(
  filter: FeedbackFilter,
  cursor: string | undefined
): Promise<FeedbackInboxWire> {
  const raw = await fetchJson<unknown>(
    client.admin.feedback.$get({
      query: {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
  );
  return feedbackInboxWireSchema.parse(raw);
}

export function useFeedbackInbox(
  filter: FeedbackFilter
): UseInfiniteQueryResult<InfiniteData<FeedbackInboxWire>> {
  return useInfiniteQuery({
    queryKey: feedbackKeys.inbox(filter),
    queryFn: ({ pageParam }) => fetchInboxPage(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// The detail read is re-validated too; it carries the full body the inbox
// preview never sends.
async function fetchDetail(id: string): Promise<FeedbackDetailWire> {
  const raw = await fetchJson<unknown>(client.admin.feedback[':id'].$get({ param: { id } }));
  return feedbackDetailWireSchema.parse(raw);
}

export function useFeedbackDetail(id?: string): UseQueryResult<FeedbackDetailWire> {
  return useQuery({
    queryKey: feedbackKeys.detail(id ?? ''),
    // The id is read back from the (always-string) query key so the enabled
    // guard fully accounts for the undefined case — no dead default here.
    queryFn: ({ queryKey }) => fetchDetail(queryKey[3]),
    enabled: id !== undefined,
  });
}
