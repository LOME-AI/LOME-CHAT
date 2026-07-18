import * as React from 'react';

/**
 * Dev-only "crawler-eye" badge — a small fixed-corner status dot for the CURRENT
 * page derived from the crawler-view dev tool's `/api/crawl` verdict (🟢 all
 * audiences pass · 🟡 some warn · 🔴 any fail); clicking opens the crawler-view
 * dashboard focused on this URL.
 *
 * Pure and environment-agnostic: it takes the crawler-view `origin` and always
 * renders. Each host app decides *whether* to mount it — the web SPA gates on
 * `env.isDevServer` at runtime; the marketing (Astro/SSG) site gates on a
 * build-time constant so the island is stripped from non-dev builds entirely.
 * The badge re-audits on mount; SPA callers remount it (via a `key`) on route
 * change. A fetch failure (server not running) degrades to a muted "offline"
 * dot and never surfaces an error on the host page.
 */

type Level = 'pass' | 'warn' | 'fail';

/** Minimal shape of the crawler-view `CrawlView` response we consume. */
interface CrawlVerdict {
  verdict: Record<'ai' | 'search' | 'social', readonly { level: Level }[]>;
}

type DotState = 'loading' | 'offline' | 'pass' | 'warn' | 'fail';

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

export interface CrawlerEyeProps {
  /** crawler-view origin, e.g. `http://localhost:7200`. */
  origin: string;
}

export function CrawlerEye({ origin }: Readonly<CrawlerEyeProps>): React.JSX.Element {
  const [state, setState] = React.useState<DotState>('loading');
  const [counts, setCounts] = React.useState<{ fail: number; warn: number }>({ fail: 0, warn: 0 });

  React.useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    const target = globalThis.location.href;
    void (async () => {
      try {
        const res = await fetch(`${origin}/api/crawl?url=${encodeURIComponent(target)}`, {
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
  }, [origin]);

  const dotClass = DOT[state];
  const label = labelFor(state, counts);

  return (
    <button
      type="button"
      onClick={() => {
        window.open(
          `${origin}/?url=${encodeURIComponent(globalThis.location.href)}`,
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
