import * as React from 'react';
import { motion } from 'framer-motion';
import { cn, useIsMobile, useVisualViewportHeight } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { getGreeting } from '@/lib/greetings';
import { useModelStore, type SelectedModelEntry } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useSelectedModelCapabilities } from '@/hooks/models/use-selected-model-capabilities';
import { useResolveDefaultModel } from '@/hooks/models/use-resolve-default-model';
import { useStableBalance } from '@/hooks/billing/use-stable-balance';
import { getInspirationLabel, getPromptPlaceholder } from '@/lib/modality-strings';
import { ComparisonBar } from '@/components/chat/layout/comparison-bar';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import { SuggestionChips } from '@/components/chat/input/suggestion-chips';
import { PromptInput } from '@/components/chat/input/prompt-input';
import { TypingAnimation } from '@/components/chat/indicators/typing-animation';
import type { FundingSource, LegacyModality } from '@hushbox/shared';
import type { ChatSearchProps, PromptInputRef } from '@/components/chat/input/prompt-input';

interface WelcomeGreetingProps {
  greeting: ReturnType<typeof getGreeting> | null;
  showSubtitle: boolean;
  onTypingComplete: () => void;
}

function WelcomeGreeting({
  greeting,
  showSubtitle,
  onTypingComplete,
}: Readonly<WelcomeGreetingProps>): React.JSX.Element {
  return (
    <div className="text-center" data-reading="">
      <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
        {greeting ? (
          <TypingAnimation
            text={greeting.title}
            typingSpeed={75}
            loop={false}
            onComplete={onTypingComplete}
          />
        ) : (
          <span className="invisible">Loading...</span>
        )}
      </h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: showSubtitle ? 1 : 0, y: showSubtitle ? 0 : 10 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="text-muted-foreground mt-4 text-lg"
      >
        {greeting?.subtitle ?? '\u00A0'}
      </motion.p>
    </div>
  );
}

interface ChatWelcomeProps {
  onSend: (message: string, fundingSource: FundingSource) => void;
  isAuthenticated: boolean;
  isLoading?: boolean | undefined;
  className?: string | undefined;
  /** Called when a trial user clicks a premium model */
  onPremiumClick?: ((modelId: string) => void) | undefined;
}

/**
 * Full-screen welcome page with centered greeting, prompt input, and suggestions.
 * This is the "blank canvas" experience for starting a new conversation.
 */
export function ChatWelcome({
  onSend,
  isAuthenticated,
  isLoading = false,
  className,
  onPremiumClick,
}: Readonly<ChatWelcomeProps>): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const [showSubtitle, setShowSubtitle] = React.useState(false);
  const promptInputRef = React.useRef<PromptInputRef>(null);
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();

  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const setActiveModality = useModelStore((state) => state.setActiveModality);
  useResolveDefaultModel(activeModality);
  const webSearch = useWebSearch();
  const selectModality = React.useCallback(
    (modality: LegacyModality): void => {
      setActiveModality(modality);
    },
    [setActiveModality]
  );

  const { models, premiumIds } = useSelectedModelCapabilities();
  const searchProps: ChatSearchProps | undefined =
    activeModality === 'text'
      ? {
          webSearchEnabled: webSearch.active,
          canUseWebSearch: webSearch.canUse,
          onToggleWebSearch: webSearch.toggle,
        }
      : undefined;

  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    const { activeModality: current, setSelectedModels } = useModelStore.getState();
    setSelectedModels(current, entries);
  }, []);

  const handleRemoveModel = React.useCallback((modelId: string): void => {
    const { activeModality: current, removeModel } = useModelStore.getState();
    removeModel(current, modelId);
  }, []);

  const [pickerOpen, setPickerOpen] = React.useState(false);
  const handleAddViaComparisonBar = React.useCallback((): void => {
    const { activeModality: current, setPickerMode } = useModelStore.getState();
    setPickerMode(current, 'multi');
    setPickerOpen(true);
  }, []);

  const { displayBalance } = useStableBalance();
  const balance = Number.parseFloat(displayBalance);
  const canAccessPremium = isAuthenticated && balance > 0;

  // Pick a stable greeting once auth state settles (prevents title flash on
  // auth changes).
  const greeting = React.useMemo(() => {
    if (isLoading) return null;
    return getGreeting(isAuthenticated);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isAuthenticated intentionally omitted: the greeting is computed once after loading settles; re-running on auth change would flash a new title
  }, [isLoading]);

  // Auto-focus the prompt input once the page is ready (desktop only; skip on
  // mobile to avoid opening the keyboard). Fires on the first ready render —
  // including a warm load that is ready immediately, where the prior
  // transition-only effect never focused. Guarded so a later re-render can't
  // steal focus the user has moved elsewhere.
  const hasFocusedRef = React.useRef(false);
  React.useEffect(() => {
    if (hasFocusedRef.current || isLoading || isMobile) return;
    hasFocusedRef.current = true;
    promptInputRef.current?.focus();
  }, [isLoading, isMobile]);

  const handleSubmit = (fundingSource: FundingSource): void => {
    if (inputValue.trim()) {
      onSend(inputValue.trim(), fundingSource);
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
    <div
      data-testid={TEST_IDS.chatWelcome}
      data-loading={String(isLoading)}
      className={cn('flex flex-col overflow-hidden', className)}
      style={{ height: `${String(viewportHeight)}px` }}
    >
      <ChatHeader
        models={models}
        selectedModels={selectedModels}
        onModelSelect={handleModelSelect}
        premiumIds={premiumIds}
        canAccessPremium={canAccessPremium}
        isAuthenticated={isAuthenticated}
        onPremiumClick={onPremiumClick}
        activeModality={activeModality}
        pickerOpen={pickerOpen}
        onPickerOpenChange={setPickerOpen}
      />
      <ComparisonBar
        models={models}
        selectedModels={selectedModels}
        onRemoveModel={handleRemoveModel}
        onAddClick={handleAddViaComparisonBar}
      />

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-4 py-8">
        <div className="w-full max-w-2xl space-y-8">
          <WelcomeGreeting
            greeting={greeting}
            showSubtitle={showSubtitle}
            onTypingComplete={handleTypingComplete}
          />

          <div className="w-full">
            <PromptInput
              ref={promptInputRef}
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSubmit}
              placeholder={getPromptPlaceholder(activeModality, 'Ask me anything...')}
              rows={6}
              disabled={isLoading}
              isAuthenticated={isAuthenticated}
              activeModality={activeModality}
              onSelectModality={selectModality}
              {...(searchProps !== undefined && { searchProps })}
            />
          </div>

          <div className="space-y-4">
            <p className="text-muted-foreground text-center text-sm">
              {getInspirationLabel(activeModality)}
            </p>
            <SuggestionChips onSelect={handleSuggestionSelect} showSurpriseMe />
          </div>

          <p
            data-testid={TEST_IDS.privacyTagline}
            className="text-muted-foreground/60 text-center text-xs"
          >
            {isAuthenticated
              ? 'Encrypted storage \u00B7 AI providers retain nothing'
              : 'AI providers retain nothing \u00B7 Sign up for encrypted storage'}
          </p>
        </div>
      </div>
    </div>
  );
}
