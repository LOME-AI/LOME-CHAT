import * as React from 'react';
import { Streamdown } from 'streamdown';
import { mermaid } from '@streamdown/mermaid';
import { math } from '@streamdown/math';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { safeCode } from '@/components/chat/message/code-plugin';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { DocumentCard } from '@/components/chat/media/document-card';
import {
  extractTitle,
  generateDocumentId,
  getDocumentType,
  shouldExtractAsDocument,
} from '@/lib/document-parser';
import type { Components } from 'streamdown';
import type { Document } from '@/lib/document-parser';

/** Minimal HAST node types (avoids @types/hast dependency) */
interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

type HastNode = HastText | HastElement;

interface MarkdownRendererProps {
  content: string;
  className?: string;
  /** Whether the message is currently streaming */
  isStreaming?: boolean | undefined;
}

/** Extract text content from a HAST (HTML AST) node tree */
function extractTextFromHast(node: HastNode): string {
  if (node.type === 'text') {
    return node.value;
  }
  /* v8 ignore next 4 -- Streamdown's safe pipeline only emits text/element nodes; the childless-non-text fallback guards a node shape that never reaches here */
  if ('children' in node) {
    return node.children.map((child) => extractTextFromHast(child)).join('');
  }
  return '';
}

interface CodeBlockMeta {
  language: string;
  codeText: string;
  lineCount: number;
}

function extractLanguageFromCodeNode(codeNode: HastElement): string | undefined {
  const classNames = codeNode.properties?.['className'];
  const rawClass: unknown = Array.isArray(classNames) ? classNames[0] : classNames;
  if (typeof rawClass !== 'string') return undefined;
  return /language-([\w-]+)/.exec(rawClass)?.[1];
}

function extractCodeBlockMeta(node: HastElement | undefined): CodeBlockMeta | undefined {
  const codeNode = node?.children[0];
  /* v8 ignore next -- a Streamdown <pre> always wraps a <code> element, so the non-code first-child guard is unreachable */
  if (codeNode?.type !== 'element' || codeNode.tagName !== 'code') return undefined;
  const language = extractLanguageFromCodeNode(codeNode);
  if (!language) return undefined;
  const codeText = extractTextFromHast(codeNode).replace(/\n$/, '');
  const lineCount = codeText.split('\n').length;
  return { language, codeText, lineCount };
}

// Carried by context rather than closed over: `components` stays referentially
// stable (Streamdown re-renders every block when it changes), while context
// updates still reach each block through those memo boundaries.
const MessageStreamingContext = React.createContext(false);

/**
 * Intercepts document-worthy code blocks before Streamdown's own code block
 * renders. Streamdown's default `pre` adds `data-block="true"` to its children,
 * which MarkdownCode uses to tell block from inline code.
 */
function MarkdownPre({
  children,
  node,
}: Readonly<{ children?: React.ReactNode; node?: HastElement | undefined }>): React.JSX.Element {
  const isStreaming = React.useContext(MessageStreamingContext);
  const meta = extractCodeBlockMeta(node);

  if (meta && shouldExtractAsDocument(meta.language, meta.lineCount)) {
    const type = getDocumentType(meta.language);
    const document_: Document = {
      id: generateDocumentId(meta.codeText),
      type,
      language: meta.language,
      title: extractTitle(meta.codeText, meta.language, type),
      content: meta.codeText,
      lineCount: meta.lineCount,
      isStreaming,
    };

    return <DocumentCard document={document_} />;
  }

  /* v8 ignore next 7 -- Streamdown always passes the <code> element as pre children, so the non-element fallback branch is unreachable */
  return React.isValidElement(children) ? (
    React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      'data-block': 'true',
    })
  ) : (
    <>{children}</>
  );
}

function MarkdownRenderFallback({ content }: Readonly<{ content: string }>): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.markdownRenderFallback}>
      <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{content}</p>
      <p className="text-muted-foreground mt-2 text-xs">Message formatting unavailable.</p>
    </div>
  );
}

export function MarkdownRenderer({
  content,
  className,
  isStreaming,
}: Readonly<MarkdownRendererProps>): React.JSX.Element {
  const components = React.useMemo<Partial<Components>>(
    () => ({
      // Intercepts BEFORE MarkdownCode fires for large blocks and mermaid.
      pre: MarkdownPre as NonNullable<Components['pre']>,
      // Links render in brand-red to stand out within message prose.
      a: (({
        children,
        href,
        ...props
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode;
      }) => (
        // eslint-disable-next-line no-restricted-syntax -- color is set via CSS variable, which the global accessibility CSS layer can override
        <a href={href} style={{ color: 'var(--brand-red)' }} {...props}>
          {children}
        </a>
      )) as NonNullable<Components['a']>,
    }),
    // Deliberately empty: a new `components` object re-renders every Streamdown
    // block. Per-message data reaches the overrides through context instead.
    []
  );

  return (
    <div
      data-testid={TEST_IDS.markdownRenderer}
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none wrap-anywhere',
        'prose-headings:mb-2 prose-headings:mt-4',
        'prose-p:my-2',
        'prose-ul:my-2 prose-ol:my-2',
        'prose-li:my-0.5',
        'prose-blockquote:my-2',
        'prose-pre:p-0',
        className
      )}
    >
      <ErrorBoundary fallback={<MarkdownRenderFallback content={content} />} resetKey={content}>
        <MessageStreamingContext.Provider value={isStreaming ?? false}>
          <Streamdown
            plugins={{ code: safeCode, mermaid, math }}
            components={components}
            controls={{ code: true, mermaid: { copy: true, download: true } }}
            isAnimating={isStreaming ?? false}
            animated
          >
            {content}
          </Streamdown>
        </MessageStreamingContext.Provider>
      </ErrorBoundary>
    </div>
  );
}
