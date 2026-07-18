import { cn } from '@hushbox/ui/lib/utils';
import { MIN_CRAWLABLE_WORDS, type ContentInfo } from '../engine';
import type { JSX } from 'react';

interface AnswerBotPanelProps {
  content: ContentInfo;
}

function HeadingOutline({ content }: Readonly<AnswerBotPanelProps>): JSX.Element {
  if (content.headingOutline.length === 0) {
    return <p className="text-muted-foreground text-sm">No headings found.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {content.headingOutline.map((heading, index) => (
        <li key={`${String(heading.level)}-${String(index)}`} className="text-foreground text-sm">
          <span className="text-muted-foreground mr-2 font-mono text-xs">H{heading.level}</span>
          <span className={cn(heading.level === 1 ? 'font-semibold' : '', 'align-middle')}>
            {heading.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "What answer bots read" - the plain-text and heading outline a no-JS AI/search
 * crawler ingests. When the word count is near zero, the emptiness is made
 * visually loud: this is the SPA-shell failure the whole tool exists to expose.
 */
export function AnswerBotPanel({ content }: Readonly<AnswerBotPanelProps>): JSX.Element {
  const isEmpty = content.wordCount < MIN_CRAWLABLE_WORDS;
  return (
    <section aria-label="What answer bots read" className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-foreground text-sm font-semibold">What answer bots read</h2>
        <span
          className={cn(
            'rounded-md border px-2 py-0.5 text-xs font-semibold',
            isEmpty ? 'bg-error/10 border-error/40 text-error' : 'text-muted-foreground'
          )}
        >
          {content.wordCount} words
        </span>
      </div>

      {isEmpty ? (
        <div className="bg-error/10 border-error/40 text-error rounded-lg border p-3 text-sm">
          <p className="font-semibold">✗ Near-empty page for no-JavaScript crawlers.</p>
          <p className="text-foreground mt-1">
            Only {content.wordCount} words of crawlable text were found. AI and search bots that do
            not run JavaScript receive a blank shell here.
          </p>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-col gap-1">
        <h3 className="text-muted-foreground text-xs font-medium uppercase">Heading outline</h3>
        <HeadingOutline content={content} />
      </div>

      <div className="flex min-h-0 flex-col gap-1">
        <h3 className="text-muted-foreground text-xs font-medium uppercase">Extracted text</h3>
        <pre className="bg-background-subtle text-foreground max-h-64 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
          {content.textBlob.trim().length > 0 ? content.textBlob : '(no text extracted)'}
        </pre>
      </div>
    </section>
  );
}
