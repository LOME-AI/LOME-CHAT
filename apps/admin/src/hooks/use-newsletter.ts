import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';
import {
  newsletterIssuesWireSchema,
  newsletterStatsWireSchema,
  newsletterSubscribersWireSchema,
  type NewsletterIssuesWire,
  type NewsletterStatsWire,
  type NewsletterStatus,
  type NewsletterSubscribersWire,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

// Every response is re-validated with the shared wire schemas (the web app's
// response re-validation mechanic) so a drifting API shape fails the query
// loudly instead of rendering a garbage screen.

/** The subscribers list's only filter dimension: the lifecycle status, or all. */
export interface NewsletterSubscriberFilter {
  readonly status?: NewsletterStatus | undefined;
}

export const newsletterKeys = {
  all: ['admin', 'newsletter'] as const,
  issues: () => ['admin', 'newsletter', 'issues'] as const,
  stats: () => ['admin', 'newsletter', 'stats'] as const,
  subscribers: (filter: NewsletterSubscriberFilter) =>
    ['admin', 'newsletter', 'subscribers', filter.status ?? 'all'] as const,
};

async function fetchIssuesPage(cursor: string | undefined): Promise<NewsletterIssuesWire> {
  const raw = await fetchJson<unknown>(
    client.admin.newsletter.issues.$get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
    })
  );
  return newsletterIssuesWireSchema.parse(raw);
}

export function useNewsletterIssues(): UseInfiniteQueryResult<InfiniteData<NewsletterIssuesWire>> {
  return useInfiniteQuery({
    queryKey: newsletterKeys.issues(),
    queryFn: ({ pageParam }) => fetchIssuesPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

async function fetchStats(): Promise<NewsletterStatsWire> {
  const raw = await fetchJson<unknown>(client.admin.newsletter.subscribers.stats.$get());
  return newsletterStatsWireSchema.parse(raw);
}

export function useNewsletterStats(): UseQueryResult<NewsletterStatsWire> {
  return useQuery({ queryKey: newsletterKeys.stats(), queryFn: fetchStats });
}

async function fetchSubscribersPage(
  filter: NewsletterSubscriberFilter,
  cursor: string | undefined
): Promise<NewsletterSubscribersWire> {
  const raw = await fetchJson<unknown>(
    client.admin.newsletter.subscribers.$get({
      query: {
        ...(filter.status === undefined ? {} : { status: filter.status }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    })
  );
  return newsletterSubscribersWireSchema.parse(raw);
}

/**
 * The audited consent-evidence list. `enabled` is the caller's explicit
 * user-initiated gate — every page load writes an audit row server-side, so
 * this query must never auto-fire on screen mount.
 */
export function useNewsletterSubscribers(
  filter: NewsletterSubscriberFilter,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<NewsletterSubscribersWire>> {
  return useInfiniteQuery({
    queryKey: newsletterKeys.subscribers(filter),
    queryFn: ({ pageParam }) => fetchSubscribersPage(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

export interface NewsletterDraft {
  readonly subject: string;
  readonly bodyMarkdown: string;
}

const renderResponseSchema = z.object({ html: z.string() });

/**
 * Dispatch-path preview render: the endpoint runs the exact HTML pipeline a
 * real send uses (inert '#' unsubscribe link included); the client never
 * renders markdown itself. A pure read over POST, but it rides the universal
 * mutation-route Idempotency-Key demand — a fresh random key per request,
 * since every preview is a distinct render, never a replay.
 */
export async function renderNewsletterHtml(draft: NewsletterDraft): Promise<string> {
  const raw = await fetchJson<unknown>(
    client.admin.newsletter.render.$post(
      { json: draft },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    )
  );
  return renderResponseSchema.parse(raw).html;
}
