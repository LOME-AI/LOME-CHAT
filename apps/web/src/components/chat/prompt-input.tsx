import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';
import { Button } from '@lome-chat/ui';
import { Textarea } from '@lome-chat/ui';
import { estimateTokenCount } from '@/lib/tokens';

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  maxTokens?: number;
  className?: string;
  rows?: number;
  disabled?: boolean;
  /** When true, shows stop button instead of send and disables textarea */
  isStreaming?: boolean;
  /** Called when stop button is clicked during streaming */
  onStop?: () => void;
}

/**
 * Large prompt input with token counter, send button, and keyboard handling.
 * Used for the new chat page's main input area.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Ask me anything...',
  maxTokens = 2000,
  className,
  rows = 6,
  disabled = false,
  isStreaming = false,
  onStop,
}: PromptInputProps): React.JSX.Element {
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Calculate token count
  const currentTokens = estimateTokenCount(value);
  const isOverLimit = currentTokens > maxTokens;
  const excessTokens = Math.max(0, currentTokens - maxTokens);

  const canSubmit = value.trim().length > 0 && !isOverLimit && !disabled && !isStreaming;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) {
        onSubmit();
      }
    }
  };

  const handleSubmitClick = (): void => {
    if (canSubmit) {
      onSubmit();
    }
  };

  const handleStopClick = (): void => {
    onStop?.();
  };

  return (
    <div className={cn('relative w-full', className)}>
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled || isStreaming}
          className={cn(
            'min-h-[150px] resize-none pr-14 pb-10 text-base',
            isOverLimit && 'border-destructive focus-visible:ring-destructive'
          )}
        />

        {/* Token counter */}
        <div
          data-testid="token-counter"
          aria-live="polite"
          aria-atomic="true"
          className={cn(
            'absolute bottom-3 left-3 text-sm',
            isOverLimit ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {isOverLimit ? (
            <span>
              {maxTokens}+{excessTokens}/{maxTokens}
            </span>
          ) : (
            <span>
              {currentTokens}/{maxTokens}
            </span>
          )}
        </div>

        {/* Send or Stop button */}
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            onClick={handleStopClick}
            className="absolute right-3 bottom-3"
            aria-label="Stop"
            variant="destructive"
          >
            <Square className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={handleSubmitClick}
            disabled={!canSubmit}
            className="absolute right-3 bottom-3"
            aria-label="Send"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {/* Over limit warning */}
      {isOverLimit && (
        <p className="text-destructive mt-2 text-sm">
          Tokens beyond the {maxTokens} token limit will not be included.
        </p>
      )}
    </div>
  );
}
