import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { renderNewsletterHtml } from '@/hooks/use-newsletter';

/** Debounce for the live preview — long enough to coalesce typing, short
 * enough that the pane feels attached to the fields. */
export const PREVIEW_DEBOUNCE_MS = 300;

interface PreviewState {
  readonly html: string | null;
  readonly error: boolean;
}

/**
 * The live email preview beside the compose fields. The HTML comes verbatim
 * from the dispatch-path render endpoint — the client never renders markdown
 * itself — and is shown in a fully sandboxed iframe (`sandbox=""`: no
 * scripts, no navigation) via `srcdoc`.
 */
export function PreviewPane({
  subject,
  bodyMarkdown,
}: Readonly<{ subject: string; bodyMarkdown: string }>): React.JSX.Element {
  const [state, setState] = React.useState<PreviewState>({ html: null, error: false });
  const complete = subject.trim() !== '' && bodyMarkdown.trim() !== '';

  React.useEffect(() => {
    if (!complete) {
      setState({ html: null, error: false });
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const html = await renderNewsletterHtml({ subject, bodyMarkdown });
          if (!stale) {
            setState({ html, error: false });
          }
        } catch {
          if (!stale) {
            setState({ html: null, error: true });
          }
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [complete, subject, bodyMarkdown]);

  if (state.error) {
    return <p className="text-destructive text-sm">Failed to render the preview.</p>;
  }
  if (state.html === null) {
    return (
      <p className="text-muted-foreground text-sm">
        The email preview appears here once subject and body are filled.
      </p>
    );
  }
  return (
    <iframe
      data-testid={TEST_IDS.adminNewsletterPreview}
      title="Newsletter email preview"
      sandbox=""
      srcDoc={state.html}
      className="border-border h-full min-h-64 w-full rounded-md border bg-white"
    />
  );
}
