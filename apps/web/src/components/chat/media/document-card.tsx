import * as React from 'react';
import { FileCode, GitBranch, Globe, Atom, ArrowUpRight } from 'lucide-react';
import { cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useDocumentStore } from '@/stores/document';
import type { Document } from '@/lib/document-parser';

interface DocumentCardProps {
  document: Document;
  className?: string;
}

function getDocumentIcon(type: Document['type']): React.JSX.Element {
  switch (type) {
    case 'code': {
      return <FileCode className="h-4 w-4" data-testid={TEST_IDS.codeIcon} aria-hidden="true" />;
    }
    case 'mermaid': {
      return (
        <GitBranch className="h-4 w-4" data-testid={TEST_IDS.diagramIcon} aria-hidden="true" />
      );
    }
    case 'html': {
      return <Globe className="h-4 w-4" data-testid={TEST_IDS.htmlIcon} aria-hidden="true" />;
    }
    case 'react': {
      return <Atom className="h-4 w-4" data-testid={TEST_IDS.reactIcon} aria-hidden="true" />;
    }
    case 'js':
    case 'python': {
      return <FileCode className="h-4 w-4" data-testid={TEST_IDS.codeIcon} aria-hidden="true" />;
    }
  }
}

function getTypeLabel(document: Document): string {
  if (document.language) {
    return document.language;
  }
  switch (document.type) {
    case 'mermaid': {
      return 'Mermaid';
    }
    case 'html': {
      return 'HTML';
    }
    case 'react': {
      return 'React';
    }
    default: {
      return 'Code';
    }
  }
}

/**
 * Whether a freshly mounted card is holding a newer state of the document the
 * panel already has open.
 *
 * A card can unmount while its document stays open — the message list
 * virtualizes — and come back after the content grew, by which point the
 * content-hash id names a state the panel never saw and matches nothing. What
 * still holds is how the text got there: a document only ever gains characters
 * as its message streams, so the open document's content is a strict prefix of
 * this card's. Growth must be strict — equal content hashes to the same id, so
 * that case is already an id match and is not this one. Two distinct blocks in
 * one message satisfying this are not a real shape, and the cost if they ever
 * did would be the panel re-anchoring visibly, not corrupting anything.
 */
function claimsRemountedSelection(
  previous: Document | null,
  document_: Document,
  active: Document | null
): boolean {
  if (previous !== null || active === null) return false;
  return (
    active.type === document_.type &&
    document_.content.length > active.content.length &&
    document_.content.startsWith(active.content)
  );
}

export function DocumentCard({
  document,
  className,
}: Readonly<DocumentCardProps>): React.JSX.Element {
  const { activeDocumentId, activeDocument, setActiveDocument, refreshActiveDocument } =
    useDocumentStore();
  const isActive = activeDocumentId === document.id;

  // Streaming re-anchor: `generateDocumentId` hashes the source code, so the
  // id mutates each time a token arrives. If this card was the active one on
  // the previous render and its id has now shifted, re-claim the active slot
  // with the fresh Document. Without this, opening a still-streaming card
  // would freeze the panel on the title/content captured at click time —
  // e.g., showing "Mermaid Diagram" forever for a `graph TD` block whose
  // first line wasn't yet streamed when the user clicked.
  //
  // The streaming flag settles independently of the id: the last token of a
  // message can leave the code text untouched, so the hash is unchanged while
  // the panel must stop suppressing failed attempts and surface them.
  //
  // The ref starts empty rather than at the current document so that a remount
  // counts as "nothing published yet": the message list virtualizes, so a card
  // whose document is open in the panel can unmount and come back holding a
  // state the panel never saw.
  const previousRef = React.useRef<Document | null>(null);
  React.useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = document;
    if (previous?.id === document.id && previous.isStreaming === document.isStreaming) return;
    if (
      activeDocumentId === (previous?.id ?? document.id) ||
      claimsRemountedSelection(previous, document, activeDocument)
    ) {
      refreshActiveDocument(document);
    }
  }, [document, activeDocumentId, activeDocument, refreshActiveDocument]);

  const handleClick = (): void => {
    setActiveDocument(document);
  };

  return (
    <button
      type="button"
      data-testid={TEST_IDS.documentCard}
      data-active={isActive}
      onClick={handleClick}
      aria-label={`Open ${document.title}`}
      className={cn(
        'group flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors',
        'bg-muted/50 hover:bg-muted border-border',
        isActive && 'border-primary bg-primary/5',
        className
      )}
    >
      <div className="text-muted-foreground flex-shrink-0">{getDocumentIcon(document.type)}</div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{document.title}</div>
        <div className="text-muted-foreground text-xs">
          {getTypeLabel(document)} &bull; {document.lineCount} lines
        </div>
      </div>

      <ArrowUpRight
        className="text-muted-foreground group-hover:text-foreground h-4 w-4 flex-shrink-0 transition-colors"
        data-testid={TEST_IDS.openIcon}
        aria-hidden="true"
      />
    </button>
  );
}
