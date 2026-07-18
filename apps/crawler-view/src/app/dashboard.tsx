import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@hushbox/ui';
import { fetchCrawl, fetchSitemap, type SitemapResponse } from './api';
import { overallVerdict } from './verdict-utilities';
import { UrlBar } from '../components/url-bar';
import { VerdictBanner } from '../components/verdict-banner';
import { VerdictPill } from '../components/verdict-pill';
import { AnswerBotPanel } from '../components/answer-bot-panel';
import { LinkPreviewPanel } from '../components/link-preview-panel';
import { SignalTabs } from '../components/signal-tabs';
import { PageMatrix } from '../components/page-matrix';
import { IdleState, LoadingState, ErrorState } from '../components/states';
import { CrossPortNav } from '../components/cross-port-nav';
import type { CrawlView } from '../engine';
import type { JSX } from 'react';

type CrawlState =
  | { kind: 'idle' }
  | { kind: 'loading'; url: string }
  | { kind: 'result'; view: CrawlView }
  | { kind: 'error'; code: string; message: string };

type ViewMode = 'dashboard' | 'matrix';

function readUrlParameter(): string | null {
  const parameter = new URLSearchParams(globalThis.location.search).get('url');
  return parameter !== null && parameter.trim().length > 0 ? parameter.trim() : null;
}

/** Reflect the analyzed URL into `?url=` so the view is shareable / deep-linkable. */
function writeUrlParameter(url: string): void {
  const shareable = new URL(globalThis.location.href);
  shareable.searchParams.set('url', url);
  globalThis.history.replaceState(null, '', shareable.toString());
}

function ResultView({ view }: Readonly<{ view: CrawlView }>): JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center gap-3">
        <VerdictPill level={overallVerdict(view.verdict)} />
        <span className="text-muted-foreground truncate font-mono text-xs">{view.url}</span>
      </div>
      <VerdictBanner verdict={view.verdict} />
      <div className="grid gap-6 lg:grid-cols-2">
        <AnswerBotPanel content={view.content} />
        <LinkPreviewPanel openGraph={view.openGraph} />
      </div>
      <SignalTabs view={view} />
    </div>
  );
}

function DashboardBody({ crawl }: Readonly<{ crawl: CrawlState }>): JSX.Element {
  if (crawl.kind === 'loading') {
    return <LoadingState url={crawl.url} />;
  }
  if (crawl.kind === 'error') {
    return <ErrorState code={crawl.code} message={crawl.message} />;
  }
  if (crawl.kind === 'result') {
    return <ResultView view={crawl.view} />;
  }
  return <IdleState />;
}

/** The unified crawler-view dashboard: input, verdict, consumption panels, signals. */
export function Dashboard(): JSX.Element {
  // Read the deep-link once so the initial render already shows the loading
  // state for it, keeping the fetch (below) the effect's only side effect.
  const [initialUrl] = useState(readUrlParameter);
  const [inputValue, setInputValue] = useState(initialUrl ?? '');
  const [crawl, setCrawl] = useState<CrawlState>(
    initialUrl === null ? { kind: 'idle' } : { kind: 'loading', url: initialUrl }
  );
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard');
  const [sitemap, setSitemap] = useState<SitemapResponse | null>(null);
  const [sitemapError, setSitemapError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const runCrawl = useCallback(async (url: string, signal: AbortSignal): Promise<void> => {
    const outcome = await fetchCrawl(url, signal);
    if (signal.aborted) {
      return;
    }
    setCrawl(
      outcome.ok
        ? { kind: 'result', view: outcome.view }
        : { kind: 'error', code: outcome.code, message: outcome.message }
    );
  }, []);

  const analyze = useCallback(
    (url: string): void => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setInputValue(url);
      setViewMode('dashboard');
      setCrawl({ kind: 'loading', url });
      writeUrlParameter(url);
      void runCrawl(url, controller.signal);
    },
    [runCrawl]
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await fetchSitemap(controller.signal);
        if (!controller.signal.aborted) {
          setSitemap(data);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSitemapError(error instanceof Error ? error.message : 'unknown error');
        }
      }
    })();
    if (initialUrl !== null) {
      const crawlController = new AbortController();
      requestRef.current = crawlController;
      writeUrlParameter(initialUrl);
      void (async () => {
        const outcome = await fetchCrawl(initialUrl, crawlController.signal);
        if (!crawlController.signal.aborted) {
          setCrawl(
            outcome.ok
              ? { kind: 'result', view: outcome.view }
              : { kind: 'error', code: outcome.code, message: outcome.message }
          );
        }
      })();
    }
    return () => {
      controller.abort();
    };
  }, [initialUrl]);

  const webOrigin = sitemap?.targets.find((target) => target.label === 'web')?.origin;

  return (
    <main className="bg-background text-foreground flex h-full flex-col">
      <header data-chrome="" className="flex flex-col gap-3 border-b p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-foreground text-lg font-semibold">Crawler View</h1>
            <p className="text-muted-foreground text-sm">What a no-JavaScript crawler sees</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CrossPortNav webOrigin={webOrigin} inspectedUrl={inputValue} />
            <nav data-chrome="" className="flex items-center gap-1">
              {(['dashboard', 'matrix'] as const).map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  size="sm"
                  variant={viewMode === mode ? 'default' : 'secondary'}
                  onClick={() => {
                    setViewMode(mode);
                  }}
                >
                  {mode === 'matrix' ? 'Page matrix' : 'Dashboard'}
                </Button>
              ))}
            </nav>
          </div>
        </div>
        <UrlBar
          value={inputValue}
          onChange={setInputValue}
          onAnalyze={analyze}
          sitemap={sitemap}
          sitemapError={sitemapError}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {viewMode === 'matrix' ? (
          <div className="p-4">
            <PageMatrix sitemap={sitemap} onSelectPage={analyze} />
          </div>
        ) : (
          <DashboardBody crawl={crawl} />
        )}
      </div>
    </main>
  );
}
