import { useQuery } from '@tanstack/react-query';
import { MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';

interface DownloadUrlResponse {
  downloadUrl: string;
  expiresAt: string;
}

export const mediaKeys = {
  all: ['media'] as const,
  downloadUrl: (contentItemId: string) => [...mediaKeys.all, 'downloadUrl', contentItemId] as const,
};

/** Refresh the URL 1 minute before it expires to avoid a stale-URL fetch. */
const TTL_REFRESH_MARGIN_SECONDS = 60;

/**
 * Fetches a short-lived presigned GET URL for a media content item.
 * Cache is stale after the URL's TTL; refetch mints a fresh URL.
 */
export function useMediaDownloadUrl(contentItemId: string | null): {
  downloadUrl: string | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { data, isLoading, error } = useQuery({
    queryKey: contentItemId ? mediaKeys.downloadUrl(contentItemId) : ['media', 'noop'],
    queryFn: async (): Promise<DownloadUrlResponse> => {
      if (!contentItemId) throw new Error('contentItemId is required');
      return fetchJson<DownloadUrlResponse>(
        client.media[':contentItemId']['download-url'].$get({
          param: { contentItemId },
        })
      );
    },
    enabled: !!contentItemId,
    staleTime: (MEDIA_DOWNLOAD_URL_TTL_SECONDS - TTL_REFRESH_MARGIN_SECONDS) * 1000,
    gcTime: MEDIA_DOWNLOAD_URL_TTL_SECONDS * 1000,
  });

  return {
    downloadUrl: data?.downloadUrl,
    isLoading,
    error: error ?? null,
  };
}
