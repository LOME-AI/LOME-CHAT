/**
 * The "typing director": drives the REAL app to simulate a user, owning all
 * conversation navigation so every open starts on the new-chat page.
 *
 * Opening a conversation: route to the welcome screen, type its first prompt on
 * the welcome composer (the visible "typing on welcome"), then route into the
 * conversation and "fake a send" — instant-fill that prompt and submit the real
 * existing-conversation send, so the user message lands and the reply streams.
 * Remaining turns are then typed in the conversation. The group is opened the
 * same way (we type the opener), then its transcript replays over the socket.
 *
 * Conversations the user has already watched to the end are re-opened filled-in
 * with no ceremony. Sidebar links are intercepted so the director drives the
 * lead-in instead of jumping straight to the conversation. Humans can't type
 * (trusted composer events are blocked); any real interaction halts the script.
 */
import { shouldReduceMotion } from '@hushbox/ui';
import { MODALITY_ARIA_LABELS, ROUTES, TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import type { DemoModality } from './mock-backend/fixtures';

const INTRO_DELAY_MS = 600;
const TYPE_CHAR_MS = 28;
const SEND_PAUSE_MS = 420;
const WELCOME_HOLD_MS = 500;
const COMPOSER_POLL_MS = 100;
const COMPOSER_TIMEOUT_MS = 8000;
const VISIBILITY_POLL_MS = 200;
const RESET_SETTLE_MS = 350;
const STREAM_START_GRACE_MS = 250;
const STREAM_POLL_MS = 120;
const STREAM_MAX_MS = 25_000;
const STREAM_SETTLE_MS = 450;
const GROUP_TYPING_MS = 900;
const GROUP_GAP_MS = 2000;

const COMPOSER_SELECTOR = `[data-testid="${TEST_IDS.promptInput}"]`;
const SEND_SELECTOR = `[data-testid="${TEST_IDS.sendButton}"]`;
const WELCOME_SELECTOR = `[data-testid="${TEST_IDS.chatWelcome}"]`;
const CHAT_LINK_SELECTOR = `[data-testid="${TEST_IDS.chatLink}"]`;
const MESSAGE_LIST_SELECTOR = `[data-testid="${TEST_IDS.messageList}"]`;
const BLOCKED_INPUT_EVENTS: (keyof DocumentEventMap)[] = [
  'keydown',
  'beforeinput',
  'paste',
  'drop',
];

/** A replayed group transcript message's `message:new` fields. */
interface GroupMessageEvent {
  messageId: string;
  senderType: 'user' | 'ai';
  sequenceNumber: number;
  senderId?: string;
}

interface DirectorRouter {
  navigate: (path: string) => void;
}

/** The store surface the director drives playback against. */
interface DirectorBackend {
  resetConversation: (conversationId: string) => void;
  fillConversation: (conversationId: string) => void;
  getModality: (conversationId: string) => DemoModality | undefined;
  peekNextUserText: (conversationId: string) => string | null;
  isGroupConversation: (conversationId: string) => boolean;
  peekNextGroupText: (conversationId: string) => string | null;
  peekNextGroupMessage: (conversationId: string) => { typingUserId: string | null } | null;
  appendNextGroupMessage: (conversationId: string) => GroupMessageEvent | null;
}

interface DirectorOptions {
  /** Push a realtime event to the demo socket of a conversation (group replay). */
  emitRealtime: (conversationId: string, event: object) => void;
  /** Conversation auto-opened first on boot. */
  bootConversationId: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait one paint frame — long enough for React to commit a just-set composer
 * value (so the send fires) but too brief to perceptibly show a filled box.
 * `globalThis.requestAnimationFrame` is a one-shot paint gate, not an animation.
 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => {
      resolve();
    });
  });

/** Read through a call so TS doesn't narrow `aborted` to a constant across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_SELECTOR) !== null;
}

function conversationIdFromPath(pathname: string): string | null {
  const id = /\/chat\/([^/?]+)/.exec(pathname)?.[1];
  return id !== undefined && id !== 'new' ? decodeURIComponent(id) : null;
}

/** Set a controlled textarea's value so React's `onChange` fires (native setter + bubbling input). */
function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  // The native value setter is required to update a React-controlled textarea;
  // assigning `el.value` directly is swallowed by React's value tracking.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call below, never detached
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export async function typeText(
  el: HTMLTextAreaElement,
  text: string,
  perCharMs: number,
  signal: AbortSignal
): Promise<void> {
  for (let index = 1; index <= text.length; index += 1) {
    if (isAborted(signal)) return;
    setNativeValue(el, text.slice(0, index));
    if (perCharMs > 0) await delay(perCharMs);
  }
}

function blockTrustedComposerInput(event: Event): void {
  if (event.isTrusted && isComposerTarget(event.target)) event.preventDefault();
}

function uninstallHumanInputBlock(): void {
  for (const type of BLOCKED_INPUT_EVENTS) {
    document.removeEventListener(type, blockTrustedComposerInput, true);
  }
}

/** Block real human typing in the composer; the director's synthetic (untrusted) events pass. */
export function installHumanInputBlock(): () => void {
  for (const type of BLOCKED_INPUT_EVENTS) {
    document.addEventListener(type, blockTrustedComposerInput, true);
  }
  return uninstallHumanInputBlock;
}

/** Wait for an enabled composer that matches `where` (welcome screen present/absent). */
async function waitForComposer(
  signal: AbortSignal,
  where: () => boolean
): Promise<HTMLTextAreaElement | null> {
  const start = performance.now();
  for (;;) {
    if (isAborted(signal)) return null;
    const composer = document.querySelector<HTMLTextAreaElement>(COMPOSER_SELECTOR);
    if (composer && !composer.disabled && where()) return composer;
    if (performance.now() - start > COMPOSER_TIMEOUT_MS) return null;
    await delay(COMPOSER_POLL_MS);
  }
}

const onWelcome = (): boolean => document.querySelector(WELCOME_SELECTOR) !== null;
const inConversation = (): boolean => document.querySelector(WELCOME_SELECTOR) === null;

async function waitUntilOnScreen(signal: AbortSignal, isOnScreen: () => boolean): Promise<void> {
  while (!isOnScreen()) {
    if (isAborted(signal)) return;
    await delay(VISIBILITY_POLL_MS);
  }
}

function clickSend(): void {
  const button = document.querySelector<HTMLButtonElement>(SEND_SELECTOR);
  if (button && !button.disabled) button.click();
}

/** Switch the composer to a modality by clicking its real icon (untrusted → passes the user lock). */
function switchModality(modality: DemoModality): void {
  const button = document.querySelector<HTMLButtonElement>(
    `[aria-label="${MODALITY_ARIA_LABELS[modality]}"]`
  );
  if (button && !button.disabled) button.click();
}

/**
 * True while a reply is in flight, read from the app-emitted
 * `data-streaming-count` signal on the message list (the count of messages the
 * client is still streaming/persisting). Gating on this app state rather than
 * the send button's stop-icon geometry keeps the director decoupled from the
 * icon library's internal SVG markup.
 */
export function isStreaming(): boolean {
  const list = document.querySelector(MESSAGE_LIST_SELECTOR);
  const count = Number(list?.getAttribute(TEST_SIGNALS.streamingCount) ?? '0');
  return Number.isFinite(count) && count > 0;
}

/** Wait for the in-flight streamed reply to finish (the stop icon disappears), then settle. */
async function waitWhileStreaming(signal: AbortSignal): Promise<void> {
  await delay(STREAM_START_GRACE_MS);
  const start = performance.now();
  while (isStreaming()) {
    if (isAborted(signal)) return;
    if (performance.now() - start > STREAM_MAX_MS) break;
    await delay(STREAM_POLL_MS);
  }
  await delay(STREAM_SETTLE_MS);
}

interface PlayContext {
  readonly signal: AbortSignal;
  readonly isOnScreen: () => boolean;
  readonly backend: DirectorBackend;
  readonly invalidate: (conversationId: string) => void;
  readonly emitRealtime: (conversationId: string, event: object) => void;
  readonly navigate: (path: string) => void;
  readonly reduce: boolean;
}

const conversationPath = (conversationId: string): string => `${ROUTES.CHAT}/${conversationId}`;

/** Route to the welcome screen and type the opening prompt there (visible char-by-char). */
async function leadInOnWelcome(
  text: string,
  modality: DemoModality | undefined,
  context: PlayContext
): Promise<boolean> {
  context.navigate(ROUTES.CHAT);
  await waitUntilOnScreen(context.signal, context.isOnScreen);
  const composer = await waitForComposer(context.signal, onWelcome);
  if (composer === null) return false;
  if (modality !== undefined) switchModality(modality);
  await delay(context.reduce ? 0 : INTRO_DELAY_MS);
  await typeText(composer, text, context.reduce ? 0 : TYPE_CHAR_MS, context.signal);
  await delay(context.reduce ? 0 : WELCOME_HOLD_MS);
  return !isAborted(context.signal);
}

/**
 * Route into the conversation and "fake a send" of the opener: instant-fill the
 * composer and submit on the very next frame, so the message lands as a sent
 * bubble immediately — never a visibly-filled box being typed on the empty chat.
 */
async function fakeSendIntoConversation(
  conversationId: string,
  text: string,
  context: PlayContext
): Promise<boolean> {
  context.navigate(conversationPath(conversationId));
  await waitUntilOnScreen(context.signal, context.isOnScreen);
  const composer = await waitForComposer(context.signal, inConversation);
  if (composer === null) return false;
  await typeText(composer, text, 0, context.signal);
  await nextFrame();
  clickSend();
  await waitWhileStreaming(context.signal);
  return !isAborted(context.signal);
}

/** Type + send one continuation turn inside the already-open conversation. */
async function typeContinuationTurn(text: string, context: PlayContext): Promise<boolean> {
  await waitUntilOnScreen(context.signal, context.isOnScreen);
  const composer = await waitForComposer(context.signal, inConversation);
  if (composer === null) return false;
  await delay(context.reduce ? 0 : INTRO_DELAY_MS);
  await typeText(composer, text, context.reduce ? 0 : TYPE_CHAR_MS, context.signal);
  await delay(context.reduce ? 0 : SEND_PAUSE_MS);
  clickSend();
  await waitWhileStreaming(context.signal);
  return !isAborted(context.signal);
}

/** Open a solo (scripted) conversation: welcome lead-in → fake send → remaining turns. */
async function playSolo(conversationId: string, context: PlayContext): Promise<boolean> {
  context.backend.resetConversation(conversationId);
  context.invalidate(conversationId);
  const first = context.backend.peekNextUserText(conversationId);
  if (first === null) return false;
  const modality = context.backend.getModality(conversationId);
  if (!(await leadInOnWelcome(first, modality, context))) return false;
  if (!(await fakeSendIntoConversation(conversationId, first, context))) return false;
  for (;;) {
    /* v8 ignore next -- fakeSend/typeContinuationTurn return !isAborted, so reaching this loop top means the signal was not aborted; with no await between, this defensive re-check's aborted arm is unreachable */
    if (isAborted(context.signal)) return false;
    const next = context.backend.peekNextUserText(conversationId);
    if (next === null) return true;
    if (!(await typeContinuationTurn(next, context))) return false;
  }
}

type GroupEmitter = (event: object) => void;

/** A monotonic-timestamp emitter that stamps each event for one group socket. */
function groupEmitter(conversationId: string, context: PlayContext): GroupEmitter {
  let timestamp = 0;
  return (event) => {
    timestamp += 1;
    context.emitRealtime(conversationId, { timestamp, conversationId, ...event });
  };
}

/** Replay one transcript message (typing → append → message:new → stop). False = done/aborted. */
async function playGroupMessage(
  conversationId: string,
  context: PlayContext,
  emit: GroupEmitter
): Promise<boolean> {
  const peek = context.backend.peekNextGroupMessage(conversationId);
  if (peek === null) return false;
  const typingUser = peek.typingUserId;
  if (typingUser !== null) {
    emit({ type: 'typing:start', userId: typingUser });
    await delay(context.reduce ? 0 : GROUP_TYPING_MS);
    if (isAborted(context.signal)) return false;
  }
  const event = context.backend.appendNextGroupMessage(conversationId);
  if (event === null) return false;
  emit({ type: 'message:new', ...event });
  if (typingUser !== null) emit({ type: 'typing:stop', userId: typingUser });
  return true;
}

/** Route into the group and replay its transcript message-by-message over the socket. */
async function playGroupReplay(conversationId: string, context: PlayContext): Promise<void> {
  context.navigate(conversationPath(conversationId));
  await waitUntilOnScreen(context.signal, context.isOnScreen);
  if ((await waitForComposer(context.signal, inConversation)) === null) return;
  context.backend.resetConversation(conversationId);
  context.invalidate(conversationId);
  switchModality('text');
  await delay(context.reduce ? 0 : RESET_SETTLE_MS);

  const emit = groupEmitter(conversationId, context);
  for (;;) {
    if (isAborted(context.signal)) return;
    await waitUntilOnScreen(context.signal, context.isOnScreen);
    const played = await playGroupMessage(conversationId, context, emit);
    if (!played || isAborted(context.signal)) return;
    await delay(context.reduce ? 0 : GROUP_GAP_MS);
  }
}

/** Open the group: we type the opener on welcome, then the transcript replays. */
async function playGroupOpen(conversationId: string, context: PlayContext): Promise<boolean> {
  context.backend.resetConversation(conversationId);
  context.invalidate(conversationId);
  const opener = context.backend.peekNextGroupText(conversationId);
  if (opener === null) return false;
  if (!(await leadInOnWelcome(opener, 'text', context))) return false;
  await playGroupReplay(conversationId, context);
  return !isAborted(context.signal);
}

/** Re-open a watched conversation filled-in, with no welcome lead-in and no typing. */
function playWatched(conversationId: string, context: PlayContext): void {
  context.backend.fillConversation(conversationId);
  context.invalidate(conversationId);
  context.navigate(conversationPath(conversationId));
}

/** Open a conversation; mark it watched once it plays through to the end un-aborted. */
async function playOpen(
  conversationId: string,
  context: PlayContext,
  watched: Set<string>
): Promise<void> {
  if (watched.has(conversationId)) {
    playWatched(conversationId, context);
    return;
  }
  const finished = context.backend.isGroupConversation(conversationId)
    ? await playGroupOpen(conversationId, context)
    : await playSolo(conversationId, context);
  if (finished && !isAborted(context.signal)) watched.add(conversationId);
}

/**
 * Starts the director: auto-opens the boot conversation, intercepts sidebar
 * clicks to drive each open through the welcome lead-in, and blocks human
 * typing. Returns a disposer.
 */
export function startDirector(
  router: DirectorRouter,
  backend: DirectorBackend,
  invalidate: (conversationId: string) => void,
  options: DirectorOptions
): () => void {
  const { emitRealtime, bootConversationId } = options;
  const watched = new Set<string>();
  let currentPlay: AbortController | null = null;
  let visible = true;
  const isOnScreen = (): boolean => visible && !document.hidden;

  const open = (conversationId: string): void => {
    currentPlay?.abort();
    const controller = new AbortController();
    currentPlay = controller;
    void playOpen(
      conversationId,
      {
        signal: controller.signal,
        isOnScreen,
        backend,
        invalidate,
        emitRealtime,
        navigate: router.navigate,
        reduce: shouldReduceMotion(),
      },
      watched
    );
  };

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; visible?: boolean } | null;
    if (data?.type === 'hb-demo-visibility') visible = Boolean(data.visible);
  };
  const onInteraction = (event: Event): void => {
    if (event.isTrusted && !isComposerTarget(event.target)) currentPlay?.abort();
  };
  // Drive sidebar opens through the lead-in instead of letting the link jump
  // straight to the conversation (which would flash before the welcome screen).
  const onLinkClick = (event: MouseEvent): void => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const link = event.target.closest(CHAT_LINK_SELECTOR);
    if (link === null) return;
    const id = conversationIdFromPath(link.getAttribute('href') ?? '');
    if (id === null) return;
    event.preventDefault();
    event.stopPropagation();
    open(id);
  };

  globalThis.addEventListener('message', onMessage);
  document.addEventListener('pointerdown', onInteraction, true);
  document.addEventListener('click', onLinkClick, true);
  const uninstallBlock = installHumanInputBlock();

  open(bootConversationId);

  return () => {
    currentPlay?.abort();
    globalThis.removeEventListener('message', onMessage);
    document.removeEventListener('pointerdown', onInteraction, true);
    document.removeEventListener('click', onLinkClick, true);
    uninstallBlock();
  };
}
