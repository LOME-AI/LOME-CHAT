import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { cn } from '@lome-chat/ui';
import { Plus } from 'lucide-react';
import { useUIStore } from '@/stores/ui';

export function NewChatButton(): React.JSX.Element {
  const navigate = useNavigate();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);

  const handleClick = (): void => {
    void navigate({ to: '/chat' });
  };

  // Common styles for the slash button
  const slashButtonStyles = {
    clipPath: 'polygon(0 0, 100% 0, 95% 100%, 0 100%)',
  };

  if (!sidebarOpen) {
    return (
      <button
        onClick={handleClick}
        aria-label="New chat"
        className={cn(
          'relative flex h-9 w-9 cursor-pointer items-center justify-center overflow-hidden rounded-lg',
          'from-primary to-secondary bg-gradient-to-r',
          'text-white transition-all hover:opacity-90 hover:shadow-md',
          'focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none'
        )}
        style={slashButtonStyles}
      >
        {/* Shine effect */}
        <div
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity hover:opacity-100"
          aria-hidden="true"
          style={{
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            animation: 'shine 2s infinite',
          }}
        />
        <Plus data-testid="plus-icon" className="relative z-10 h-4 w-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      aria-label="New chat"
      className={cn(
        'relative flex w-full cursor-pointer items-center justify-start gap-2 overflow-hidden rounded-lg px-3 py-2',
        'from-primary to-secondary bg-gradient-to-r',
        'font-medium text-white transition-all hover:opacity-90 hover:shadow-md',
        'focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none'
      )}
      style={slashButtonStyles}
    >
      {/* Shine effect */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
          animation: 'shine 3s infinite',
        }}
      />
      <Plus data-testid="plus-icon" className="relative z-10 h-4 w-4" aria-hidden="true" />
      <span className="relative z-10 whitespace-nowrap">New Chat</span>
    </button>
  );
}
