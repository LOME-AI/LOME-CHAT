import { useMemo } from 'react';
import type { ContentInfo } from '../engine';
import type { JSX } from 'react';

interface CrawlerFrameProps {
  content: ContentInfo;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The no-JS crawler view. The API contract does not expose the raw source HTML,
 * so this reconstructs the page from the engine-captured content (heading
 * outline + extracted text) and renders it in a sandboxed iframe WITHOUT
 * `allow-scripts`. When the page is an empty SPA shell, this frame renders
 * visibly empty, which is exactly the failure the tool surfaces.
 */
export function CrawlerFrame({ content }: Readonly<CrawlerFrameProps>): JSX.Element {
  const sourceDocument = useMemo(() => {
    const headings = content.headingOutline
      .map((heading) => {
        const level = String(heading.level);
        return `<h${level}>${escapeHtml(heading.text)}</h${level}>`;
      })
      .join('\n');
    const body = content.textBlob.trim().length > 0 ? `<p>${escapeHtml(content.textBlob)}</p>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"></head><body>${headings}${body}</body></html>`;
  }, [content]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Reconstructed from the engine-captured no-JavaScript content (the API does not expose raw
        source). An empty frame means a no-JS crawler receives a blank page.
      </p>
      <iframe
        title="No-JavaScript crawler view"
        sandbox=""
        srcDoc={sourceDocument}
        className="bg-background h-96 w-full rounded-lg border"
      />
    </div>
  );
}
