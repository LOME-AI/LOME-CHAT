import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { z } from 'zod';
import { bannerResponseSchema, type BannerResponse } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

// The banner payload is re-validated with the shared schema (the same fail-closed
// guard the marketing roadmap island uses) so a drifting API shape degrades to
// "no banner" rather than rendering garbage.
const dismissalSchema = z.object({ dismissed: z.boolean() });

async function fetchBanner(): Promise<BannerResponse> {
  const raw = await fetchJson<unknown>(client.announcements.banner.$get());
  return bannerResponseSchema.parse(raw);
}

export function useBannerQuery(): UseQueryResult<BannerResponse> {
  return useQuery({
    queryKey: ['announcements', 'banner'] as const,
    queryFn: fetchBanner,
    staleTime: 1000 * 60 * 5,
  });
}

/** Authed cross-device read; called only when the local dismissal key is absent. */
export async function fetchServerDismissal(hash: string): Promise<boolean> {
  try {
    const raw = await fetchJson<unknown>(
      client.announcements.banner.dismissal.$get({ query: { hash } })
    );
    const parsed = dismissalSchema.safeParse(raw);
    return parsed.success && parsed.data.dismissed;
  } catch {
    return false;
  }
}

/** Fire-and-forget authed persist on dismiss; the local key is already written. */
export function saveServerDismissal(hash: string): void {
  void (async (): Promise<void> => {
    try {
      await fetchJson(client.announcements.banner.dismissal.$put({ json: { hash } }));
    } catch {
      // Best-effort: local dismissal persists regardless.
    }
  })();
}
