import * as React from 'react';
import { useLocation } from '@tanstack/react-router';
import { env } from '@/lib/env';

/**
 * Dev-only "crawler-eye" badge. Renders a small fixed-corner status dot for the
 * CURRENT page derived from the crawler-view dev tool's `/api/crawl` verdict
 * (🟢 all audiences pass · 🟡 some warn · 🔴 any fail), and opens the
 * crawler-view dashboard focused on this URL when clicked.
 *
 * Gated on `env.isDev` (the same gate the `dev.*` routes use) AND on the
 * dev-only `VITE_CRAWLER_VIEW_URL` env var, so it is absent from production
 * builds (`MODE=production` ⇒ `isDev=false`) and tree-shaken when the gate is a
 * build-time constant. crawler-view is a local tooling server that is never
 * deployed; a fetch failure (server not running) degrades to a muted "offline"
 * dot and never errors the page.
 */

type Level = 'pass' | 'warn' | 'fail';

/** Minimal shape of the crawler-view `CrawlView` response we consume. */
interface CrawlVerdict {
  verdict: Record<'ai' | 'search' | 'social', readonly { level: Level }[]>;
}

type DotState = 'loading' | 'offline' | 'pass' | 'warn' | 'fail';

// Read once at module load: a dev-only var with no production value, so this is
// `undefined` (and the badge never renders) outside dev.
const crawlerViewUrl = import.meta.env['VITE_CRAWLER_VIEW_URL'] as string | undefined;

const DOT: Record<DotState, string> = {
  loading: 'bg-muted-foreground',
  offline: 'bg-muted-foreground/40',
  pass: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-destructive',
};

function labelFor(state: DotState, counts: { fail: number; warn: number }): string {
  switch (state) {
    case 'loading': {
      return 'Crawler visibility: checking current page';
    }
    case 'offline': {
      return 'Crawler visibility: crawler-view server offline';
    }
    case 'pass': {
      return 'Crawler visibility: all audiences pass';
    }
    case 'warn': {
      return `Crawler visibility: ${String(counts.warn)} warning${counts.warn === 1 ? '' : 's'}`;
    }
    case 'fail': {
      return `Crawler visibility: ${String(counts.fail)} failure${counts.fail === 1 ? '' : 's'}`;
    }
  }
}

export function CrawlerEye(): React.JSX.Element | null {
  // Subscribe to router location so the badge re-audits on every route change.
  const location = useLocation();
  const [state, setState] = React.useState<DotState>('loading');
  const [counts, setCounts] = React.useState<{ fail: number; warn: number }>({ fail: 0, warn: 0 });

  React.useEffect(() => {
    if (!env.isDev || crawlerViewUrl === undefined) {
      return;
    }
    const controller = new AbortController();
    setState('loading');
    const target = globalThis.location.href;
    void (async () => {
      try {
        // crawler-view is an external dev-only tooling server, not an api-client
        // endpoint, so the typed-client + TanStack Query rule does not apply; this
        // badge is stripped from production builds.
        // eslint-disable-next-line no-restricted-globals -- see comment above
        const res = await fetch(`${crawlerViewUrl}/api/crawl?url=${encodeURIComponent(target)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`crawl ${String(res.status)}`);
        }
        const raw: unknown = await res.json();
        const findings = Object.values((raw as CrawlVerdict).verdict).flat();
        setCounts({
          fail: findings.filter((f) => f.level === 'fail').length,
          warn: findings.filter((f) => f.level === 'warn').length,
        });
        if (findings.some((f) => f.level === 'fail')) {
          setState('fail');
        } else if (findings.some((f) => f.level === 'warn')) {
          setState('warn');
        } else {
          setState('pass');
        }
      } catch {
        // Server not running / unreachable — degrade to a muted dot, never
        // surface an error on the host page.
        if (!controller.signal.aborted) {
          setState('offline');
        }
      }
    })();
    return () => {
      controller.abort();
    };
  }, [location.href]);

  if (!env.isDev || crawlerViewUrl === undefined) {
    return null;
  }

  const dotClass = DOT[state];
  const label = labelFor(state, counts);

  return (
    <button
      type="button"
      onClick={() => {
        window.open(
          `${crawlerViewUrl}/?url=${encodeURIComponent(globalThis.location.href)}`,
          '_blank',
          'noopener'
        );
      }}
      aria-label={label}
      title={label}
      className="border-border bg-card text-foreground focus-visible:border-ring focus-visible:ring-ring/50 z-toast fixed top-2 right-2 inline-flex cursor-pointer items-center rounded-full border p-1.5 shadow-sm outline-none focus-visible:ring-[3px]"
    >
      {/* Colored status dot; the full state text lives in the aria-label/title
          (tooltip), so the badge reads for screen readers and on hover without a
          glyph that looks like a dismiss control. Static, so no reduced-motion
          concern. */}
      <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
    </button>
  );
}
