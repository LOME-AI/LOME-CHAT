import type { OpenGraphImageStatus } from './types';

const IMAGE_TIMEOUT_MS = 8000;

/** Statuses that mean "HEAD unsupported here" — worth one GET retry. */
const HEAD_UNSUPPORTED = new Set([405, 501]);

/**
 * Probe an og:image URL as a social crawler would to confirm it renders a card
 * preview. Tries a cheap HEAD, retries once with GET when HEAD is refused, and
 * treats any network failure as unreachable rather than throwing.
 */
export async function checkImageReachable(
  imageUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OpenGraphImageStatus> {
  try {
    const head = await fetchImpl(imageUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!HEAD_UNSUPPORTED.has(head.status)) {
      return { checked: true, reachable: head.ok, status: head.status };
    }
    const get = await fetchImpl(imageUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    return { checked: true, reachable: get.ok, status: get.status };
  } catch {
    return { checked: true, reachable: false, status: null };
  }
}
