import { useEffect, useMemo, useState } from 'react';
import { AUDIENCES, type Audience, type Verdict } from '../engine';
import { fetchCrawl, type SitemapResponse } from '../app/api';
import { AUDIENCE_LABEL, worstVerdict } from '../app/verdict-utilities';
import { VerdictPill } from './verdict-pill';
import type { JSX } from 'react';

interface PageMatrixProps {
  sitemap: SitemapResponse | null;
  onSelectPage: (url: string) => void;
}

type RowState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; verdict: Record<Audience, Verdict> };

const LOADING: RowState = { status: 'loading' };

/** Small fixed pool so opening the matrix does not fire N requests at once. */
const CONCURRENCY = 4;

async function crawlRow(url: string, signal: AbortSignal): Promise<RowState> {
  const outcome = await fetchCrawl(url, signal);
  if (!outcome.ok) {
    return { status: 'error', message: outcome.message };
  }
  const verdict = {} as Record<Audience, Verdict>;
  for (const audience of AUDIENCES) {
    verdict[audience] = worstVerdict(outcome.view.verdict[audience]);
  }
  return { status: 'done', verdict };
}

async function runPool(
  urls: string[],
  signal: AbortSignal,
  onResult: (url: string, state: RowState) => void
): Promise<void> {
  let cursor = 0;
  // Read the flag through a call so TS does not carry a stale narrowing across
  // the await (the flag flips asynchronously when the caller aborts).
  const isAborted = (): boolean => signal.aborted;
  const worker = async (): Promise<void> => {
    while (cursor < urls.length && !isAborted()) {
      const url = urls[cursor++];
      if (url === undefined) {
        return;
      }
      const state = await crawlRow(url, signal);
      if (!isAborted()) {
        onResult(url, state);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
}

function MatrixCell({
  state,
  audience,
}: Readonly<{ state: RowState; audience: Audience }>): JSX.Element {
  if (state.status === 'loading') {
    return <span className="text-muted-foreground text-xs">…</span>;
  }
  if (state.status === 'error') {
    return <span className="text-error text-xs">error</span>;
  }
  return <VerdictPill level={state.verdict[audience]} />;
}

/**
 * Page x audience grid. Every sitemap page (rows) is crawled on demand when this
 * view opens; each row shows per-audience PASS/WARN/FAIL. Clicking a row loads
 * that page into the main dashboard.
 */
export function PageMatrix({ sitemap, onSelectPage }: Readonly<PageMatrixProps>): JSX.Element {
  const urls = useMemo(() => (sitemap?.targets ?? []).flatMap((target) => target.urls), [sitemap]);
  const [rows, setRows] = useState<Map<string, RowState>>(new Map());

  useEffect(() => {
    if (urls.length === 0) {
      return;
    }
    const controller = new AbortController();
    void runPool(urls, controller.signal, (url, state) => {
      setRows((previous) => new Map(previous).set(url, state));
    });
    return () => {
      controller.abort();
    };
  }, [urls]);

  if (urls.length === 0) {
    return (
      <p className="text-muted-foreground p-6 text-sm">
        No sitemap pages to compare. The web target is an SPA with no sitemap; enter URLs
        individually on the dashboard.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="text-muted-foreground pb-2 text-left text-xs">
          {urls.length} pages. Click a row to open it on the dashboard.
        </caption>
        <thead>
          <tr className="border-b text-left">
            <th className="text-muted-foreground py-2 pr-4 font-medium">Page</th>
            {AUDIENCES.map((audience) => (
              <th key={audience} className="text-muted-foreground py-2 pr-4 font-medium">
                {AUDIENCE_LABEL[audience]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {urls.map((url) => {
            const state = rows.get(url) ?? LOADING;
            return (
              <tr key={url} className="hover:bg-background-subtle border-b">
                <td className="py-1.5 pr-4">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectPage(url);
                    }}
                    className="text-foreground hover:text-primary max-w-md truncate text-left font-mono text-xs underline-offset-2 hover:underline"
                  >
                    {url}
                  </button>
                </td>
                {AUDIENCES.map((audience) => (
                  <td key={audience} className="py-1.5 pr-4">
                    <MatrixCell state={state} audience={audience} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
