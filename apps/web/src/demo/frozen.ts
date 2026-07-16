import { DEMO_BOOT_ID } from './mock-backend/fixtures';

/**
 * The deterministic-capture parameters the social-banner generator appends to
 * `/demo` (e.g. `/demo?frozen=1&convo=demo-welcome&scroll=top&theme=dark`).
 * Their presence switches the demo boot from the live typing director to a
 * frozen, pre-filled transcript suitable for a static screenshot.
 */
export interface FrozenParams {
  readonly conversationId: string;
  readonly scroll: 'top' | 'bottom';
  readonly theme: 'light' | 'dark';
  /**
   * Number of leading scripted turns to pre-fill as the static backdrop; the
   * remaining turns stay unfilled so a later externally-driven send streams the
   * next turn live (the ad capture). Undefined = fill the whole script.
   */
  readonly fill?: number;
}

/** Parse `?fill=N` as a non-negative integer; undefined for absent/invalid (fill-all). */
function parseFill(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Parse the frozen-capture query. Returns null for the normal live demo (no
 * `frozen=1`), so `/welcome`'s embed keeps the director path untouched; a
 * non-null result routes the boot into the static-capture path.
 */
export function parseFrozenParams(search: string): FrozenParams | null {
  const params = new URLSearchParams(search);
  if (params.get('frozen') !== '1') return null;
  const fill = parseFill(params.get('fill'));
  return {
    conversationId: params.get('convo') ?? DEMO_BOOT_ID,
    scroll: params.get('scroll') === 'bottom' ? 'bottom' : 'top',
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    ...(fill === undefined ? {} : { fill }),
  };
}

const SCROLL_POLL_MS = 50;
const SCROLL_SETTLE_TIMEOUT_MS = 8000;
const SCROLL_RETRY_MS = 200;
const SCROLL_MAX_RETRIES = 8;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The chat log's settled-at-bottom flag, or null before it mounts. */
function chatLogAtBottom(): boolean | null {
  const list = document.querySelector<HTMLElement>('[data-testid="message-list"]');
  return list === null ? null : list.dataset['atBottom'] === 'true';
}

/**
 * Park the first message at the top of the chat log. The list mounts pinned to
 * the LAST message and re-pins once when the conversation finishes loading, so a
 * naive early scroll loses to that re-pin and the capture shows the end of the
 * thread. Reuses `MessageList`'s dev/E2E `__virtuosoScrollToIndex` hatch rather
 * than adding capture-only scroll code to the app: it first waits for the hatch
 * and the settled-at-bottom state (so the load re-pin has already fired), then
 * scrolls to the first message, retrying until the list reports it left the
 * bottom. Resolves anyway on timeout so a missing hatch never strands readiness.
 */
export async function scrollFrozenListToTop(): Promise<void> {
  const deadline = Date.now() + SCROLL_SETTLE_TIMEOUT_MS;
  while (globalThis.__virtuosoScrollToIndex === undefined || chatLogAtBottom() !== true) {
    if (Date.now() >= deadline) break;
    await wait(SCROLL_POLL_MS);
  }

  const scrollToIndex = globalThis.__virtuosoScrollToIndex;
  if (scrollToIndex === undefined) return;

  for (let attempt = 0; attempt < SCROLL_MAX_RETRIES; attempt++) {
    await scrollToIndex(0);
    await wait(SCROLL_RETRY_MS);
    if (chatLogAtBottom() === false) return;
  }
}
