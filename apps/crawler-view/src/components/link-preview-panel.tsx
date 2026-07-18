import { Img } from '@hushbox/ui';
import type { OpenGraphInfo } from '../engine';
import type { JSX } from 'react';

interface LinkPreviewPanelProps {
  openGraph: OpenGraphInfo;
}

function PreviewImage({ openGraph }: Readonly<LinkPreviewPanelProps>): JSX.Element {
  const { image, imageStatus } = openGraph;
  if (image === null) {
    return (
      <div className="bg-background-subtle text-muted-foreground flex h-40 items-center justify-center border-b text-sm">
        No og:image
      </div>
    );
  }
  if (imageStatus.checked && !imageStatus.reachable) {
    const reason =
      imageStatus.status === null ? 'network error' : `status ${String(imageStatus.status)}`;
    return (
      <div className="bg-error/10 text-error border-b-error/40 flex h-40 flex-col items-center justify-center gap-1 border-b text-sm">
        <span className="font-semibold">✗ Image unreachable</span>
        <span className="text-foreground text-xs">{reason}</span>
      </div>
    );
  }
  return <Img src={image} alt="Open Graph preview" className="h-40 w-full border-b object-cover" />;
}

/**
 * "Shared-link preview" - an Open Graph card mock built from the `openGraph`
 * signals, mirroring what a social/chat unfurl renders. Missing fields and an
 * unreachable image are handled explicitly.
 */
export function LinkPreviewPanel({ openGraph }: Readonly<LinkPreviewPanelProps>): JSX.Element {
  return (
    <section aria-label="Shared-link preview" className="flex flex-col gap-3">
      <h2 className="text-foreground text-sm font-semibold">Shared-link preview</h2>
      <figure className="bg-card overflow-hidden rounded-lg border">
        <PreviewImage openGraph={openGraph} />
        <figcaption className="flex flex-col gap-1 p-3">
          {openGraph.siteName === null ? null : (
            <span className="text-muted-foreground text-xs uppercase">{openGraph.siteName}</span>
          )}
          <span className="text-foreground text-sm font-semibold">
            {openGraph.title ?? '(no og:title)'}
          </span>
          <span className="text-muted-foreground text-sm">
            {openGraph.description ?? '(no og:description)'}
          </span>
          {openGraph.url === null ? null : (
            <span className="text-muted-foreground truncate font-mono text-xs">
              {openGraph.url}
            </span>
          )}
        </figcaption>
      </figure>
    </section>
  );
}
