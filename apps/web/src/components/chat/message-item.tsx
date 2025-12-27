import * as React from 'react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@lome-chat/ui';
import { Check, Copy } from 'lucide-react';
import type { Message } from '@/lib/api';

interface MessageItemProps {
  message: Message;
}

export function MessageItem({ message }: MessageItemProps): React.JSX.Element {
  const isUser = message.role === 'user';
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async (): Promise<void> => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  return (
    <div
      data-testid="message-item"
      data-role={message.role}
      className={cn('w-full py-3', isUser ? 'pr-[2%] pl-[18%]' : 'px-[2%]')}
    >
      <div className="group relative">
        <div
          className={cn(
            'px-4 py-2',
            isUser ? 'bg-message-user text-foreground rounded-lg' : 'text-foreground'
          )}
        >
          <p className="text-base leading-relaxed whitespace-pre-wrap">{message.content}</p>
        </div>

        {/* Copy button - bottom right of message */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0 -bottom-1 h-6 w-6 translate-y-full opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              onClick={() => void handleCopy()}
              aria-label={copied ? 'Copied' : 'Copy'}
            >
              {copied ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Copy className="h-3 w-3" aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{copied ? 'Copied!' : 'Copy'}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
