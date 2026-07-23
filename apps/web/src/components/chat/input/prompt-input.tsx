import * as React from 'react';
import {
  Bot,
  Image as ImageIcon,
  MessageSquare,
  Mic,
  Pencil,
  Search,
  SearchX,
  Send,
  Type,
  Video,
  X,
} from 'lucide-react';
import { cn, useIsMobile } from '@hushbox/ui';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@hushbox/ui';
import { Textarea } from '@hushbox/ui';
import { FEATURE_FLAGS, MODALITY_ARIA_LABELS, TEST_IDS } from '@hushbox/shared';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { useReasoningEffort } from '@/hooks/chat/use-reasoning-effort';
import { ReasoningEffortMenu } from '@/components/chat/input/reasoning-effort-menu';
import { useStability } from '@/providers/stability-provider';
import { StableContent } from '@/components/shared/stable-content';
import { AnimatedHeight } from '@/components/shared/animated-height';
import { MorphHeight } from '@/components/shared/morph-height';
import { AnimatedPlaceholder } from '@/components/chat/input/animated-placeholder';
import { CapacityBar } from '@/components/chat/layout/capacity-bar';
import { BudgetMessages } from '@/components/chat/budget/budget-messages';
import { GenerationSummaryChip } from '@/components/chat/media/generation-summary-chip';
import { GenerationConfigSheet } from '@/components/chat/media/generation-config-sheet';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
} from '@/components/chat/media/modality-config-panel';
import type { ModelFeatureId, FundingSource, MemberPrivilege, ChatModality } from '@hushbox/shared';
import type { PromptInputRef } from '@/components/chat/message/types';

export type { PromptInputRef } from '@/components/chat/message/types';

interface SubmitState {
  hasContent: boolean;
  isOverCapacity: boolean;
  hasBlockingError: boolean;
  disabled: boolean;
  isProcessing: boolean;
}

function canSubmitMessage(state: SubmitState): boolean {
  if (!state.hasContent) return false;
  if (state.isOverCapacity) return false;
  if (state.hasBlockingError) return false;
  if (state.disabled) return false;
  if (state.isProcessing) return false;
  return true;
}

interface QueueState {
  isProcessing: boolean;
  hasQueueHandler: boolean;
  queueFull: boolean;
  hasContent: boolean;
}

function resolveQueueState(state: QueueState): {
  canQueue: boolean;
  showQueueFullHint: boolean;
} {
  if (!state.isProcessing || !state.hasQueueHandler) {
    return { canQueue: false, showQueueFullHint: false };
  }
  if (state.queueFull) {
    return { canQueue: false, showQueueFullHint: true };
  }
  return { canQueue: state.hasContent, showQueueFullHint: false };
}

function isSubmitKeyEvent(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey;
}

const BUTTON_ARIA_LABELS = { true: 'Send', false: 'Cannot send' } as const;
const TYPING_THROTTLE_MS = 3000;

function emitTypingChange(
  newValue: string,
  onTypingChange: ((isTyping: boolean) => void) | undefined,
  lastTypingSentRef: React.RefObject<number>
): void {
  if (!onTypingChange) return;
  if (newValue.length === 0) {
    onTypingChange(false);
    lastTypingSentRef.current = 0;
  } else {
    const now = Date.now();
    if (now - lastTypingSentRef.current >= TYPING_THROTTLE_MS) {
      onTypingChange(true);
      lastTypingSentRef.current = now;
    }
  }
}

interface ToggleButtonWithTooltipProps {
  tooltipText: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}

function ToggleButtonWithTooltip({
  tooltipText,
  onClick,
  disabled,
  ariaLabel,
  children,
}: Readonly<ToggleButtonWithTooltipProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  // When disabled, the inner button can't receive focus or fire pointer events,
  // so screen-reader / keyboard users would never learn why it's unavailable.
  // We promote the wrapping span to a focusable role="button" so the tooltip
  // (e.g. "Sign up to unlock") is announced on focus.
  const wrapperProps = disabled
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': ariaLabel,
        'aria-disabled': true,
        onFocus: () => {
          setOpen(true);
        },
        onBlur: () => {
          setOpen(false);
        },
      }
    : {};

  // When disabled, the wrapper span carries role=button + aria-label so it's
  // the only entry in the accessibility tree. The inner native button is
  // aria-hidden and purely visual — keeps the same accessible name from being
  // announced twice and resolves the strict-mode locator collision in tests.
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- tooltip wrapper: span exists so tooltip can show on hover/click even when the inner Button is disabled (disabled buttons swallow events). The Button itself owns keyboard semantics. */}
        <span
          className="inline-flex"
          {...wrapperProps}
          onClick={() => {
            setOpen(true);
            if (!disabled) onClick?.();
          }}
        >
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            {...(disabled ? { 'aria-hidden': true } : { 'aria-label': ariaLabel })}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipText}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Props controlling the web-search toggle. Grouped into one object because
 * the fields are only meaningful together — absent means "this prompt
 * has no search feature" (e.g. image modality).
 */
export interface ChatSearchProps {
  /** Whether web search is currently enabled (effective state from useWebSearch). */
  webSearchEnabled: boolean;
  /** Whether the user may use web search (authenticated-only); drives the toggle's enabled state. */
  canUseWebSearch: boolean;
  /** Called when the user toggles web search. */
  onToggleWebSearch: () => void;
}

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (fundingSource: FundingSource) => void;
  placeholder?: string;
  /** Current conversation history character count (for budget calculation) */
  historyCharacters?: number;
  /** Active capabilities that affect system prompt size */
  capabilities?: ModelFeatureId[];
  className?: string;
  rows?: number;
  disabled?: boolean;
  /** When true, a run is streaming: the composer offers queueing instead of sending. */
  isProcessing?: boolean;
  /**
   * Retained for backward compatibility with parents that still pass it; the
   * button no longer uses it (stopping is no longer supported).
   */
  onStop?: (() => void) | undefined;
  /**
   * Enqueue the current text while a run is streaming. Supplying this activates
   * the queue capability: during `isProcessing`, Enter/click enqueue and clear
   * the input instead of sending. Omit to leave the button disabled mid-run.
   */
  onQueue?: (text: string) => void;
  /** Number of already-queued messages (drives the queue-full hint text). */
  queueCount?: number;
  /** When true, the queue is at capacity: the button is disabled and a hint shows. */
  queueFull?: boolean;
  /** Custom minimum height for textarea. Defaults to two text lines ("4rem"). */
  minHeight?: string;
  /** Custom maximum height for textarea. Defaults to seven text lines ("11.5rem"); content scrolls internally beyond it. */
  maxHeight?: string;
  /** Auto-focus the textarea on mount. Use for desktop only to avoid mobile keyboard popup. */
  autoFocus?: boolean;
  /** Conversation ID for group budget lookup. Omit for solo conversations. */
  conversationId?: string | null;
  /** Current user's privilege in the group conversation. Omit for solo conversations. */
  currentUserPrivilege?: MemberPrivilege;
  /** When true, shows the AI toggle button (group chats only). */
  isGroupChat?: boolean;
  /** Called when user submits with AI toggle off (user-only message, no AI invocation). */
  onSubmitUserOnly?: () => void;
  /** Called when typing state changes (for WebSocket typing indicators). Throttled internally. */
  onTypingChange?: ((isTyping: boolean) => void) | undefined;
  /**
   * Search feature props. Omit to disable the search toggle entirely
   * (e.g. image modality has no search).
   */
  searchProps?: ChatSearchProps | undefined;
  /** Whether the user is authenticated (trial users can't search or switch modality). */
  isAuthenticated?: boolean;
  /** Whether the prompt input is in edit mode (editing a previous message) */
  isEditing?: boolean;
  /** Called when the user cancels editing */
  onCancelEdit?: (() => void) | undefined;
  /** Current active modality */
  activeModality?: ChatModality;
  /** Called when the user picks a modality (via the per-modality icon buttons). */
  onSelectModality?: ((modality: ChatModality) => void) | undefined;
}

const PROMPT_INPUT_DEFAULTS: Pick<
  Required<PromptInputProps>,
  | 'placeholder'
  | 'historyCharacters'
  | 'capabilities'
  | 'rows'
  | 'disabled'
  | 'isProcessing'
  | 'minHeight'
  | 'maxHeight'
  | 'autoFocus'
  | 'isGroupChat'
  | 'queueCount'
  | 'queueFull'
> = {
  placeholder: 'Ask me anything...',
  historyCharacters: 0,
  capabilities: [] as ModelFeatureId[],
  rows: 2,
  disabled: false,
  isProcessing: false,
  // Founder-ruled sizing: start at 2 lines, auto-grow (field-sizing-content)
  // to 7 lines, scroll internally beyond. text-base = 1.5rem line-height,
  // py-2 = 1rem vertical padding: 2×1.5+1 = 4rem, 7×1.5+1 = 11.5rem.
  minHeight: '4rem',
  maxHeight: '11.5rem',
  autoFocus: false,
  isGroupChat: false,
  queueCount: 0,
  queueFull: false,
};

function AIToggleButton({
  aiEnabled,
  onToggle,
}: Readonly<{ aiEnabled: boolean; onToggle: () => void }>): React.JSX.Element {
  const label = aiEnabled ? 'AI response on' : 'AI response off';
  return (
    <ToggleButtonWithTooltip tooltipText={label} onClick={onToggle} ariaLabel={label}>
      {aiEnabled ? (
        <Bot className="h-4 w-4" aria-hidden="true" />
      ) : (
        <MessageSquare className="h-4 w-4" aria-hidden="true" />
      )}
    </ToggleButtonWithTooltip>
  );
}

interface SearchToggleButtonProps {
  webSearchEnabled: boolean;
  canUse: boolean;
  onToggle?: (() => void) | undefined;
}

function getSearchTooltipText(canUse: boolean, webSearchEnabled: boolean): string {
  if (!canUse) {
    return 'Sign up to access internet search';
  }
  return webSearchEnabled ? 'Turn off internet search' : 'Turn on internet search';
}

interface ModalityIconsProps {
  activeModality: ChatModality;
  onSelect: (modality: ChatModality) => void;
  /**
   * When false, icons render disabled with a "Sign up to unlock" tooltip
   * (per plan §9.1) so trial users still discover the affordance.
   */
  isAuthenticated: boolean;
}

interface ModalityIconEntry {
  modality: ChatModality;
  label: string;
  /** Trial tooltip for users who haven't signed up — gives action context. */
  trialLabel: string;
  Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

const MODALITY_ICONS: readonly ModalityIconEntry[] = [
  {
    modality: 'text',
    label: MODALITY_ARIA_LABELS.text,
    trialLabel: 'Text generation — sign up to unlock',
    Icon: Type,
  },
  {
    modality: 'image',
    label: MODALITY_ARIA_LABELS.image,
    trialLabel: 'Image generation — sign up to unlock',
    Icon: ImageIcon,
  },
  {
    modality: 'video',
    label: MODALITY_ARIA_LABELS.video,
    trialLabel: 'Video generation — sign up to unlock',
    Icon: Video,
  },
  {
    modality: 'audio',
    label: MODALITY_ARIA_LABELS.audio,
    trialLabel: 'Audio generation — sign up to unlock',
    Icon: Mic,
  },
] as const;

function isModalityAvailable(modality: ChatModality): boolean {
  if (modality === 'audio') return FEATURE_FLAGS.AUDIO_ENABLED;
  return true;
}

/**
 * Renders one icon per non-active modality (see §9.1 of the plan).
 * The active modality's icon is omitted. Audio is gated behind FEATURE_FLAGS.
 *
 * Trial users (`isAuthenticated === false`) see the icons disabled with a
 * "Sign up to unlock" tooltip — keeping the affordance visible while
 * preventing accidental modality switches.
 */
function ModalityIcons({
  activeModality,
  onSelect,
  isAuthenticated,
}: Readonly<ModalityIconsProps>): React.JSX.Element {
  return (
    <>
      {MODALITY_ICONS.filter(
        (entry) => entry.modality !== activeModality && isModalityAvailable(entry.modality)
      ).map((entry) => {
        const tooltip = isAuthenticated ? entry.label : entry.trialLabel;
        const ariaLabel = isAuthenticated ? entry.label : entry.trialLabel;
        return (
          <ToggleButtonWithTooltip
            key={entry.modality}
            tooltipText={tooltip}
            onClick={
              isAuthenticated
                ? () => {
                    onSelect(entry.modality);
                  }
                : undefined
            }
            disabled={!isAuthenticated}
            ariaLabel={ariaLabel}
          >
            <entry.Icon className="h-4 w-4" aria-hidden />
          </ToggleButtonWithTooltip>
        );
      })}
    </>
  );
}

function SearchToggleButton({
  webSearchEnabled,
  canUse,
  onToggle,
}: Readonly<SearchToggleButtonProps>): React.JSX.Element {
  const isDisabled = !canUse;
  const tooltipText = getSearchTooltipText(canUse, webSearchEnabled);
  const ariaLabel = isDisabled ? 'Internet search unavailable' : tooltipText;

  return (
    <ToggleButtonWithTooltip
      tooltipText={tooltipText}
      onClick={onToggle}
      disabled={isDisabled}
      ariaLabel={ariaLabel}
    >
      {webSearchEnabled ? (
        <Search className="h-4 w-4" aria-hidden="true" />
      ) : (
        <SearchX className="h-4 w-4 opacity-50" aria-hidden="true" />
      )}
    </ToggleButtonWithTooltip>
  );
}

interface PromptToolbarProps {
  readonly activeModality: ChatModality | undefined;
  readonly isAuthenticated: boolean | undefined;
  readonly onSelectModality: ((modality: ChatModality) => void) | undefined;
  readonly searchProps: ChatSearchProps | undefined;
  readonly isGroupChat: boolean;
  readonly aiEnabled: boolean;
  readonly onToggleAi: () => void;
}

function PromptToolbar({
  activeModality,
  isAuthenticated,
  onSelectModality,
  searchProps,
  isGroupChat,
  aiEnabled,
  onToggleAi,
}: Readonly<PromptToolbarProps>): React.JSX.Element {
  // ChatModality icons render whenever the parent supplies the props. Trial users
  // (isAuthenticated === false) see them disabled with a sign-up tooltip per
  // plan §9.1, so the affordance stays discoverable instead of being hidden.
  const showModality =
    activeModality !== undefined && onSelectModality !== undefined && isAuthenticated !== undefined;
  const showSearch = searchProps !== undefined && isAuthenticated !== undefined;

  return (
    <div className="flex items-center gap-1">
      {showSearch && (
        <SearchToggleButton
          webSearchEnabled={searchProps.webSearchEnabled}
          canUse={searchProps.canUseWebSearch}
          onToggle={searchProps.onToggleWebSearch}
        />
      )}
      {showModality && (
        <ModalityIcons
          activeModality={activeModality}
          onSelect={onSelectModality}
          isAuthenticated={isAuthenticated}
        />
      )}
      {isGroupChat && <AIToggleButton aiEnabled={aiEnabled} onToggle={onToggleAi} />}
    </div>
  );
}

interface BottomRowsProps {
  readonly activeModality: ChatModality | undefined;
  readonly capacity: { currentUsage: number; maxCapacity: number };
  readonly toolbar: React.ReactNode;
  readonly sendButton: React.ReactNode;
}

export function TextBottomRow({
  capacity,
  toolbar,
  sendButton,
}: Readonly<Omit<BottomRowsProps, 'activeModality'>>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
      <CapacityBar
        currentUsage={capacity.currentUsage}
        maxCapacity={capacity.maxCapacity}
        // min-w-40 + the row's flex-wrap: when the toolbar+send group leaves
        // less than 10rem, the bar wraps to its own full-width line instead of
        // shrinking. Shrinking (the old min-w-0) let the bar's nowrap
        // "Model N% filled" label overflow the container and paint over the
        // search toggle at narrow viewports (real collision at 375px).
        className="min-w-40 flex-1"
        data-testid={TEST_IDS.capacityBar}
      />
      {/* ml-auto keeps this group on the right edge of whichever line it
          lands on once the capacity bar wraps above it. */}
      <div className="ml-auto flex items-center gap-2">
        {toolbar}
        {sendButton}
      </div>
    </div>
  );
}

function MobileGenerationRow({
  modality,
  toolbar,
  sendButton,
}: Readonly<{
  modality: 'image' | 'video';
  toolbar: React.ReactNode;
  sendButton: React.ReactNode;
}>): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <GenerationSummaryChip
          modality={modality}
          onClick={() => {
            setSheetOpen(true);
          }}
        />
      </div>
      {toolbar}
      {sendButton}
      <GenerationConfigSheet modality={modality} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}

export function ImageBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileGenerationRow modality="image" toolbar={toolbar} sendButton={sendButton} />;
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="flex flex-1 justify-center">
        <ImageAspectRatioControl />
      </div>
      <div className="mr-2">
        <MediaCostLine modality="image" />
      </div>
      <div className="flex items-center gap-2">
        {toolbar}
        {sendButton}
      </div>
    </div>
  );
}

export function VideoBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  const isMobile = useIsMobile();

  if (isMobile) {
    return <MobileGenerationRow modality="video" toolbar={toolbar} sendButton={sendButton} />;
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <VideoDurationControl />
        <div className="mr-2 ml-auto">
          <MediaCostLine modality="video" />
        </div>
        <div className="flex items-center gap-2">
          {toolbar}
          {sendButton}
        </div>
      </div>
      <div className="flex items-stretch gap-3">
        <div className="flex flex-1 justify-center">
          <VideoAspectRatioControl />
        </div>
        <div className="bg-border w-px" aria-hidden />
        <div className="flex flex-1 justify-center">
          <VideoResolutionControl />
        </div>
      </div>
    </div>
  );
}

function AudioBottomRow({
  toolbar,
  sendButton,
}: Readonly<Pick<BottomRowsProps, 'toolbar' | 'sendButton'>>): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <AudioFormatControl />
      <AudioDurationControl />
      <div className="mr-2 ml-auto">
        <MediaCostLine modality="audio" />
      </div>
      <div className="flex items-center gap-2">
        {toolbar}
        {sendButton}
      </div>
    </div>
  );
}

function BottomRows({
  activeModality,
  capacity,
  toolbar,
  sendButton,
}: Readonly<BottomRowsProps>): React.JSX.Element {
  if (activeModality === undefined || activeModality === 'text') {
    return <TextBottomRow capacity={capacity} toolbar={toolbar} sendButton={sendButton} />;
  }
  if (activeModality === 'image') {
    return <ImageBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  if (activeModality === 'video') {
    return <VideoBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  if (FEATURE_FLAGS.AUDIO_ENABLED) {
    return <AudioBottomRow toolbar={toolbar} sendButton={sendButton} />;
  }
  return <TextBottomRow capacity={capacity} toolbar={toolbar} sendButton={sendButton} />;
}

export const PromptInput = React.forwardRef<PromptInputRef, PromptInputProps>(
  function PromptInput(rawProps, ref) {
    const {
      value,
      onChange,
      onSubmit,
      placeholder,
      historyCharacters,
      capabilities,
      className,
      rows,
      disabled,
      isProcessing,
      onQueue,
      queueCount,
      queueFull,
      minHeight,
      maxHeight,
      autoFocus,
      conversationId,
      currentUserPrivilege,
      isGroupChat,
      onSubmitUserOnly,
      onTypingChange,
      searchProps,
      isAuthenticated,
      isEditing,
      onCancelEdit,
      activeModality,
      onSelectModality,
    } = { ...PROMPT_INPUT_DEFAULTS, ...rawProps };
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const [aiEnabled, setAiEnabled] = React.useState(true);
    const lastTypingSentRef = React.useRef(0);
    const onTypingChangeRef = React.useRef(onTypingChange);
    onTypingChangeRef.current = onTypingChange;

    React.useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

    React.useEffect(() => {
      if (!autoFocus) return;
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers focus to next frame, not motion animation
      const id = requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(id);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- autoFocus intentionally omitted: this is a mount-only focus; re-running when the prop toggles would steal focus mid-session
    }, []);

    React.useEffect(() => {
      return () => {
        onTypingChangeRef.current?.(false);
      };
    }, []);

    const { isAppStable } = useStability();
    // The effective (model-clamped) selection prices the live estimate and
    // rides the turn request; the effort menu reads the same hook, so the
    // checked option and the priced effort can never disagree.
    const { effective: reasoningEffort } = useReasoningEffort();
    const budget = usePromptBudget({
      value,
      historyCharacters,
      capabilities,
      ...(conversationId != null && { conversationId }),
      ...(currentUserPrivilege !== undefined && { currentUserPrivilege }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
    });

    const canSubmit = canSubmitMessage({
      hasContent: budget.hasContent,
      isOverCapacity: budget.isOverCapacity,
      hasBlockingError: budget.hasBlockingError,
      disabled,
      isProcessing,
    });

    // Queue capability is active only while a run streams AND a parent supplied
    // onQueue; whitespace-only input and a full queue both block it.
    const { canQueue, showQueueFullHint } = resolveQueueState({
      isProcessing,
      hasQueueHandler: onQueue !== undefined,
      queueFull,
      hasContent: budget.hasContent,
    });

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const newValue = e.target.value;
      onChange(newValue);
      emitTypingChange(newValue, onTypingChange, lastTypingSentRef);
    };

    const handleSubmit = (): void => {
      onTypingChange?.(false);
      lastTypingSentRef.current = 0;
      if (!aiEnabled && onSubmitUserOnly) {
        onSubmitUserOnly();
      } else if (budget.fundingSource !== 'denied') {
        onSubmit(budget.fundingSource);
      }
    };

    const handleQueue = (): void => {
      const text = value.trim();
      if (text.length === 0) return;
      onQueue?.(text);
      onChange('');
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!isSubmitKeyEvent(e)) return;
      if (isProcessing) {
        if (canQueue) {
          e.preventDefault();
          handleQueue();
        }
        return;
      }
      if (canSubmit) {
        onTypingChange?.(false);
        lastTypingSentRef.current = 0;
        if (!aiEnabled && onSubmitUserOnly) {
          e.preventDefault();
          onSubmitUserOnly();
        } else if (budget.fundingSource !== 'denied') {
          e.preventDefault();
          onSubmit(budget.fundingSource);
        }
      }
    };

    const toolbar = (
      <PromptToolbar
        activeModality={activeModality}
        isAuthenticated={isAuthenticated}
        onSelectModality={onSelectModality}
        searchProps={searchProps}
        isGroupChat={isGroupChat}
        aiEnabled={aiEnabled}
        onToggleAi={() => {
          setAiEnabled((previous) => !previous);
        }}
      />
    );

    const buttonDisabled = isProcessing ? !canQueue : !canSubmit;
    const sendButton = (
      <>
        {showQueueFullHint && (
          <span data-testid={TEST_IDS.queueFullHint} className="text-muted-foreground text-xs">
            Queue full ({queueCount})
          </span>
        )}
        {/* The effort chip sits immediately left of Send (founder ruling
            2026-07-23); it renders nothing (collapsed slide wrapper) unless
            the selected model offers reasoning levels. */}
        <ReasoningEffortMenu
          isAuthenticated={isAuthenticated !== false}
          maxOutputTokens={budget.maxOutputTokens}
          estimatedInputTokens={budget.estimatedInputTokens}
        />
        <Button
          id="send-button"
          type="button"
          size="icon"
          onClick={isProcessing ? handleQueue : handleSubmit}
          disabled={buttonDisabled}
          aria-label={BUTTON_ARIA_LABELS[String(!buttonDisabled) as 'true' | 'false']}
          data-testid={TEST_IDS.sendButton}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </Button>
      </>
    );

    return (
      <div className={cn('w-full', className)}>
        <div className="border-border-strong bg-background dark:border-input flex w-full flex-col rounded-md border">
          <AnimatedHeight>
            {isEditing ? (
              <div className="border-border flex items-center justify-between border-b px-3 py-2">
                <div className="flex items-center gap-1.5 text-sm">
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Editing message</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onCancelEdit}
                  aria-label="Cancel"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Cancel
                </Button>
              </div>
            ) : null}
          </AnimatedHeight>
          <div className="relative">
            <Textarea
              ref={textareaRef}
              id="prompt-input"
              data-testid={TEST_IDS.promptInput}
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder=""
              aria-label={placeholder}
              rows={rows}
              disabled={disabled}
              style={{ minHeight, maxHeight }}
              className="resize-none overflow-y-auto border-0 text-base focus-visible:ring-0"
            />
            {value.length === 0 && <AnimatedPlaceholder text={placeholder} />}
          </div>

          <div className="border-border border-t">
            <MorphHeight>
              <BottomRows
                activeModality={activeModality}
                capacity={{
                  currentUsage: budget.capacityCurrentUsage,
                  maxCapacity: budget.capacityMaxCapacity,
                }}
                toolbar={toolbar}
                sendButton={sendButton}
              />
            </MorphHeight>
          </div>
        </div>

        <StableContent isStable={isAppStable}>
          <BudgetMessages errors={budget.notifications} className="mt-2" />
        </StableContent>
      </div>
    );
  }
);
