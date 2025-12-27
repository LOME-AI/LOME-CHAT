import * as React from 'react';
import { Button, Textarea } from '@lome-chat/ui';
import { Send, Square } from 'lucide-react';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isStreaming?: boolean;
  onStop?: () => void;
}

export function MessageInput({
  onSend,
  disabled,
  isStreaming = false,
  onStop,
}: MessageInputProps): React.JSX.Element {
  const [value, setValue] = React.useState('');

  const handleSend = (): void => {
    const trimmed = value.trim();
    if (trimmed) {
      onSend(trimmed);
      setValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = (): void => {
    if (onStop) {
      onStop();
    }
  };

  const isEmpty = value.trim().length === 0;
  const isDisabled = (disabled ?? false) || isStreaming;

  return (
    <div className="flex gap-2 p-4">
      <Textarea
        placeholder="Type a message..."
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        disabled={isDisabled}
        className="min-h-[44px] flex-1 resize-none"
        rows={1}
      />
      {isStreaming ? (
        <Button
          aria-label="Stop generation"
          onClick={handleStop}
          size="icon"
          className="h-11 w-11 shrink-0"
        >
          <Square className="h-5 w-5" aria-hidden="true" />
        </Button>
      ) : (
        <Button
          aria-label="Send message"
          onClick={handleSend}
          disabled={isDisabled || isEmpty}
          size="icon"
          className="h-11 w-11 shrink-0"
        >
          <Send className="h-5 w-5" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
