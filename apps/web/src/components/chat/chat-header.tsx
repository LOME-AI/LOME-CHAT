import * as React from 'react';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { HamburgerButton } from '@/components/sidebar/hamburger-button';
import { ModelSelectorButton } from './model-selector-button';
import type { Model } from '@lome-chat/shared';

interface ChatHeaderProps {
  models: Model[];
  selectedModelId: string;
  onModelSelect: (modelId: string) => void;
  title?: string;
}

export function ChatHeader({
  models,
  selectedModelId,
  onModelSelect,
  title,
}: ChatHeaderProps): React.JSX.Element {
  return (
    <header
      data-testid="chat-header"
      className="bg-background/95 supports-backdrop-blur:bg-background/60 sticky top-0 z-10 flex items-center justify-center border-b px-4 py-3 backdrop-blur"
    >
      {/* Left side with hamburger (mobile only) and title (desktop only) */}
      <div className="flex flex-1 items-center justify-start gap-2">
        <HamburgerButton />
        {title && (
          <span
            data-testid="chat-title"
            className="hidden max-w-[200px] truncate text-sm font-medium md:block"
            title={title}
          >
            {title}
          </span>
        )}
      </div>

      {/* Centered model selector */}
      <ModelSelectorButton models={models} selectedId={selectedModelId} onSelect={onModelSelect} />

      {/* Right side with theme toggle */}
      <div className="flex flex-1 justify-end">
        <ThemeToggle />
      </div>
    </header>
  );
}
