import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { parseReasoningText, TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';

/**
 * Bottom-fade glaze over the collapsed preview. A mask gradient (not
 * `filter: blur` / `backdrop-filter`) so the accessibility widget's contrast
 * and inversion overrides still apply to the glazed text.
 */
const GLAZE_MASK = 'linear-gradient(to bottom, transparent 0%, black 55%)';

interface ThinkingDisclosureProps {
  /** The assistant message's full text field (canonical inline format). */
  content: string;
  isStreaming?: boolean | undefined;
  /**
   * Reasoning token count when known. Drives the settled label and the
   * "Reasoned privately" state for models that bill reasoning without
   * emitting visible text.
   */
  reasoningTokens?: number | undefined;
}

function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * Default-closed disclosure for a reasoning model's thoughts, rendered above
 * the answer. While reasoning streams, a fixed-height bottom-anchored preview
 * shows the newest thoughts behind the mask-gradient glaze; new lines push old
 * ones up as content flows, so there is no JS animation to gate for reduced
 * motion. Row height changes only when the user toggles the disclosure (the
 * Virtuoso constraint); the expanded view is height-bounded with internal
 * scroll, bottom-anchored while streaming via `flex-col-reverse`.
 *
 * The preview is `aria-hidden`: the sole live announcement surface for an
 * in-flight turn remains the `role="status"` ThinkingIndicator, and this
 * component must stay outside the answer's `aria-live` region.
 */
export function ThinkingDisclosure({
  content,
  isStreaming,
  reasoningTokens,
}: Readonly<ThinkingDisclosureProps>): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();

  const { reasoning, answer } = parseReasoningText(content);
  const hasVisibleReasoning = reasoning !== undefined && reasoning !== '';
  const tokenCount = reasoningTokens ?? 0;

  if (!hasVisibleReasoning) {
    // Honest state for models that reason without emitting visible text
    // (o-series): a quiet metadata line instead of a disclosure that opens
    // to nothing.
    if (tokenCount > 0) {
      return (
        <p
          data-testid={TEST_IDS.reasonedPrivately}
          className="text-muted-foreground mb-1.5 font-sans text-xs"
        >
          Reasoned privately ({formatTokenCount(tokenCount)} tokens)
        </p>
      );
    }
    return null;
  }

  // The reasoning phase of a stream: thoughts are arriving, no answer yet.
  const isThinking = isStreaming === true && answer === '';
  // Duration-label rule: no duration is stored, so the settled label derives
  // from the reasoning token count when known and stays static otherwise.
  let label = 'Reasoning';
  if (isThinking) {
    label = 'Thinking…';
  } else if (tokenCount > 0) {
    label = `Reasoning (${formatTokenCount(tokenCount)} tokens)`;
  }

  return (
    <div
      data-testid={TEST_IDS.thinkingDisclosure}
      className="border-border bg-muted/30 mb-2 overflow-hidden rounded-lg border"
    >
      <button
        type="button"
        data-testid={TEST_IDS.thinkingDisclosureToggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        <span>{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn('ml-auto h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div id={panelId} className="flex max-h-60 flex-col-reverse overflow-y-auto">
          <div
            data-testid={TEST_IDS.thinkingDisclosureContent}
            className="text-muted-foreground px-3 pb-2.5 text-sm leading-relaxed break-words whitespace-pre-wrap"
          >
            {reasoning}
          </div>
        </div>
      ) : (
        <div
          id={panelId}
          data-testid={TEST_IDS.thinkingDisclosurePreview}
          aria-hidden="true"
          className="text-muted-foreground flex h-[4.75rem] flex-col justify-end overflow-hidden px-3 pb-2 text-sm leading-relaxed break-words whitespace-pre-wrap"
          style={{ maskImage: GLAZE_MASK, WebkitMaskImage: GLAZE_MASK }}
        >
          {reasoning}
        </div>
      )}
    </div>
  );
}
