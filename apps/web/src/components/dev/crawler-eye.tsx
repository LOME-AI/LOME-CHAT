import { useLocation } from '@tanstack/react-router';
import { CrawlerEye as CrawlerEyeBadge } from '@hushbox/ui';
import { env } from '@/lib/env';
import { crawlerViewOrigin } from '@/lib/crawler-view';
import type * as React from 'react';

/**
 * Web mount for the dev-only crawler-eye badge (the shared `@hushbox/ui` badge).
 *
 * Gated on `env.isDevServer` — a real interactive `pnpm dev` session, never
 * under E2E, vitest, or production. Existence is decided by the environment, not
 * by whether an env var is set; the badge's `/api/crawl` fetch would trip the
 * app CSP, so it must not fire in an E2E build (which is dev-mode and bakes
 * `VITE_CRAWLER_VIEW_URL`). Keyed by the router location so the badge remounts
 * and re-audits on SPA navigation.
 */
export function CrawlerEye(): React.JSX.Element | null {
  // Decide existence by environment before touching any hook: outside a real
  // dev server (vitest, E2E, production) the badge is inert and must not depend
  // on router context, which the `__root` unit render does not provide.
  if (!env.isDevServer) {
    return null;
  }
  return <CrawlerEyeBadgeMount />;
}

function CrawlerEyeBadgeMount(): React.JSX.Element {
  const location = useLocation();
  return <CrawlerEyeBadge key={location.href} origin={crawlerViewOrigin()} />;
}
