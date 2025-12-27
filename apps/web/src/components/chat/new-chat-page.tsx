import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@lome-chat/ui';
import { MOCK_MODELS } from '@lome-chat/shared';
import { TypingAnimation } from './typing-animation';
import { PromptInput } from './prompt-input';
import { SuggestionChips } from './suggestion-chips';
import { ChatHeader } from './chat-header';
import { getGreeting } from '@/lib/greetings';
import { useModelStore } from '@/stores/model';

interface NewChatPageProps {
  onSend: (message: string) => void;
  isAuthenticated: boolean;
  isLoading?: boolean;
  className?: string;
}

/**
 * Full-screen new chat page with centered greeting, prompt input, and suggestions.
 * This is the "blank canvas" experience for starting a new conversation.
 */
export function NewChatPage({
  onSend,
  isAuthenticated,
  isLoading = false,
  className,
}: NewChatPageProps): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const [showSubtitle, setShowSubtitle] = React.useState(false);

  // Model selection from store
  const { selectedModelId, setSelectedModelId } = useModelStore();

  // Get a greeting once on mount
  const greeting = React.useMemo(() => getGreeting(isAuthenticated), [isAuthenticated]);

  const handleSubmit = (): void => {
    if (inputValue.trim()) {
      onSend(inputValue.trim());
      setInputValue('');
    }
  };

  const handleSuggestionSelect = (prompt: string): void => {
    setInputValue(prompt);
  };

  const handleTypingComplete = (): void => {
    setShowSubtitle(true);
  };

  return (
    <div data-testid="new-chat-page" className={cn('flex min-h-full flex-col', className)}>
      {/* ChatHeader with model selector and theme toggle */}
      <ChatHeader
        models={MOCK_MODELS}
        selectedModelId={selectedModelId}
        onModelSelect={setSelectedModelId}
      />

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-2xl space-y-8">
          {/* Greeting Section */}
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
              <TypingAnimation
                text={greeting.title}
                typingSpeed={50}
                loop={false}
                onComplete={handleTypingComplete}
              />
            </h1>

            {/* Subtitle with fade-in animation */}
            <motion.p
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: showSubtitle ? 1 : 0, y: showSubtitle ? 0 : 10 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-muted-foreground mt-4 text-lg"
            >
              {greeting.subtitle}
            </motion.p>
          </div>

          {/* Prompt Input Section */}
          <div className="w-full">
            <PromptInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder="Ask me anything..."
              maxTokens={2000}
              rows={6}
              disabled={isLoading}
            />
          </div>

          {/* Suggestions Section */}
          <div className="space-y-4">
            <p className="text-muted-foreground text-center text-sm">
              Need inspiration? Try these:
            </p>
            <SuggestionChips onSelect={handleSuggestionSelect} showSurpriseMe />
          </div>
        </div>
      </div>
    </div>
  );
}
