import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '@hushbox/ui';
import type { JSX } from 'react';

interface CrossPortNavProps {
  /** Origin of the `web` target (from `/api/sitemap`); undefined when absent. */
  webOrigin: string | undefined;
  /** The currently-inspected absolute URL, or '' when nothing is analyzed yet. */
  inspectedUrl: string;
}

/**
 * Header controls that cross the crawler-view port back to the product: a
 * same-tab link to the web app's `/chat`, and a new-tab opener for the page
 * currently under inspection. Both degrade to a disabled control rather than a
 * broken link when their target is unavailable.
 */
export function CrossPortNav({
  webOrigin,
  inspectedUrl,
}: Readonly<CrossPortNavProps>): JSX.Element {
  const trimmedUrl = inspectedUrl.trim();
  const canOpen = trimmedUrl.length > 0;

  return (
    <nav
      data-chrome=""
      aria-label="Cross-port navigation"
      className="flex flex-wrap items-center gap-1"
    >
      {webOrigin === undefined ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled
          title="Web app origin unavailable"
        >
          <ArrowLeft aria-hidden="true" />
          Back to /chat
        </Button>
      ) : (
        <Button asChild size="sm" variant="secondary">
          <a href={`${webOrigin}/chat`}>
            <ArrowLeft aria-hidden="true" />
            Back to /chat
          </a>
        </Button>
      )}

      {canOpen ? (
        <Button asChild size="sm" variant="secondary">
          <a href={trimmedUrl} target="_blank" rel="noreferrer noopener">
            Open inspected page
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      ) : (
        <Button type="button" size="sm" variant="secondary" disabled title="Analyze a page first">
          Open inspected page
          <ExternalLink aria-hidden="true" />
        </Button>
      )}
    </nav>
  );
}
