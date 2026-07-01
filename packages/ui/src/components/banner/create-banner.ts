import {
  computeBannerMode,
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

function ghostButton(label: string, glyph: SVGSVGElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hb-btn';
  button.setAttribute('aria-label', label);
  button.append(glyph);
  return button;
}

/** Render one message: text via textContent (never innerHTML), plus a safe link. */
function appendMessage(parent: ParentNode, message: BannerMessage): void {
  const item = document.createElement('span');
  item.className = 'hb-msg';
  item.append(document.createTextNode(message.text));
  if (message.href !== undefined) {
    const link = document.createElement('a');
    link.className = 'hb-link';
    link.setAttribute('href', message.href);
    link.setAttribute('rel', 'noopener noreferrer');
    link.textContent = message.linkText ?? 'Learn more';
    item.append(document.createTextNode(' '), link);
  }
  parent.append(item);
}

function buildTrackChildren(messages: readonly BannerMessage[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const [index, message] of messages.entries()) {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'hb-sep';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '•';
      fragment.append(separator);
    }
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
  banner.dataset['variant'] = data.variant;
  banner.dataset['state'] = 'closed';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Announcements');

  const iconHolder = document.createElement('span');
  iconHolder.className = 'hb-ico';
  iconHolder.setAttribute('aria-hidden', 'true');
  iconHolder.append(variantIcon(data.variant));
  banner.append(iconHolder);

  const viewport = document.createElement('div');
  viewport.className = 'hb-vp';
  const track = document.createElement('div');
  track.className = 'hb-track';
  // The moving copy is decorative duplication; the live region below is what AT reads.
  track.setAttribute('aria-hidden', 'true');
  track.append(buildTrackChildren(data.messages));
  viewport.append(track);
  banner.append(viewport);

  const actions = document.createElement('div');
  actions.className = 'hb-actions';
  const dismissButton = ghostButton('Dismiss announcement', dismissIcon());
  dismissButton.classList.add('hb-dismiss');
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
  const distance = dom.track.scrollWidth;
  const mode = computeBannerMode(messageCount, distance, dom.viewport.clientWidth);
  dom.viewport.dataset['mode'] = mode;
  if (mode !== 'scroll') return;

  const durationSeconds = computeMarqueeDurationSeconds(distance, marqueeSpeedFor(messageCount));
  dom.track.style.setProperty('--hb-marquee-duration', `${durationSeconds.toString()}s`);
  // Duplicate the content so the -50% keyframe loops seamlessly.
  dom.track.append(...[...dom.track.children].map((child) => child.cloneNode(true)));

  const pauseButton = ghostButton('Pause announcements', pauseIcon());
  pauseButton.setAttribute('aria-pressed', 'false');
  const divider = document.createElement('span');
  divider.className = 'hb-divider';
  const togglePause = (): void => {
    const paused = dom.banner.dataset['paused'] !== 'true';
    dom.banner.dataset['paused'] = String(paused);
    pauseButton.setAttribute('aria-pressed', String(paused));
  };
  pauseButton.addEventListener('click', togglePause);
  cleanups.push(() => {
    pauseButton.removeEventListener('click', togglePause);
  });
  dom.actions.prepend(pauseButton, divider);
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
