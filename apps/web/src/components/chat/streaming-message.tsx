import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Loader2 } from 'lucide-react';

interface StreamingMessageProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

/**
 * Displays a streaming AI response with a loading indicator.
 * Used during SSE streaming to show partial responses.
 */
export function StreamingMessage({
  content,
  isStreaming = true,
  className,
}: StreamingMessageProps): React.JSX.Element {
  return (
    <div data-testid="streaming-message-container" className={cn('w-full px-[2%] py-3', className)}>
      <div data-testid="streaming-message" className="text-foreground px-4 py-2">
        <p className="text-base leading-relaxed whitespace-pre-wrap">
          {content}
          {isStreaming && (
            <span
              data-testid="streaming-indicator"
              className="ml-1 inline-flex items-center"
              aria-label="Generating response"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
