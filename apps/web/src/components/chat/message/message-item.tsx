import * as React from 'react';
import { Check, Copy, GitBranch, Pencil, RefreshCw, Share2 } from 'lucide-react';
import {
  shortenModelName,
  friendlyErrorMessage,
  parseReasoningText,
  REASONING_EFFORT_LABELS,
  stageLabel,
  TEST_IDS,
} from '@hushbox/shared';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@hushbox/ui';
import { useModels } from '@/hooks/models/models';
import { getModelColor } from '@/lib/model-color';
import { getSenderLabel, isOwnMessage } from '@/lib/chat-sender';
import { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media';
import { omitUndefined } from '@/lib/optional-props';
import { MessageBody, type MessageBodyVariant } from '@/components/chat/message/message-body';
import { MediaPlaceholder } from '@/components/chat/media/media-preview';
import { MessageCost } from '@/components/chat/message/message-cost';
import { ThinkingDisclosure } from '@/components/chat/message/thinking-disclosure';
import { ThinkingIndicator } from '@/components/chat/indicators/thinking-indicator';
import { TtsStopButton } from '@/components/chat/indicators/tts-stop-button';
import { TtsStoppedNotice } from '@/components/chat/indicators/tts-stopped-notice';
import {
  buildMessageEnvelopeContext,
  messageMediaToRenderable,
  type MessageEnvelopeContext,
  type RenderableMedia,
} from '@/components/chat/media/media-content-item';
import type { ContentKey, WrappedSecret } from '@hushbox/crypto';
import type { MessageGroup, LinkInfo } from '@/lib/chat-sender';
import type { Message } from '@/lib/api';
import type { MessageAction } from '@/lib/message-actions';

// Lazy-load the markdown stack (streamdown → shiki/mermaid/katex) so a
// text-only chat never pulls it into the boot graph. The Suspense fallback
// shows the raw content as plain text, so a streaming message paints
// immediately while the chunk loads.
const MarkdownRenderer = React.lazy(async () => {
  const m = await import('@/components/chat/message/markdown-renderer');
  return { default: m.MarkdownRenderer };
});

function MarkdownTextFallback({ content }: Readonly<{ content: string }>): React.JSX.Element {
  return <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{content}</p>;
}

interface MemberInfo {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

interface MessageItemProps {
  message: Message;
  /** Set of actions allowed for this message, determined by resolveMessageActions */
  allowedActions: Set<MessageAction>;
  /** Whether this message is currently streaming */
  isStreaming?: boolean;
  /** Display name of the selected model, shown in thinking indicator */
  modelName?: string;
  isError?: boolean;
  onShare?: (messageId: string) => void;
  /** Called when user clicks regenerate (AI) or retry (user) */
  onRegenerate?: (messageId: string) => void;
  /** Called when user clicks edit on a user message */
  onEdit?: (messageId: string, content: string) => void;
  /** Called when user clicks fork on any message */
  onFork?: (messageId: string) => void;
  /** Group of consecutive messages (group chat mode) */
  group?: MessageGroup;
  /** Whether this is a group chat with multiple members */
  isGroupChat?: boolean;
  /** Current user's ID for determining alignment and labels */
  currentUserId?: string;
  /** Group chat members for resolving sender names */
  members?: MemberInfo[];
  /** Shared links for resolving link guest sender names */
  links?: LinkInfo[];
}

function computeContainerClasses(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): string {
  // Bottom padding reserves space for the absolute-positioned action button
  // row (`translate-y-full` from the bubble) so the row's measured height
  // includes the buttons and the next item doesn't overlap them.
  if (!isUser) {
    return cn('pt-1.5 pb-8', 'w-full px-4');
  }
  if (isGroupedUser && !ownMessage) {
    return cn('pt-1.5 pb-8', 'mr-auto ml-4 w-fit max-w-[82%]');
  }
  return cn('pt-1.5 pb-8', 'mr-4 ml-auto w-fit max-w-[82%]');
}

function computeBubbleVariant(
  isUser: boolean,
  isGroupedUser: boolean,
  ownMessage: boolean
): MessageBodyVariant {
  if (!isUser) return 'assistant';
  if (isGroupedUser && !ownMessage) return 'user-other';
  return 'user-own';
}

function TooltipIconButton({
  label,
  tooltip,
  icon,
  onClick,
}: Readonly<{
  label: string;
  tooltip?: string;
  icon: React.ReactNode;
  onClick: () => void;
}>): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClick}
          aria-label={label}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{tooltip ?? label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function CopyButton({
  copied,
  onCopy,
}: Readonly<{
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element {
  return (
    <TooltipIconButton
      label={copied ? 'Copied' : 'Copy'}
      tooltip={copied ? 'Copied!' : 'Copy'}
      icon={
        copied ? (
          <Check className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Copy className="h-3 w-3" aria-hidden="true" />
        )
      }
      onClick={onCopy}
    />
  );
}

interface UserActionEntry {
  key: string;
  render: () => React.JSX.Element;
}

function UserMessageActions({
  message,
  allowedActions,
  onRegenerate,
  onEdit,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  message: Message;
  allowedActions: Set<MessageAction>;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element | null {
  const actions: UserActionEntry[] = [];

  if (allowedActions.has('retry') && onRegenerate) {
    const handler = onRegenerate;
    actions.push({
      key: 'retry',
      render: () => (
        <TooltipIconButton
          label="Retry"
          icon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('edit') && onEdit) {
    const handler = onEdit;
    actions.push({
      key: 'edit',
      render: () => (
        <TooltipIconButton
          label="Edit"
          icon={<Pencil className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id, message.content);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('fork') && onFork) {
    const handler = onFork;
    actions.push({
      key: 'fork',
      render: () => (
        <TooltipIconButton
          label="Fork"
          icon={<GitBranch className="h-3 w-3" aria-hidden="true" />}
          onClick={() => {
            handler(message.id);
          }}
        />
      ),
    });
  }

  if (allowedActions.has('copy')) {
    actions.push({
      key: 'copy',
      render: () => <CopyButton copied={copied} onCopy={onCopy} />,
    });
  }

  if (actions.length === 0) return null;

  return (
    <div
      data-testid={TEST_IDS.messageActions}
      className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-center justify-end px-1"
    >
      <div className="ml-auto flex items-center gap-0.5">
        {actions.map((a) => (
          <React.Fragment key={a.key}>{a.render()}</React.Fragment>
        ))}
      </div>
    </div>
  );
}

function MessageActions({
  primaryMessage,
  allowedActions,
  onShare,
  onRegenerate,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  primaryMessage: Message;
  allowedActions: Set<MessageAction>;
  onShare?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onFork?: (messageId: string) => void;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element {
  const showRegenerate = allowedActions.has('regenerate') && onRegenerate;
  const showFork = allowedActions.has('fork') && onFork;
  const showShare = allowedActions.has('share') && onShare;
  const showCopy = allowedActions.has('copy');

  return (
    <div
      data-testid={TEST_IDS.messageActions}
      className="absolute right-0 -bottom-1 left-0 flex translate-y-full items-end gap-2 px-1"
    >
      <div className="flex items-center gap-0.5">
        {showRegenerate && (
          <TooltipIconButton
            label="Regenerate"
            icon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onRegenerate(primaryMessage.id);
            }}
          />
        )}
        {showFork && (
          <TooltipIconButton
            label="Fork"
            icon={<GitBranch className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onFork(primaryMessage.id);
            }}
          />
        )}
        {showShare && (
          <TooltipIconButton
            label="Share"
            icon={<Share2 className="h-3 w-3" aria-hidden="true" />}
            onClick={() => {
              onShare(primaryMessage.id);
            }}
          />
        )}
        {showCopy && <CopyButton copied={copied} onCopy={onCopy} />}
      </div>

      {primaryMessage.cost && (
        <span className="inline-flex h-7 items-center">
          <MessageCost cost={primaryMessage.cost} />
        </span>
      )}
    </div>
  );
}

interface MessageDisplayState {
  isGroupedUser: boolean;
  effectiveRole: string;
  isUser: boolean;
  senderLabel: string | undefined;
  ownMessage: boolean;
  messagesToRender: Message[];
  primaryMessage: Message;
}

interface MessageDisplayInput {
  message: Message;
  group: MessageGroup | undefined;
  isGroupChat: boolean | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
  links: LinkInfo[] | undefined;
}

interface GroupIdentityInput {
  isGroupedUser: boolean;
  group: MessageGroup | undefined;
  currentUserId: string | undefined;
  members: MemberInfo[] | undefined;
  links: LinkInfo[] | undefined;
}

function resolveGroupIdentity(input: GroupIdentityInput): {
  senderLabel: string | undefined;
  ownMessage: boolean;
} {
  const { isGroupedUser, group, currentUserId, members, links } = input;
  if (!isGroupedUser || !currentUserId || !group) {
    return { senderLabel: undefined, ownMessage: true };
  }
  return {
    senderLabel: getSenderLabel({
      senderId: group.senderId,
      currentUserId,
      members: members ?? [],
      isGroupChat: true,
      links: links ?? [],
    }),
    ownMessage: isOwnMessage(group.senderId, currentUserId),
  };
}

function computeMessageDisplayState(input: MessageDisplayInput): MessageDisplayState {
  const { message, group, isGroupChat, currentUserId, members, links } = input;
  const isGroupedUser = !!group && group.role === 'user' && !!isGroupChat;
  const effectiveRole = group ? group.role : message.role;
  const isUser = effectiveRole === 'user';
  const { senderLabel, ownMessage } = resolveGroupIdentity({
    isGroupedUser,
    group,
    currentUserId,
    members,
    links,
  });
  const messagesToRender = isGroupedUser ? group.messages : [message];
  const primaryMessage = messagesToRender[0] ?? message;
  return {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  };
}

/**
 * Map a message's persisted media items onto the shared `RenderableMedia`
 * shape, position-sorted. Returns [] when the message carries no media or is
 * missing the wrap-once envelope fields needed to decrypt them, so a text-only
 * message renders no media container. When `envelope` is set (the epoch key
 * has resolved) each item is stamped with the location-bound decryptor; while
 * it is undefined the items render as loading until the key lands.
 */
/**
 * Assemble the message-level envelope context for a message's media. `senderId`
 * canonicalizes a null/scrubbed sender to '' — the exact value the server bound
 * into the content-location AAD (mirrors the text path's reconstruction).
 */
function mediaEnvelopeContextFor(
  message: Message,
  contentKey: ContentKey | null,
  wrappedContentKey: WrappedSecret | null
): MessageEnvelopeContext | undefined {
  return buildMessageEnvelopeContext({
    contentKey,
    wrappedContentKey,
    conversationId: message.conversationId,
    messageId: message.id,
    epochNumber: message.epochNumber,
    senderId: message.senderId ?? '',
  });
}

function buildRenderableMedia(
  message: Message,
  envelope: MessageEnvelopeContext | undefined
): RenderableMedia[] {
  const { mediaItems, wrappedContentKey, epochNumber } = message;
  if (!mediaItems || mediaItems.length === 0) return [];
  if (!wrappedContentKey || epochNumber === undefined) return [];
  return mediaItems
    .toSorted((a, b) => a.position - b.position)
    .map((item) => messageMediaToRenderable(item, envelope));
}

const MEDIA_LOADING_LABEL_BY_TYPE: Record<'image' | 'audio' | 'video', string> = {
  image: 'Generating image…',
  video: 'Generating video…',
  audio: 'Generating audio…',
};

function MediaInFlightPlaceholder({
  mediaType,
  aspectRatio,
  progressPercent,
}: Readonly<{
  mediaType: 'image' | 'audio' | 'video';
  aspectRatio: string | undefined;
  progressPercent: number | undefined;
}>): React.JSX.Element {
  const loadingLabel = MEDIA_LOADING_LABEL_BY_TYPE[mediaType];
  return (
    <MediaPlaceholder
      width={null}
      height={null}
      status="loading"
      loadingLabel={loadingLabel}
      {...(aspectRatio !== undefined && { aspectRatio })}
      {...(progressPercent !== undefined && { progressPercent })}
    />
  );
}

function StreamingPlaceholder({
  primaryMessage,
  modelName,
  models,
}: Readonly<{
  primaryMessage: Message;
  modelName: string | undefined;
  models: ReturnType<typeof useModels>['data'] | undefined;
}>): React.JSX.Element {
  // A media turn carries `mediaInFlight` from the first frame (stamped at
  // creation), so the backdrop shows immediately — EXCEPT while a pre-inference
  // stage runs: the "Choosing the best model…" label wins briefly so it isn't
  // hidden for media Smart-Model turns.
  const mediaInFlight = primaryMessage.mediaInFlight;
  if (mediaInFlight && primaryMessage.classifyingStageId === undefined) {
    return (
      <MediaInFlightPlaceholder
        mediaType={mediaInFlight.mediaType}
        aspectRatio={mediaInFlight.aspectRatio}
        progressPercent={primaryMessage.mediaProgress?.percent}
      />
    );
  }
  return (
    <ThinkingPlaceholder primaryMessage={primaryMessage} modelName={modelName} models={models} />
  );
}

function ThinkingPlaceholder({
  primaryMessage,
  modelName,
  models,
}: Readonly<{
  primaryMessage: Message;
  modelName: string | undefined;
  models: ReturnType<typeof useModels>['data'] | undefined;
}>): React.JSX.Element {
  const rawModelName = primaryMessage.modelName ?? modelName ?? '';
  const resolved = models?.models.find((m) => m.id === rawModelName);
  // While a pre-inference stage is running (e.g., Smart Model classifier),
  // replace the model-name placeholder with the stage label — the slot
  // doesn't yet know which model will run.
  const stageId = primaryMessage.classifyingStageId;
  const indicatorProps = stageId
    ? {
        modelName: resolved?.name ?? rawModelName,
        stageLabel: stageLabel(stageId),
      }
    : { modelName: resolved?.name ?? rawModelName };
  return <ThinkingIndicator {...indicatorProps} />;
}

/**
 * The thinking-disclosure slot above the answer. Rendered OUTSIDE the
 * aria-live region: the disclosure's streaming preview is aria-hidden and its
 * expanded thoughts must never be announced token-by-token — the
 * role="status" ThinkingIndicator is the sole live announcement surface.
 */
function AIThinkingSlot({
  primaryMessage,
  isStreaming,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
}>): React.JSX.Element | null {
  if (primaryMessage.errorCode !== undefined) return null;
  return (
    <ThinkingDisclosure
      content={primaryMessage.content}
      isStreaming={isStreaming}
      reasoningTokens={primaryMessage.reasoningTokens}
    />
  );
}

function AIMessageContent({
  primaryMessage,
  isStreaming,
  modelName,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  modelName: string | undefined;
}>): React.JSX.Element {
  const { data: modelsData } = useModels();

  if (primaryMessage.errorCode) {
    return (
      <p className="text-destructive text-sm" data-testid={TEST_IDS.modelErrorMessage}>
        {friendlyErrorMessage(primaryMessage.errorCode)}
      </p>
    );
  }
  // Reasoning arrives embedded in the same text field (storage doctrine: store
  // raw, parse on demand) — only the parsed answer feeds the markdown stack,
  // so the placeholder must key on the ANSWER being empty, not the raw text:
  // while a reasoning model streams thoughts, the raw text is non-empty but
  // the role="status" ThinkingIndicator stays until the first answer token.
  const { answer } = parseReasoningText(primaryMessage.content);
  if (isStreaming && answer === '') {
    return (
      <StreamingPlaceholder
        primaryMessage={primaryMessage}
        modelName={modelName}
        models={modelsData}
      />
    );
  }
  return (
    <React.Suspense fallback={<MarkdownTextFallback content={answer} />}>
      <MarkdownRenderer content={answer} isStreaming={isStreaming} />
    </React.Suspense>
  );
}

function UserMessageContent({
  messagesToRender,
  isGroupedUser,
  message,
}: Readonly<{
  messagesToRender: Message[];
  isGroupedUser: boolean;
  message: Message;
}>): React.JSX.Element {
  if (isGroupedUser) {
    return (
      <>
        {messagesToRender.map((msg, index) => (
          <p
            key={msg.id}
            className={cn(
              'text-base leading-relaxed break-words whitespace-pre-wrap',
              index > 0 && 'mt-3'
            )}
          >
            {msg.content}
          </p>
        ))}
      </>
    );
  }
  return (
    <p className="text-base leading-relaxed break-words whitespace-pre-wrap">{message.content}</p>
  );
}

/**
 * The nametag is shown when the assistant message has visible content of any
 * kind: text body, an in-flight stream, or persisted media items. Pure media
 * responses (image/video/audio) carry empty `content` but still need the
 * nametag so the user can see which model produced the media.
 */
function shouldRenderAIMessageNametag(message: Message, isStreaming: boolean | undefined): boolean {
  if (message.content !== '') return true;
  if (isStreaming === true) return true;
  return (message.mediaItems?.length ?? 0) > 0;
}

/**
 * One badge sitting beside the model name (Smart routing, reasoning effort).
 * Shared so every nametag badge is the same chip rather than a copy of its
 * classes.
 */
function NametagChip({
  testId,
  title,
  children,
}: Readonly<{
  testId: string;
  title: string;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className="border-border text-muted-foreground inline-block rounded border px-1.5 py-0.5 text-[10px] tracking-wide uppercase"
      title={title}
    >
      {children}
    </span>
  );
}

function AIMessageNametag({
  primaryMessage,
  modelName,
}: Readonly<{
  primaryMessage: Message;
  modelName: string | undefined;
}>): React.JSX.Element {
  const { data: modelsData } = useModels();

  const nametagText = (() => {
    if (primaryMessage.modelName) {
      const resolved = modelsData?.models.find((m) => m.id === primaryMessage.modelName);
      // resolvedModelName (set during streaming after stage:done) takes
      // precedence over a useModels lookup that may not yet have hydrated
      // the resolved id — keeps the nametag stable across the resolve event.
      const liveDisplay = primaryMessage.resolvedModelName ?? resolved?.name;
      return shortenModelName(liveDisplay ?? primaryMessage.modelName);
    }
    return modelName ? shortenModelName(modelName) : 'AI';
  })();

  const color = getModelColor(primaryMessage.modelName ?? modelName ?? 'AI');

  return (
    <span
      data-testid={TEST_IDS.modelNametagContainer}
      className="mb-0.5 inline-flex items-center gap-1"
    >
      <span
        data-testid={TEST_IDS.modelNametag}
        className="inline-block rounded bg-[var(--nametag-bg)] px-1.5 py-0.5 text-xs text-[var(--nametag-fg)] dark:bg-[var(--nametag-bg-dark)] dark:text-[var(--nametag-fg-dark)]"
        style={
          {
            '--nametag-bg': color.bg,
            '--nametag-fg': color.fg,
            '--nametag-bg-dark': color.bgDark,
            '--nametag-fg-dark': color.fgDark,
          } as React.CSSProperties
        }
      >
        {nametagText}
      </span>
      {primaryMessage.isSmartModel && (
        <NametagChip
          testId={TEST_IDS.smartModelChip}
          title="This response was routed by Smart Model"
        >
          Smart
        </NametagChip>
      )}
      {primaryMessage.reasoningEffort !== undefined && (
        <NametagChip
          testId={TEST_IDS.messageEffortChip}
          title={`This response ran at ${REASONING_EFFORT_LABELS[primaryMessage.reasoningEffort]} reasoning effort`}
        >
          {REASONING_EFFORT_LABELS[primaryMessage.reasoningEffort]}
        </NametagChip>
      )}
      <TtsStopButton messageId={primaryMessage.id} />
    </span>
  );
}

function MessageActionButtons({
  isUser,
  primaryMessage,
  allowedActions,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  copied,
  onCopy,
}: Readonly<{
  isUser: boolean;
  primaryMessage: Message;
  allowedActions: Set<MessageAction>;
  onShare?: ((messageId: string) => void) | undefined;
  onRegenerate?: ((messageId: string) => void) | undefined;
  onEdit?: ((messageId: string, content: string) => void) | undefined;
  onFork?: ((messageId: string) => void) | undefined;
  copied: boolean;
  onCopy: () => void;
}>): React.JSX.Element | null {
  if (isUser) {
    return (
      <UserMessageActions
        message={primaryMessage}
        allowedActions={allowedActions}
        {...omitUndefined({ onRegenerate, onEdit, onFork })}
        copied={copied}
        onCopy={onCopy}
      />
    );
  }

  return (
    <MessageActions
      primaryMessage={primaryMessage}
      allowedActions={allowedActions}
      {...omitUndefined({ onShare, onRegenerate, onFork })}
      copied={copied}
      onCopy={onCopy}
    />
  );
}

export function MessageItem({
  message,
  allowedActions,
  isStreaming,
  modelName,
  isError,
  onShare,
  onRegenerate,
  onEdit,
  onFork,
  group,
  isGroupChat,
  currentUserId,
  members,
  links,
}: Readonly<MessageItemProps>): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);

  const {
    isGroupedUser,
    effectiveRole,
    isUser,
    senderLabel,
    ownMessage,
    messagesToRender,
    primaryMessage,
  } = computeMessageDisplayState({ message, group, isGroupChat, currentUserId, members, links });

  // Media lives on the individual `message` for user bubbles and on the
  // representative `primaryMessage` for assistant bubbles (group chat collapses
  // consecutive user messages, never assistant ones). Resolve the content key
  // ONCE here and hand it to the shared media list.
  const mediaSourceMessage = isUser ? message : primaryMessage;
  const {
    contentKey,
    wrappedContentKey: contentKeyWrap,
    error: contentKeyError,
  } = useMessageContentKey(
    mediaSourceMessage.conversationId,
    mediaSourceMessage.epochNumber ?? 0,
    mediaSourceMessage.wrappedContentKey ?? ''
  );
  // Complete once the epoch key resolves; until then media items render as
  // loading.
  const envelopeContext = mediaEnvelopeContextFor(mediaSourceMessage, contentKey, contentKeyWrap);
  const media = buildRenderableMedia(mediaSourceMessage, envelopeContext);

  const handleCopy = async (): Promise<void> => {
    // Clipboard is a user-facing surface: assistant text may embed reasoning
    // in the same field (storage doctrine), so copy emits the parsed answer.
    // User content copies verbatim, matching display.
    const allContent = messagesToRender
      .map((m) => (m.role === 'assistant' ? parseReasoningText(m.content).answer : m.content))
      .join('\n\n');
    await navigator.clipboard.writeText(allContent);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const containerClasses = computeContainerClasses(isUser, isGroupedUser, ownMessage);
  const bubbleVariant = computeBubbleVariant(isUser, isGroupedUser, ownMessage);

  return (
    <div className="mx-auto w-full max-w-3xl">
      {senderLabel && (
        <p
          data-testid={TEST_IDS.senderLabel}
          className={cn(
            'text-foreground mt-1 px-1 text-xs',
            ownMessage ? 'mr-4 text-right' : 'ml-4'
          )}
        >
          {senderLabel}
        </p>
      )}
      <div
        data-testid={TEST_IDS.messageItem}
        data-role={effectiveRole}
        data-message-id={primaryMessage.id}
        {...(isError ? { 'data-error': 'true' } : {})}
        className={containerClasses}
      >
        <div className="relative">
          <MessageBody
            variant={bubbleVariant}
            media={media}
            // Member media decrypts via each item's `envelope`; the legacy
            // message-level content-key channel is unused on this path.
            contentKey={null}
            contentKeyError={contentKeyError}
            ariaPrefix="Generated"
          >
            {isUser ? (
              <UserMessageContent
                messagesToRender={messagesToRender}
                isGroupedUser={isGroupedUser}
                message={message}
              />
            ) : (
              <>
                <TtsStoppedNotice messageId={primaryMessage.id} />
                {shouldRenderAIMessageNametag(primaryMessage, isStreaming) && (
                  <AIMessageNametag primaryMessage={primaryMessage} modelName={modelName} />
                )}
                <AIThinkingSlot primaryMessage={primaryMessage} isStreaming={isStreaming} />
                <div
                  data-testid={TEST_IDS.aiMessageLiveRegion}
                  aria-live={isStreaming === true ? 'polite' : 'off'}
                  aria-atomic="false"
                  className="w-full overflow-hidden text-base leading-relaxed break-words"
                >
                  <AIMessageContent
                    primaryMessage={primaryMessage}
                    isStreaming={isStreaming}
                    modelName={modelName}
                  />
                </div>
              </>
            )}
          </MessageBody>

          <MessageActionButtons
            isUser={isUser}
            primaryMessage={primaryMessage}
            allowedActions={allowedActions}
            onShare={onShare}
            onRegenerate={onRegenerate}
            onEdit={onEdit}
            onFork={onFork}
            copied={copied}
            onCopy={() => void handleCopy()}
          />
        </div>
      </div>
    </div>
  );
}
