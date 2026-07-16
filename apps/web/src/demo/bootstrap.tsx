import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter, createMemoryHistory } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { routeTree } from '@/routeTree.gen';
import { queryClient } from '@/providers/query-provider';
import { chatKeys } from '@/hooks/chat/chat';
import { installFetchShim } from './mock-backend/fetch-shim';
import { installWebSocketShim, emitDemoRealtimeEvent } from './mock-backend/ws-shim';
import { DemoBackendStore } from './mock-backend/store';
import { DEMO_BOOT_ID } from './mock-backend/fixtures';
import { seedDemoSession } from './seed-session';
import { seedDemoModelSelection } from './seed-model-selection';
import { startDirector } from './director';
import { installGuardrails } from './guardrails';
import { installComposerCues } from './composer-cues';
import { installFocusScrollGuard } from './focus-scroll-guard';
import { parseFrozenParams, scrollFrozenListToTop, type FrozenParams } from './frozen';

/**
 * Boots the REAL app in "demo mode": installs the network shim + a seeded
 * session BEFORE any provider mounts (StabilityProvider fires auth/balance on
 * mount), then renders the real route tree under a MEMORY-history router so the
 * iframe's document URL stays `/demo` — reload-safe, and the sidebar's
 * `/chat/$id` links navigate in memory instead of the address bar.
 *
 * Loaded as a lazy chunk only on the `/demo` path, so none of this (or the
 * fixtures) ships to real users.
 */
/**
 * Static, dependency-free fallback shown inside the iframe if `mountDemo`
 * throws (seed/shim/render failure). Replaces a blank or half-mounted iframe
 * with a real way out: a top-level link into the live app. Plain DOM so it
 * renders even when the React/router boot is what failed.
 */
export function renderDemoFallback(rootElement: Element): void {
  const link = document.createElement('a');
  link.href = ROUTES.CHAT;
  link.target = '_top';
  link.textContent = 'Open HushBox';
  link.className = 'flex h-full w-full items-center justify-center text-sm font-medium underline';
  rootElement.replaceChildren(link);
}

export function mountDemo(rootElement: Element): void {
  try {
    bootDemo(rootElement);
  } catch {
    // A broken demo must never strand the visitor on a blank iframe; offer a
    // direct link into the live app instead.
    renderDemoFallback(rootElement);
  }
}

function bootDemo(rootElement: Element): void {
  // The demo lives in a small iframe; shrink the root font (the same lever the
  // accessibility text-size control pulls — everything is rem-based) so the UI
  // isn't squished. 80% of the app's normal size fits the embed comfortably.
  document.documentElement.style.fontSize = '80%';
  // Gate demo-only CSS overrides (see app.css `[data-demo]`). Mirrors the
  // `[data-e2e]` marker pattern in main.tsx.
  document.documentElement.dataset['demo'] = '';

  const session = seedDemoSession();
  const store = new DemoBackendStore(session.accountPublicKey);
  installFetchShim(store);
  // Group conversations open a real WebSocket; the fake keeps it permanently
  // "ready" with no server and no reconnect churn (HMR sockets pass through).
  installWebSocketShim();
  // The app focuses the composer on every turn; a bare focus() scrolls the
  // focused element into view across the iframe boundary, dragging the
  // embedding /welcome page. Force preventScroll in the demo realm.
  installFocusScrollGuard();

  // Demo-only: boot the text picker on the strongest accessible model rather
  // than Smart Model, once the (real) /models catalog loads. Fire-and-forget —
  // a slow or empty catalog just leaves the Smart Model default. Runs before
  // the frozen branch so both the live embed and the frozen capture get it.
  void seedDemoModelSelection(queryClient);

  // A `/demo?frozen=1…` capture (the social-banner generator) renders a single
  // pre-filled conversation with no typing director, so a screenshot is
  // deterministic. The live `/welcome` embed (no query) takes the path below.
  const frozen = parseFrozenParams(globalThis.location.search);
  if (frozen) {
    bootFrozenDemo(rootElement, store, frozen);
    return;
  }

  // Boot onto the new-chat screen; the director auto-opens the first conversation
  // (and every later one) by routing back through this welcome screen first.
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [ROUTES.CHAT] }),
  });

  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );

  // Tell the embedding page the demo has painted, so it can fade the iframe in
  // instead of flashing white during load (see AppDemo.astro). The payload is a
  // bare signal with no data, and the parent is cross-origin in dev (marketing
  // and web app run on different ports), so a wildcard target is correct here.
  // Deferred two frames so the reveal happens AFTER the app's first real paint —
  // `render()` only schedules the commit, so pinging synchronously would reveal a
  // still-blank iframe (the lingering white flash). `globalThis.requestAnimationFrame`
  // is a one-shot paint gate, not an animation loop.
  // eslint-disable-next-line no-restricted-syntax -- one-shot double-rAF paint gate to signal first paint (not an animation loop); useAnimationFrame is a reduced-motion animation loop and is the wrong primitive here
  globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(signalDemoReady));

  startDirector(
    {
      navigate: (path) => {
        router.history.push(path);
      },
    },
    store,
    (conversationId) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
    },
    { emitRealtime: emitDemoRealtimeEvent, bootConversationId: DEMO_BOOT_ID }
  );
  installGuardrails();
  // Signal the composer isn't a live input: sign-up placeholder + locked
  // modality icons (the director still drives it; these cues are visual only).
  installComposerCues();
}

/**
 * Post the readiness ping the embedding page waits on before revealing the
 * iframe (live demo) or capturing the screenshot (frozen demo). The parent is
 * cross-origin in dev, so a wildcard target is correct.
 */
function signalDemoReady(): void {
  // eslint-disable-next-line sonarjs/post-message -- non-sensitive ready ping; parent cross-origin in dev
  globalThis.parent.postMessage({ type: 'hb-demo-ready' }, '*');
}

/** Force the app theme for a frozen capture before any provider reads it. */
function applyDemoTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem('themeMode', theme);
  } catch {
    // Private-mode storage failures are non-fatal; the class toggle still sets
    // the captured theme for this session.
  }
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

/**
 * Boot the demo as a frozen, single-conversation snapshot: fill the target
 * thread from its fixture script (no streaming), mount the real app straight
 * onto it, park the requested end in view, then signal ready. No director,
 * guardrails, or composer cues — a static capture needs none of them.
 */
function bootFrozenDemo(rootElement: Element, store: DemoBackendStore, frozen: FrozenParams): void {
  applyDemoTheme(frozen.theme);
  store.fillConversation(frozen.conversationId, frozen.fill);
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`${ROUTES.CHAT}/${frozen.conversationId}`] }),
  });
  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
  void finalizeFrozenDemo(frozen);
}

async function finalizeFrozenDemo(frozen: FrozenParams): Promise<void> {
  if (frozen.scroll === 'top') await scrollFrozenListToTop();
  signalDemoReady();
}
