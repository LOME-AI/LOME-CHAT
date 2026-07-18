import { TEST_IDS } from '@hushbox/shared';
import {
  computeBannerMode,
  computeEnterDurationSeconds,
  computeMarqueeCopyCount,
  computeMarqueeDurationSeconds,
  marqueeSpeedFor,
} from './compute-mode.js';
import { isBannerDismissed, markBannerDismissed } from './dismissal-store.js';
import type { BannerMessage, BannerResponse, BannerVariant } from '@hushbox/shared';

/**
 * The single, framework-agnostic implementation of the announcement banner. Both
 * the React app and the compiled Astro site mount this; their only job is to fetch
 * the `/announcements/banner` payload (TanStack Query on web, a plain fetch in the
 * Astro `<script>`) and supply the dismissal I/O, so there is no per-framework
 * markup or behavior.
 *
 * Data fetching is injected, not done here, which keeps `@hushbox/ui` free of any
 * dependency on the API client.
 */
export interface CreateBannerOptions {
  /** The active banner payload (already salvaged + hashed by the server). */
  data: BannerResponse;
  isAuthenticated: boolean;
  /**
   * Authed cross-device read. Called ONLY when the user is authenticated and the
   * local dismissal key is absent for this hash — never on the local fast path.
   */
  fetchServerDismissal?: (hash: string) => Promise<boolean>;
  /** Fire-and-forget authed persist on dismiss. */
  saveServerDismissal?: (hash: string) => void;
}

export type BannerTeardown = () => void;

const SVG_NS = 'http://www.w3.org/2000/svg';
// Matches the slide transition; a fallback so the node is removed even if
// `transitionend` never fires (reduced-motion zeroes the transition, jsdom emits
// no transitions).
const CLOSE_FALLBACK_MS = 300;

function svgEl(tag: string, attributes: Record<string, string>): SVGElement {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function icon(size: number, children: readonly SVGElement[]): SVGSVGElement {
  const svg = svgEl('svg', {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }) as SVGSVGElement;
  for (const child of children) svg.append(child);
  return svg;
}

function variantIcon(variant: BannerVariant): SVGSVGElement {
  if (variant === 'warning') {
    return icon(18, [
      svgEl('path', {
        d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z',
      }),
      svgEl('path', { d: 'M12 9v4' }),
      svgEl('path', { d: 'M12 17h.01' }),
    ]);
  }
  if (variant === 'critical') {
    return icon(18, [
      svgEl('path', { d: 'M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z' }),
      svgEl('path', { d: 'M12 8v4' }),
      svgEl('path', { d: 'M12 16h.01' }),
    ]);
  }
  return icon(18, [
    svgEl('circle', { cx: '12', cy: '12', r: '10' }),
    svgEl('path', { d: 'M12 16v-4' }),
    svgEl('path', { d: 'M12 8h.01' }),
  ]);
}

function dismissIcon(): SVGSVGElement {
  return icon(17, [svgEl('path', { d: 'M18 6 6 18' }), svgEl('path', { d: 'm6 6 12 12' })]);
}

function pauseIcon(): SVGSVGElement {
  return icon(16, [
    svgEl('rect', { x: '6', y: '4', width: '4', height: '16', rx: '1' }),
    svgEl('rect', { x: '14', y: '4', width: '4', height: '16', rx: '1' }),
  ]);
}

function playIcon(): SVGSVGElement {
  return icon(16, [svgEl('path', { d: 'm6 4 14 8-14 8Z' })]);
}

function ghostButton(label: string, glyph: SVGSVGElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hb-btn';
  button.setAttribute('aria-label', label);
  button.append(glyph);
  return button;
}

function messageLink(
  message: BannerMessage & { href: string },
  className: string
): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = className;
  link.setAttribute('href', message.href);
  link.setAttribute('rel', 'noopener noreferrer');
  link.textContent = message.linkText ?? 'Learn more';
  return link;
}

/**
 * Render one message: its own variant icon + color hook (`data-variant`), text
 * via textContent (never innerHTML), plus a safe link. The icon is decorative
 * (aria-hidden); the accessible list below carries the text and links for AT.
 */
function appendMessage(parent: ParentNode, message: BannerMessage): void {
  const item = document.createElement('span');
  item.className = 'hb-msg';
  item.dataset['variant'] = message.variant;
  item.dataset['testid'] = TEST_IDS.announcementBannerMessage;
  const iconHolder = document.createElement('span');
  iconHolder.className = 'hb-ico';
  iconHolder.setAttribute('aria-hidden', 'true');
  iconHolder.append(variantIcon(message.variant));
  item.append(iconHolder, document.createTextNode(message.text));
  if (message.href !== undefined) {
    const link = messageLink({ ...message, href: message.href }, 'hb-link');
    // The whole track is aria-hidden decoration (and duplicated for the loop),
    // so its links must be inert; the `.hb-sr-list` copies are the real,
    // keyboard-reachable ones. Set before cloning so clones inherit it.
    link.tabIndex = -1;
    item.append(link);
  }
  parent.append(item);
}

/** A decorative dot separator; styled entirely in CSS so it carries no text for AT. */
function separatorEl(): HTMLSpanElement {
  const separator = document.createElement('span');
  separator.className = 'hb-sep';
  separator.setAttribute('aria-hidden', 'true');
  return separator;
}

function buildTrackChildren(messages: readonly BannerMessage[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const [index, message] of messages.entries()) {
    if (index > 0) fragment.append(separatorEl());
    appendMessage(fragment, message);
  }
  return fragment;
}

interface BannerDom {
  banner: HTMLDivElement;
  viewport: HTMLDivElement;
  track: HTMLDivElement;
  actions: HTMLDivElement;
  dismissButton: HTMLButtonElement;
}

function buildBannerDom(data: BannerResponse): BannerDom {
  const banner = document.createElement('div');
  banner.className = 'hb-banner';
  banner.dataset['state'] = 'closed';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Announcements');
  banner.dataset['testid'] = TEST_IDS.announcementBanner;

  const viewport = document.createElement('div');
  viewport.className = 'hb-vp';
  const track = document.createElement('div');
  track.className = 'hb-track';
  // The moving copy is decorative duplication; the `.hb-sr-list` + live region below are what AT reads.
  track.setAttribute('aria-hidden', 'true');
  track.append(buildTrackChildren(data.messages));
  viewport.append(track);
  banner.append(viewport);

  // Static, visually-hidden accessible copy of the messages. Two ARIA pieces on
  // purpose: the polite live region (below) announces the text once, while this
  // list is the browsable/tabbable surface — live regions announce text, they
  // are the wrong host for interactive content. A focused link reveals itself
  // as a visible chip (skip-link pattern), so keyboard users get stationary
  // link access while the marquee stays pure decoration.
  const srList = document.createElement('ul');
  srList.className = 'hb-sr-list';
  for (const message of data.messages) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'hb-sr-only';
    text.textContent = message.text;
    item.append(text);
    if (message.href !== undefined) {
      item.append(messageLink({ ...message, href: message.href }, 'hb-sr-link'));
    }
    srList.append(item);
  }
  banner.append(srList);

  const actions = document.createElement('div');
  actions.className = 'hb-actions';
  const dismissButton = ghostButton('Dismiss announcement', dismissIcon());
  dismissButton.classList.add('hb-dismiss');
  dismissButton.dataset['testid'] = TEST_IDS.announcementBannerDismiss;
  actions.append(dismissButton);
  banner.append(actions);

  const live = document.createElement('span');
  live.className = 'hb-sr-only';
  live.setAttribute('aria-live', 'polite');
  live.textContent = data.messages.map((message) => message.text).join('. ');
  banner.append(live);

  return { banner, viewport, track, actions, dismissButton };
}

function openBanner(banner: HTMLElement): void {
  // Read layout to flush the closed state before flipping to open, so the
  // slide-in transition runs (no-op cost under reduced motion / in jsdom).
  banner.getBoundingClientRect();
  banner.dataset['state'] = 'open';
}

function closeBanner(banner: HTMLElement, onDone: () => void): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone();
  };
  const onTransitionEnd = (event: TransitionEvent): void => {
    if (event.target === banner) {
      banner.removeEventListener('transitionend', onTransitionEnd);
      finish();
    }
  };
  banner.addEventListener('transitionend', onTransitionEnd);
  banner.dataset['state'] = 'closed';
  globalThis.setTimeout(finish, CLOSE_FALLBACK_MS);
}

/** Measure, choose static vs scroll, and (for scroll) duplicate the track + add a pause control. */
function applyMarquee(dom: BannerDom, messageCount: number, cleanups: (() => void)[]): void {
  // The pause control + divider must be in the DOM BEFORE measuring: the
  // viewport is flex-remaining space, so measuring first bakes a stale (wider)
  // enter distance and can leave static a message that only overflows once the
  // chrome narrows the viewport. Removed again below if the mode ends up static.
  const pauseButton = ghostButton('Pause announcements', pauseIcon());
  pauseButton.setAttribute('aria-pressed', 'false');
  const divider = document.createElement('span');
  divider.className = 'hb-divider';
  dom.actions.prepend(pauseButton, divider);

  const viewportWidth = dom.viewport.clientWidth;
  const mode = computeBannerMode(messageCount, dom.track.scrollWidth, viewportWidth);
  dom.viewport.dataset['mode'] = mode;
  if (mode !== 'scroll') {
    pauseButton.remove();
    divider.remove();
    return;
  }

  // A trailing separator makes the track periodic: [msg sep ... msg sep] × N,
  // so the loop seam carries exactly the same gap as any inter-message
  // boundary. It must be appended BEFORE measuring the loop distance and cloning.
  dom.track.append(separatorEl());
  const contentWidth = dom.track.scrollWidth;
  const speed = marqueeSpeedFor(messageCount);
  const durationSeconds = computeMarqueeDurationSeconds(contentWidth, speed);
  dom.track.style.setProperty('--hb-marquee-duration', `${durationSeconds.toString()}s`);
  // The loop travels exactly one content period in px (not a track percentage),
  // so the wrap lands on an identical frame for any copy count.
  dom.track.style.setProperty('--hb-loop-distance', `${contentWidth.toString()}px`);
  // The one-shot entry starts the track one full viewport to the right, so the
  // banner appears empty and the content scrolls in at loop speed.
  dom.track.style.setProperty('--hb-enter-distance', `${viewportWidth.toString()}px`);
  dom.track.style.setProperty(
    '--hb-enter-duration',
    `${computeEnterDurationSeconds(viewportWidth, speed).toString()}s`
  );
  // Duplicate the content until the track covers viewport + one period; with
  // fewer copies (short content, wide viewport) the window scrolls past the
  // tail near the end of each cycle and shows dead air until the wrap.
  const originals = [...dom.track.children];
  for (let copy = 1; copy < computeMarqueeCopyCount(viewportWidth, contentWidth); copy += 1) {
    dom.track.append(...originals.map((child) => child.cloneNode(true)));
  }

  const togglePause = (): void => {
    const paused = dom.banner.dataset['paused'] !== 'true';
    dom.banner.dataset['paused'] = String(paused);
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.setAttribute('aria-label', paused ? 'Play announcements' : 'Pause announcements');
    pauseButton.replaceChildren(paused ? playIcon() : pauseIcon());
  };
  pauseButton.addEventListener('click', togglePause);
  cleanups.push(() => {
    pauseButton.removeEventListener('click', togglePause);
  });
}

/**
 * Mount the banner into `root`. Returns a teardown that removes it and detaches
 * listeners. Renders nothing — and never throws — when the set is empty/disabled
 * or already dismissed locally, which is also the graceful-degradation fallback.
 */
export function createBanner(root: HTMLElement, options: CreateBannerOptions): BannerTeardown {
  const { data, isAuthenticated, fetchServerDismissal, saveServerDismissal } = options;
  const cleanups: (() => void)[] = [];
  // Mutable field (not a bare `let`) so the async dismissal check below reads the
  // live value rather than a flow-narrowed constant.
  const state = { disposed: false };

  const teardown: BannerTeardown = () => {
    state.disposed = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    root.replaceChildren();
  };

  root.replaceChildren();

  if (data.hash === null || data.messages.length === 0) return teardown;
  const hash = data.hash;
  if (isBannerDismissed(hash)) return teardown;

  const dom = buildBannerDom(data);
  const handleDismiss = (): void => {
    markBannerDismissed(hash);
    if (isAuthenticated) saveServerDismissal?.(hash);
    closeBanner(dom.banner, () => {
      dom.banner.remove();
    });
  };
  dom.dismissButton.addEventListener('click', handleDismiss);
  cleanups.push(() => {
    dom.dismissButton.removeEventListener('click', handleDismiss);
  });

  root.append(dom.banner);

  const reveal = (): void => {
    applyMarquee(dom, data.messages.length, cleanups);
    openBanner(dom.banner);
  };

  if (isAuthenticated && fetchServerDismissal) {
    void (async (): Promise<void> => {
      try {
        const dismissed = await fetchServerDismissal(hash);
        if (state.disposed) return;
        if (dismissed) {
          markBannerDismissed(hash);
          dom.banner.remove();
        } else {
          reveal();
        }
      } catch {
        // Server check failed: show the banner rather than hide a real message.
        if (!state.disposed) reveal();
      }
    })();
  } else {
    reveal();
  }

  return teardown;
}
