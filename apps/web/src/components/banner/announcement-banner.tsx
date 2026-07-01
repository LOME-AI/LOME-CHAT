import * as React from 'react';
import { createBanner } from '@hushbox/ui/banner';
import { useSession } from '@/lib/auth';
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
  const { data } = useBannerQuery();
  const { data: session } = useSession();
  const isAuthenticated = Boolean(session?.user);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const root = ref.current;
    if (root === null || data === undefined) return;
    return createBanner(root, { data, isAuthenticated, fetchServerDismissal, saveServerDismissal });
  }, [data, isAuthenticated]);

  return <div ref={ref} />;
}
