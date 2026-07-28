import * as React from 'react';
import { X, Code, Eye, Copy, Check, Download, Maximize2, Minimize2 } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { Button, cn, useIsMobile } from '@hushbox/ui';
import { MermaidDiagram } from '@/components/chat/message/mermaid-diagram';
import { useDocumentStore } from '../../stores/document';
import { DocumentSandbox } from './document-sandbox';
import { HighlightedSource } from './highlighted-source';
import { DocumentRenderStatus, PENDING_PREVIEW_TEXT } from './document-render-status';
import { getFileExtension, isRunnableDocument } from '../../lib/document-parser';
import type { Document } from '../../lib/document-parser';

interface DocumentPanelProps {
  className?: string;
}

interface ResizeHandleProps {
  isResizing: boolean;
  onResizeStart: (e: React.MouseEvent) => void;
}

function ResizeHandle({
  isResizing,
  onResizeStart,
}: Readonly<ResizeHandleProps>): React.JSX.Element {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- mouse-only resize handle: keyboard users have alternative panel sizing controls
    <div
      data-testid={TEST_IDS.resizeHandle}
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onResizeStart}
      className={cn(
        'group absolute top-0 left-0 z-10 flex h-full w-2 cursor-ew-resize items-center justify-center',
        'hover:bg-primary/10 transition-colors',
        isResizing && 'bg-primary/20'
      )}
    >
      <div
        data-testid={TEST_IDS.resizeIndicator}
        className={cn(
          'bg-border group-hover:bg-primary/50 h-8 w-0.5 rounded-full transition-colors',
          isResizing && 'bg-primary/50'
        )}
      />
    </div>
  );
}

interface PanelHeaderProps {
  title: string;
  copied: boolean;
  showRaw: boolean;
  supportsRawToggle: boolean;
  isFullscreen: boolean;
  showFullscreenToggle: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onToggleRaw: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
}

function PanelHeader({
  title,
  copied,
  showRaw,
  supportsRawToggle,
  isFullscreen,
  showFullscreenToggle,
  onCopy,
  onDownload,
  onToggleRaw,
  onToggleFullscreen,
  onClose,
}: Readonly<PanelHeaderProps>): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-3">
      <h2 className="text-primary min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onDownload}
          aria-label="Download file"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </Button>
        {showFullscreenToggle && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        )}
        {supportsRawToggle && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onToggleRaw}
            aria-label={showRaw ? 'Show rendered' : 'Show raw'}
          >
            {showRaw ? (
              <Eye className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Code className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

interface DocumentContentProps {
  document: Document;
  showRaw: boolean;
}

/** Whether this document type has a preview to switch to at all. */
function hasPreview(type: Document['type']): boolean {
  return type === 'mermaid' || isRunnableDocument(type);
}

/** The source, plus the line explaining why no preview is on screen yet. */
function PendingSourceView({ document }: Readonly<{ document: Document }>): React.JSX.Element {
  return (
    <div>
      <HighlightedSource content={document.content} language={document.language} />
      {/* Repeats the status text visibly; the status element announces it. */}
      <p className="text-muted-foreground px-4 pb-4 text-sm" aria-hidden="true">
        {PENDING_PREVIEW_TEXT}
      </p>
    </div>
  );
}

function DocumentContent({ document, showRaw }: Readonly<DocumentContentProps>): React.JSX.Element {
  if (document.type === 'mermaid') {
    if (showRaw) {
      return <HighlightedSource content={document.content} language="mermaid" />;
    }
    // Mermaid draws in-app and reports nothing back, so a half-written diagram
    // offers no failed attempt to observe — unlike the sandbox kinds, whose
    // frame says whether the code actually ran. It therefore waits for the
    // message to settle rather than showing a syntax complaint per token.
    if (document.isStreaming) {
      return (
        <>
          <PendingSourceView document={document} />
          <DocumentRenderStatus status="streaming" text={PENDING_PREVIEW_TEXT} />
        </>
      );
    }
    return <MermaidDiagram chart={document.content} />;
  }

  // html/js/react/python execute in the sandbox iframe when Rendered; Raw shows
  // the highlighted source, mirroring the mermaid toggle.
  if (isRunnableDocument(document.type) && !showRaw) {
    return (
      <DocumentSandbox
        kind={document.type}
        code={document.content}
        title={document.title}
        isStreaming={document.isStreaming}
        pendingView={<PendingSourceView document={document} />}
      />
    );
  }

  return <HighlightedSource content={document.content} language={document.language} />;
}

export function DocumentPanel({
  className,
}: Readonly<DocumentPanelProps>): React.JSX.Element | null {
  const {
    isPanelOpen,
    panelWidth,
    activeDocument,
    activeSelectionId,
    isFullscreen,
    closePanel,
    setPanelWidth,
    toggleFullscreen,
  } = useDocumentStore();
  const [isResizing, setIsResizing] = React.useState(false);
  const [showRaw, setShowRaw] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Keyed on the selection, not the document id: the id is a content hash that
  // mutates while a message streams, and re-anchoring must not discard the
  // view the user picked.
  React.useEffect(() => {
    setShowRaw(false);
  }, [activeSelectionId]);

  React.useEffect(() => {
    if (!isResizing || isMobile) return;

    const handleMouseMove = (e: MouseEvent): void => {
      /* v8 ignore next -- the effect only attaches this listener while the panel (panelRef) is mounted, so the null-guard never fires */
      if (!panelRef.current) return;
      const panelRect = panelRef.current.getBoundingClientRect();
      /* v8 ignore next -- parentElement.clientWidth is always a number in a mounted panel; the ?. and ?? panelRect.width only satisfy the optional type */
      const maxWidth = panelRef.current.parentElement?.clientWidth ?? panelRect.width;
      const newWidth = panelRect.right - e.clientX;
      setPanelWidth(newWidth, maxWidth);
    };

    const handleMouseUp = (): void => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, isMobile, setPanelWidth]);

  if (!isPanelOpen || !activeDocument) {
    return null;
  }

  const handleResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    if (isFullscreen) {
      // Sync stored width to current rendered width so exiting fullscreen doesn't jump
      /* v8 ignore next -- panelRef is mounted here, so getBoundingClientRect().width is always a number; the ?. and ?? panelWidth only satisfy the optional type */
      const currentWidth = panelRef.current?.getBoundingClientRect().width ?? panelWidth;
      /* v8 ignore next -- parentElement.clientWidth is always a number in a mounted panel; the ?. and ?? currentWidth only satisfy the optional type */
      const maxWidth = panelRef.current?.parentElement?.clientWidth ?? currentWidth;
      setPanelWidth(currentWidth, maxWidth);
      toggleFullscreen();
    }
    setIsResizing(true);
  };

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(activeDocument.content);
    } catch {
      // Clipboard API may fail (permissions, insecure context, headless browser).
      // Feedback still shown — matches GitHub/VS Code behavior.
    }
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const handleDownload = (): void => {
    const extension = activeDocument.language ? getFileExtension(activeDocument.language) : 'txt';
    const filename = `${activeDocument.title}.${extension}`;
    const blob = new Blob([activeDocument.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const supportsRawToggle = hasPreview(activeDocument.type);

  return (
    <div
      ref={panelRef}
      // Literal HTML `id` (a distinct mechanism from `data-testid`) so the mobile
      // Maestro flow can select this singleton panel container — Maestro's `id:`
      // selector matches an `id` attribute, not `data-testid`.
      id="document-panel"
      data-testid={TEST_IDS.documentPanel}
      data-chrome=""
      className={cn(
        'bg-background border-border relative flex h-full flex-col border-l',
        isResizing && 'select-none',
        !isResizing && !isMobile && 'transition-[width] duration-300 ease-in-out',
        className
      )}
      style={{ width: isMobile || isFullscreen ? '100%' : `${String(panelWidth)}px` }}
    >
      {!isMobile && <ResizeHandle isResizing={isResizing} onResizeStart={handleResizeStart} />}

      <PanelHeader
        title={activeDocument.title}
        copied={copied}
        showRaw={showRaw}
        supportsRawToggle={supportsRawToggle}
        isFullscreen={isFullscreen}
        showFullscreenToggle={!isMobile}
        onCopy={() => void handleCopy()}
        onDownload={handleDownload}
        onToggleRaw={() => {
          setShowRaw(!showRaw);
        }}
        onToggleFullscreen={toggleFullscreen}
        onClose={closePanel}
      />

      <div data-testid={TEST_IDS.documentPanelScroll} className="flex-1 overflow-auto">
        {/* `h-full` is load-bearing, not cosmetic: the sandbox iframe is a
            replaced element, so when this wrapper is auto-height the `h-full`
            below it resolves to auto, the iframe's `flex-1` basis cannot
            resolve against an indefinite main size, and the frame falls back to
            its 300x150 intrinsic size — a rendered document ends up 150px tall
            however tall the panel is. Taller content still scrolls, on the
            `overflow-auto` above. */}
        <div className="h-full">
          {/* Keyed by the selection, not the document id: opening another
              document remounts the content, tearing the sandbox iframe down and
              killing anything running in it, while a streaming document — whose
              content-hash id changes every token — keeps the frame it is
              already driving. */}
          <DocumentContent key={activeSelectionId} document={activeDocument} showRaw={showRaw} />
        </div>
      </div>
    </div>
  );
}
