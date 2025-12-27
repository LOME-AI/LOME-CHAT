import * as React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger, cn } from '@lome-chat/ui';
import { formatTokenCount, formatContextLength } from '@/lib/tokens';

interface TokenCounterProps {
  currentTokens: number;
  contextLimit: number;
  className?: string;
}

/**
 * Token counter component that displays current token usage vs context limit.
 * Shows visual warning when approaching or exceeding the limit.
 */
export function TokenCounter({
  currentTokens,
  contextLimit,
  className,
}: TokenCounterProps): React.JSX.Element {
  const percentage = Math.round((currentTokens / contextLimit) * 100);

  // Determine styling based on usage percentage
  const getStatusClass = (): string => {
    if (percentage >= 95) {
      return 'text-destructive';
    }
    if (percentage >= 80) {
      return 'text-yellow-600';
    }
    return 'text-muted-foreground';
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="token-counter"
          className={cn('cursor-default text-sm', getStatusClass(), className)}
        >
          {formatTokenCount(currentTokens)} / {formatContextLength(contextLimit)} ({percentage}%)
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-sm">
          {currentTokens.toLocaleString()} tokens used of {contextLimit.toLocaleString()} context
          limit
        </p>
        {percentage >= 80 && (
          <p className="mt-1 text-sm text-yellow-600">
            {percentage >= 95
              ? 'Context nearly full - consider starting a new conversation'
              : 'Approaching context limit'}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
