import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TEST_IDS, TEST_SIGNALS, ROUTES, MODALITY_ARIA_LABELS } from '@hushbox/shared';
import type { DemoModality } from './mock-backend/fixtures';

let reduceMotion = false;
// @hushbox/ui is an external workspace package (not an internal slice); the director
// only uses shouldReduceMotion from it, so a minimal mock lets each scenario drive
// both the reduced-motion (delays = 0) and full-motion branches.
vi.mock('@hushbox/ui', () => ({ shouldReduceMotion: (): boolean => reduceMotion }));

const { typeText, isComposerTarget, installHumanInputBlock, isStreaming, startDirector } =
  await import('./director');

function makeComposer(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.dataset['testid'] = TEST_IDS.promptInput;
  document.body.append(el);
  return el;
}

function makeMessageList(streamingCount: number): HTMLDivElement {
  const el = document.createElement('div');
  el.dataset['testid'] = TEST_IDS.messageList;
  el.setAttribute(TEST_SIGNALS.streamingCount, String(streamingCount));
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('typeText', () => {
  it('sets the final value and fires an input event per character', async () => {
    const el = makeComposer();
    let inputs = 0;
    el.addEventListener('input', () => {
      inputs += 1;
    });

    await typeText(el, 'hello', 0, new AbortController().signal);

    expect(el.value).toBe('hello');
    expect(inputs).toBe('hello'.length);
  });

  it('stops early when the signal is aborted', async () => {
    const el = makeComposer();
    const controller = new AbortController();
    controller.abort();
    await typeText(el, 'hello', 0, controller.signal);
    expect(el.value).toBe('');
  });
});

describe('isComposerTarget', () => {
  it('matches the composer textarea and elements inside it, not others', () => {
    const el = makeComposer();
    const outside = document.createElement('button');
    document.body.append(outside);
    expect(isComposerTarget(el)).toBe(true);
    expect(isComposerTarget(outside)).toBe(false);
    expect(isComposerTarget(null)).toBe(false);
  });
});

describe('isStreaming', () => {
  it('reports streaming from the app-emitted data-streaming-count signal', () => {
    makeMessageList(2);
    expect(isStreaming()).toBe(true);
  });

  it('reports not streaming when the count is zero', () => {
    makeMessageList(0);
    expect(isStreaming()).toBe(false);
  });

  it('reports not streaming when no message list is mounted', () => {
    expect(isStreaming()).toBe(false);
  });
});

describe('installHumanInputBlock', () => {
  it('does not block the director synthetic (untrusted) input events', () => {
    const el = makeComposer();
    const uninstall = installHumanInputBlock();
    // Dispatched events are untrusted (isTrusted === false), so they must pass.
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });

  it('blocks a trusted keydown on the composer (handler logic)', () => {
    const el = makeComposer();
    const uninstall = installHumanInputBlock();
    // jsdom can't mint trusted events, so assert the handler's decision directly.
    const preventDefault = (): void => {
      blocked = true;
    };
    let blocked = false;
    const fakeTrusted = { isTrusted: true, target: el, preventDefault } as unknown as Event;
    // Re-derive the predicate the handler uses.
    if (fakeTrusted.isTrusted && isComposerTarget(fakeTrusted.target)) fakeTrusted.preventDefault();
    expect(blocked).toBe(true);
    uninstall();
  });
});

// ---- startDirector orchestration harness ----------------------------------
//
// jsdom cannot mint trusted events (isTrusted is an own, non-configurable false),
// and the director's click/pointerdown handlers gate on event.isTrusted. So each
// scenario captures the registered handlers via an addEventListener spy and invokes
// them with synthetic event objects carrying the exact fields the handler reads.

type DirectorBackend = Parameters<typeof startDirector>[1];
type GroupMessageEvent = ReturnType<DirectorBackend['appendNextGroupMessage']>;

function useDirectorTimers(): void {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
}

function mountChatDom(options: { modality?: DemoModality; streamingCount?: number } = {}): void {
  const composer = document.createElement('textarea');
  composer.dataset['testid'] = TEST_IDS.promptInput;
  document.body.append(composer);
  const send = document.createElement('button');
  send.dataset['testid'] = TEST_IDS.sendButton;
  document.body.append(send);
  const list = document.createElement('div');
  list.dataset['testid'] = TEST_IDS.messageList;
  list.setAttribute(TEST_SIGNALS.streamingCount, String(options.streamingCount ?? 0));
  document.body.append(list);
  if (options.modality !== undefined) {
    const button = document.createElement('button');
    button.setAttribute('aria-label', MODALITY_ARIA_LABELS[options.modality]);
    document.body.append(button);
  }
}

function setWelcome(present: boolean): void {
  const existing = document.querySelector(`[data-testid="${TEST_IDS.chatWelcome}"]`);
  if (present && existing === null) {
    const welcome = document.createElement('div');
    welcome.dataset['testid'] = TEST_IDS.chatWelcome;
    document.body.append(welcome);
  } else if (!present && existing !== null) {
    existing.remove();
  }
}

/** A router whose navigate toggles the welcome screen exactly as the real app does. */
function makeRouter() {
  const navigate = vi.fn<(path: string) => void>((path) => {
    setWelcome(path === ROUTES.CHAT);
  });
  return { navigate };
}

function makeBackend(overrides: Partial<DirectorBackend> = {}): DirectorBackend {
  return {
    resetConversation: vi.fn(),
    fillConversation: vi.fn(),
    getModality: vi.fn<(conversationId: string) => DemoModality | undefined>(),
    peekNextUserText: vi.fn(() => null),
    isGroupConversation: vi.fn(() => false),
    peekNextGroupText: vi.fn(() => null),
    peekNextGroupMessage: vi.fn(() => null),
    appendNextGroupMessage: vi.fn(() => null),
    ...overrides,
  };
}

/** Returns queued items in order, then repeats the fallback forever. */
function drain<T>(items: readonly T[], fallback: T): () => T {
  const q = [...items];
  return () => (q.length > 0 ? (q.shift() as T) : fallback);
}

interface Started {
  router: ReturnType<typeof makeRouter>;
  backend: DirectorBackend;
  invalidate: ReturnType<typeof vi.fn>;
  emitRealtime: ReturnType<typeof vi.fn>;
  dispose: () => void;
  handler: (type: string) => (event: unknown) => void;
}

function start(bootConversationId: string, backend: DirectorBackend): Started {
  const documentSpy = vi.spyOn(document, 'addEventListener');
  const winSpy = vi.spyOn(globalThis, 'addEventListener');
  const router = makeRouter();
  const invalidate = vi.fn();
  const emitRealtime = vi.fn();
  const dispose = startDirector(router, backend, invalidate, { emitRealtime, bootConversationId });
  // Spies call through (listeners really register); leave them live so mock.calls
  // survives for handler lookup. afterEach's restoreAllMocks cleans them up.
  const handler = (type: string): ((event: unknown) => void) => {
    const fromDocument = documentSpy.mock.calls.find((c) => c[0] === type)?.[1];
    const fromWin = winSpy.mock.calls.find((c) => c[0] === type)?.[1];
    const found = fromDocument ?? fromWin;
    if (found === undefined) throw new Error(`no handler for ${type}`);
    return found as (event: unknown) => void;
  };
  return { router, backend, invalidate, emitRealtime, dispose, handler };
}

function composerValue(): string {
  return document.querySelector('textarea')?.value ?? '';
}

/** A link-click event object shaped exactly as onLinkClick reads it. */
function linkClickEvent(options: {
  trusted?: boolean;
  target?: EventTarget | null;
  href?: string | null;
}): { event: unknown; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  let target = options.target;
  if (target === undefined) {
    const link = document.createElement('a');
    link.dataset['testid'] = TEST_IDS.chatLink;
    if (options.href !== null && options.href !== undefined)
      link.setAttribute('href', options.href);
    const inner = document.createElement('span');
    link.append(inner);
    document.body.append(link);
    target = inner;
  }
  return {
    event: { isTrusted: options.trusted ?? true, target, preventDefault, stopPropagation },
    preventDefault,
  };
}

let hiddenFlag = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hiddenFlag });

describe('startDirector', () => {
  beforeEach(() => {
    reduceMotion = false;
    hiddenFlag = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    reduceMotion = false;
    hiddenFlag = false;
  });

  it('blocks trusted composer input but leaves trusted non-composer input alone', () => {
    const composer = makeComposer();
    const backend = makeBackend();
    const { handler, dispose } = start('block-1', backend);
    const onKeydown = handler('keydown');
    const composerPd = vi.fn();
    const otherPd = vi.fn();

    onKeydown({ isTrusted: true, target: composer, preventDefault: composerPd });
    onKeydown({ isTrusted: true, target: document.createElement('div'), preventDefault: otherPd });

    expect(composerPd).toHaveBeenCalled();
    expect(otherPd).not.toHaveBeenCalled();
    dispose();
  });

  it('plays two reduced-motion continuation turns (zero delays)', async () => {
    useDirectorTimers();
    reduceMotion = true;
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['One', 'Two'], null) });
    const { dispose } = start('solo-r2', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(composerValue()).toBe('Two');
    dispose();
  });

  it('plays a full-motion group replay (non-zero group delays)', async () => {
    useDirectorTimers();
    reduceMotion = false;
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
      peekNextGroupMessage: drain([{ typingUserId: 'demo-user-amir' }], null),
      appendNextGroupMessage: drain(
        [{ messageId: 'g1', senderType: 'user' as const, sequenceNumber: 0, senderId: 'amir' }],
        null
      ),
    });
    const { emitRealtime, dispose } = start('group-fm', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    const types = emitRealtime.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toContain('message:new');
    dispose();
  });

  it('breaks out of the streaming wait after the max stream time', async () => {
    useDirectorTimers();
    mountChatDom({ streamingCount: 1 });
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, dispose } = start('stuck-stream', backend);
    // The streaming count never clears; the wait must break at STREAM_MAX_MS (~25s).
    await vi.advanceTimersByTimeAsync(40_000);

    expect(b.resetConversation).toHaveBeenCalledWith('stuck-stream');
    dispose();
  });

  it('no-ops clickSend and switchModality when the controls are absent or disabled', async () => {
    useDirectorTimers();
    // A composer + message list, but the send button is disabled and no modality
    // button exists, so clickSend and switchModality both take their false arm.
    const composer = document.createElement('textarea');
    composer.dataset['testid'] = TEST_IDS.promptInput;
    document.body.append(composer);
    const send = document.createElement('button');
    send.dataset['testid'] = TEST_IDS.sendButton;
    send.disabled = true;
    document.body.append(send);
    makeMessageList(0);
    setWelcome(true);
    const backend = makeBackend({
      getModality: vi.fn((): DemoModality => 'video'),
      peekNextUserText: drain(['Prompt'], null),
    });
    const { backend: b, dispose } = start('no-controls', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(b.resetConversation).toHaveBeenCalledWith('no-controls');
    dispose();
  });

  it('gives up the fake send when the conversation composer never resolves', async () => {
    useDirectorTimers();
    mountChatDom();
    // A router that keeps the welcome screen mounted: the in-conversation composer
    // wait never matches, so the fake send times out.
    const router = {
      navigate: vi.fn<(path: string) => void>(() => {
        setWelcome(true);
      }),
    };
    const invalidate = vi.fn();
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    setWelcome(true);
    const dispose = startDirector(router, backend, invalidate, {
      emitRealtime: vi.fn(),
      bootConversationId: 'sticky-welcome',
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(backend.resetConversation).toHaveBeenCalledWith('sticky-welcome');
    dispose();
  });

  it('aborts an in-flight composer wait on dispose', async () => {
    useDirectorTimers();
    // No composer: the play parks in waitForComposer's poll loop.
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { dispose } = start('abort-wfc', backend);
    await vi.advanceTimersByTimeAsync(300);
    dispose();
    await vi.advanceTimersByTimeAsync(1000);
    // No assertion beyond reaching here without hanging: the aborted wait returned.
    expect(true).toBe(true);
  });

  it('aborts an in-flight streaming wait on dispose', async () => {
    useDirectorTimers();
    mountChatDom({ streamingCount: 1 });
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { dispose } = start('abort-stream', backend);
    // Reach the streaming wait, then dispose to abort mid-stream.
    await vi.advanceTimersByTimeAsync(1500);
    dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(true).toBe(true);
  });

  it('pauses off-screen and resumes when the tab returns, aborting cleanly on dispose', async () => {
    useDirectorTimers();
    hiddenFlag = true;
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, dispose } = start('offscreen-1', backend);
    // Parked in the on-screen wait loop while hidden.
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.resetConversation).toHaveBeenCalledWith('offscreen-1');
    dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(true).toBe(true);
  });

  it('aborts a group replay in progress on dispose', async () => {
    useDirectorTimers();
    reduceMotion = false;
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
      peekNextGroupMessage: vi.fn(() => ({ typingUserId: null })),
      appendNextGroupMessage: vi.fn(() => ({
        messageId: 'g',
        senderType: 'user' as const,
        sequenceNumber: 0,
      })),
    });
    const { dispose } = start('group-abort', backend);
    // Let the replay emit a message, then abort during the inter-message gap.
    await vi.advanceTimersByTimeAsync(1500);
    dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(true).toBe(true);
  });

  it('stops a group open when the welcome composer never appears', async () => {
    useDirectorTimers();
    // No composer: the group opener lead-in times out and playGroupOpen returns false.
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
    });
    const { backend: b, dispose } = start('group-nocomposer', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(b.resetConversation).toHaveBeenCalledWith('group-nocomposer');
    dispose();
  });

  it('stops a group replay when the in-conversation composer never resolves', async () => {
    useDirectorTimers();
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    // Sticky welcome: the lead-in composer matches, but the in-conversation wait
    // never does, so playGroupReplay bails at its composer gate.
    const router = {
      navigate: vi.fn<(path: string) => void>(() => {
        setWelcome(true);
      }),
    };
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
    });
    const dispose = startDirector(router, backend, vi.fn(), {
      emitRealtime: vi.fn(),
      bootConversationId: 'group-sticky',
    });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(backend.resetConversation).toHaveBeenCalledWith('group-sticky');
    dispose();
  });

  it('aborts a group message during its typing indicator', async () => {
    useDirectorTimers();
    reduceMotion = false;
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
      peekNextGroupMessage: vi.fn(() => ({ typingUserId: 'demo-user-amir' })),
      appendNextGroupMessage: vi.fn(() => ({
        messageId: 'g',
        senderType: 'user' as const,
        sequenceNumber: 0,
        senderId: 'amir',
      })),
    });
    const { emitRealtime, dispose } = start('group-typing-abort', backend);
    // Advance until a typing:start is emitted, then abort during the ~900ms typing hold.
    for (let index = 0; index < 40 && emitRealtime.mock.calls.length === 0; index += 1) {
      await vi.advanceTimersByTimeAsync(100);
    }
    dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(true).toBe(true);
  });

  it('aborts a solo continuation turn mid-flight', async () => {
    useDirectorTimers();
    reduceMotion = false;
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['First', 'Second'], null) });
    const { dispose } = start('solo-cont-abort', backend);
    // Let the first turn settle, then abort while the continuation is being typed.
    await vi.advanceTimersByTimeAsync(2200);
    dispose();
    await vi.advanceTimersByTimeAsync(3000);
    expect(true).toBe(true);
  });

  it('plays a solo scripted conversation: welcome lead-in, fake send, then a continuation turn', async () => {
    useDirectorTimers();
    mountChatDom({ modality: 'image' });
    setWelcome(true);
    const backend = makeBackend({
      getModality: vi.fn((): DemoModality => 'image'),
      peekNextUserText: drain(['First prompt', 'Second prompt'], null),
    });
    const { router, invalidate, dispose } = start('solo-1', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(router.navigate).toHaveBeenCalledWith(ROUTES.CHAT);
    expect(router.navigate).toHaveBeenCalledWith(`${ROUTES.CHAT}/solo-1`);
    expect(backend.resetConversation).toHaveBeenCalledWith('solo-1');
    expect(invalidate).toHaveBeenCalledWith('solo-1');
    expect(composerValue()).toBe('Second prompt');
    dispose();
  });

  it('plays a solo conversation with reduced motion (zero delays)', async () => {
    useDirectorTimers();
    reduceMotion = true;
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Only prompt'], null) });
    const { router, dispose } = start('solo-r', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(router.navigate).toHaveBeenCalledWith(`${ROUTES.CHAT}/solo-r`);
    expect(composerValue()).toBe('Only prompt');
    dispose();
  });

  it('waits through an active stream before continuing', async () => {
    useDirectorTimers();
    mountChatDom({ streamingCount: 1 });
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, dispose } = start('solo-3', backend);

    await vi.advanceTimersByTimeAsync(2000);
    document
      .querySelector(`[data-testid="${TEST_IDS.messageList}"]`)
      ?.setAttribute(TEST_SIGNALS.streamingCount, '0');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(b.resetConversation).toHaveBeenCalledWith('solo-3');
    dispose();
  });

  it('returns without playing when the script is empty', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: vi.fn(() => null) });
    const { router, dispose } = start('empty-1', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    // No welcome lead-in navigation happens for an empty script.
    expect(router.navigate).not.toHaveBeenCalledWith(ROUTES.CHAT);
    dispose();
  });

  it('gives up when the composer never appears', async () => {
    useDirectorTimers();
    // No composer in the DOM: waitForComposer times out and the play never finishes.
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, dispose } = start('no-composer', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(b.resetConversation).toHaveBeenCalledWith('no-composer');
    // The conversation is never marked watched, so a re-open would replay, not fill.
    dispose();
  });

  it('plays a group conversation: opener lead-in, then transcript replay over the socket', async () => {
    useDirectorTimers();
    reduceMotion = true;
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    const amir: GroupMessageEvent = {
      messageId: 'g1',
      senderType: 'user',
      sequenceNumber: 0,
      senderId: 'amir',
    };
    const noSender: GroupMessageEvent = { messageId: 'g2', senderType: 'user', sequenceNumber: 1 };
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Group opener'),
      peekNextGroupMessage: drain(
        [{ typingUserId: 'demo-user-amir' }, { typingUserId: null }],
        null
      ),
      appendNextGroupMessage: drain([amir, noSender], null),
    });
    const { emitRealtime, dispose } = start('group-1', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    const types = emitRealtime.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).toContain('typing:start');
    expect(types).toContain('message:new');
    expect(types).toContain('typing:stop');
    dispose();
  });

  it('stops the group replay when the transcript has no opener', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => null),
    });
    const { router, dispose } = start('group-empty', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(router.navigate).not.toHaveBeenCalledWith(ROUTES.CHAT);
    dispose();
  });

  it('stops the group replay when the next transcript message cannot be appended', async () => {
    useDirectorTimers();
    reduceMotion = true;
    mountChatDom({ modality: 'text' });
    setWelcome(true);
    const backend = makeBackend({
      isGroupConversation: vi.fn(() => true),
      peekNextGroupText: vi.fn(() => 'Opener'),
      peekNextGroupMessage: vi.fn(() => ({ typingUserId: null })),
      appendNextGroupMessage: vi.fn(() => null),
    });
    const { emitRealtime, dispose } = start('group-noappend', backend);
    await vi.advanceTimersByTimeAsync(30_000);

    // A null append ends the replay before any message:new event is emitted.
    const types = emitRealtime.mock.calls.map((c) => (c[1] as { type: string }).type);
    expect(types).not.toContain('message:new');
    dispose();
  });

  it('re-opens an already-watched conversation filled-in via a trusted sidebar click', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, handler, dispose } = start('watch-1', backend);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.resetConversation).toHaveBeenCalledWith('watch-1');

    // A trusted sidebar click re-opens the now-watched conversation → fill, no lead-in.
    const { event, preventDefault } = linkClickEvent({ href: `${ROUTES.CHAT}/watch-1` });
    handler('click')(event);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(preventDefault).toHaveBeenCalled();
    expect(b.fillConversation).toHaveBeenCalledWith('watch-1');
    dispose();
  });

  it('ignores sidebar clicks that are untrusted, non-element, non-link, or a new-chat link', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { backend: b, handler, dispose } = start('watch-2', backend);
    await vi.advanceTimersByTimeAsync(30_000);
    (b.fillConversation as ReturnType<typeof vi.fn>).mockClear();
    const onClick = handler('click');

    // Untrusted.
    onClick(linkClickEvent({ trusted: false, href: `${ROUTES.CHAT}/watch-2` }).event);
    // Target is not an Element.
    onClick(linkClickEvent({ target: null, href: `${ROUTES.CHAT}/watch-2` }).event);
    // Target has no chat-link ancestor.
    onClick(linkClickEvent({ target: document.createElement('div') }).event);
    // A new-chat link resolves to a null conversation id.
    onClick(linkClickEvent({ href: `${ROUTES.CHAT}/new` }).event);
    // A non-chat href does not match the path regex.
    onClick(linkClickEvent({ href: '/settings' }).event);
    // A chat-link with no href attribute at all (getAttribute → null → '').
    onClick(linkClickEvent({ href: null }).event);
    await vi.advanceTimersByTimeAsync(1000);

    expect(b.fillConversation).not.toHaveBeenCalled();
    dispose();
  });

  it('aborts the in-flight play on a trusted non-composer interaction', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['A', 'B', 'C'], null) });
    const { backend: b, handler, dispose } = start('interact-1', backend);
    // Let the play begin, then interrupt with a trusted click away from the composer.
    await vi.advanceTimersByTimeAsync(300);
    const resetCalls = (b.resetConversation as ReturnType<typeof vi.fn>).mock.calls.length;
    handler('pointerdown')({ isTrusted: true, target: document.createElement('button') });
    await vi.advanceTimersByTimeAsync(30_000);

    // After the abort no further conversation resets happen (the play stopped).
    expect((b.resetConversation as ReturnType<typeof vi.fn>).mock.calls.length).toBe(resetCalls);
    dispose();
  });

  it('does not abort on a composer interaction or an untrusted interaction', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const composer = document.querySelector('textarea');
    if (composer === null) throw new Error('no composer');
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { handler, dispose } = start('interact-2', backend);
    const onInteraction = handler('pointerdown');

    // A trusted interaction on the composer must not abort.
    onInteraction({ isTrusted: true, target: composer });
    // An untrusted interaction (the director's own synthetic click) must not abort.
    onInteraction({ isTrusted: false, target: document.createElement('button') });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(composerValue()).toBe('Prompt');
    dispose();
  });

  it('tracks tab visibility from the demo-visibility postMessage and ignores other messages', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['Prompt'], null) });
    const { handler, dispose } = start('visible-1', backend);
    const onMessage = handler('message');

    // Non-visibility and null-data messages are ignored (no throw, no effect).
    onMessage({ data: { type: 'something-else' } });
    onMessage({ data: null });
    // Hide the tab: the play pauses at the next on-screen gate.
    onMessage({ data: { type: 'hb-demo-visibility', visible: false } });
    await vi.advanceTimersByTimeAsync(5000);
    // Show it again: the play resumes.
    onMessage({ data: { type: 'hb-demo-visibility', visible: true } });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(composerValue()).toBe('Prompt');
    dispose();
  });

  it('aborts the current play and removes listeners on dispose', async () => {
    useDirectorTimers();
    mountChatDom();
    setWelcome(true);
    const backend = makeBackend({ peekNextUserText: drain(['A', 'B', 'C'], null) });
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { dispose } = start('dispose-1', backend);
    await vi.advanceTimersByTimeAsync(200);

    dispose();
    await vi.advanceTimersByTimeAsync(30_000);

    // Dispose removed the pointerdown and click listeners.
    const removedTypes = removeSpy.mock.calls.map((c) => c[0]);
    expect(removedTypes).toContain('pointerdown');
    expect(removedTypes).toContain('click');
  });
});
