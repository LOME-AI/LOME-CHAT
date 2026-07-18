import * as React from 'react';
import { createBanner } from '@hushbox/ui/banner';
import { TEST_SIGNALS } from '@hushbox/shared';
import { useSession } from '@/lib/auth';
import { isDemoPath } from '@/lib/is-demo-path';
import {
  fetchServerDismissal,
  saveServerDismissal,
  useBannerQuery,
} from '@/hooks/announcements/use-banner';

/**
 * App-wide announcement banner (web). A thin shell: it feeds the shared
 * `createBanner` controller the fetched payload + auth state, and the controller
 * owns all markup, motion, and dismissal. Renders an empty mount node when there
 * is nothing to show, so the layout is unaffected unless a banner is active.
 */
export function AnnouncementBanner(): React.JSX.Element {
  const { data, isError } = useBannerQuery();
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = ref.current;
    // The demo boots the real route tree, so the banner would otherwise render
    // inside the marketing-site embed and deterministic captures. The demo keeps
    // the document path at `/demo` (its router runs on memory history at /chat),
    // so the document-path check — not the router location — is the reliable
    // demo signal. Leave the mount node empty and never build the controller.
    if (isDemoPath(globalThis.location.pathname)) return;
    if (root === null || data === undefined) {
      // Fetch errored with nothing cached: the "no banner" decision is final,
      // so the settled signal still fires (e2e can tell "no banner" from
      // "not loaded yet"). While loading, stay unmarked.
      if (root !== null && isError) root.setAttribute(TEST_SIGNALS.bannerSettled, 'true');
      return;
    }
    const dispose = createBanner(root, {
      data,
      isAuthenticated,
      fetchServerDismissal,
      saveServerDismissal,
    });
    // Set after createBanner so the signal means "decision applied", not just
    // "data arrived".
    root.setAttribute(TEST_SIGNALS.bannerSettled, 'true');
    return dispose;
  }, [data, isAuthenticated, isError]);

  return <div ref={ref} />;
}
