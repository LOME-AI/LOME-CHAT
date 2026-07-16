import * as React from 'react';

export interface MagnifierProps {
  enabled: boolean;
  zoom?: number;
  size?: number;
}

const DEBOUNCE_MS = 100;

/** Is this mutation target inside any magnifier lens (i.e. caused by our own
 * clone refresh)? Used to break the feedback loop where setting bodyHtml
 * mutates the clone, the MutationObserver sees the change, schedules another
 * refresh, and so on every DEBOUNCE_MS — manifesting as a flicker. */
function isInsideMagnifier(target: Node | null): boolean {
  let node: Node | null = target;
  while (node !== null) {
    if (node instanceof HTMLElement && 'a11yMagnifier' in node.dataset) {
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

/** Capture body's HTML with magnifier + reading-guide overlays stripped out.
 *
 * Without stripping, `body.innerHTML` includes the lens itself — whose own
 * inner clone contains the previous bodyHtml — so every refresh roughly
 * doubles the serialised size. The recursive structure also makes
 * `syncScrollPositions` walk into stale nested clones, mis-applying scroll
 * values to misaligned descendants ("magnifier shows page as if scrolled
 * all the way up"). Stripping fixes both. */
function captureBodyHtml(): string {
  const detached = document.body.cloneNode(true) as HTMLElement;
  for (const overlay of detached.querySelectorAll(
    '[data-a11y-magnifier], [data-a11y-reading-guide]'
  )) {
    overlay.remove();
  }
  return detached.innerHTML;
}

/** True for elements that are stripped from the cloned body — must be skipped
 * during the live walk too, or the parallel-index pairing diverges as soon
 * as we pass a stripped element and every subsequent pair is misaligned. */
function isStrippedOverlay(node: Element): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return 'a11yMagnifier' in node.dataset || 'a11yReadingGuide' in node.dataset;
}

function visibleChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (const child of parent.children) {
    if (!isStrippedOverlay(child)) out.push(child);
  }
  return out;
}

/** Recursively copy scrollTop/scrollLeft from the live tree to the clone tree.
 * innerHTML serialises markup but NOT element scroll position, so without this
 * the clone shows every scrollable container at scroll = 0 — which on pages
 * where the visible area is inside a `overflow:auto` div would magnify the
 * un-scrolled top of that div instead of what's under the cursor.
 *
 * Walks by parallel index over `visibleChildren` (live children minus the
 * same overlays we strip from the clone). Without this filter the live walk
 * would include the magnifier/reading-guide but the clone wouldn't, and
 * every pair after the first stripped element would target the wrong
 * descendant — meaning the actually-scrollable container in the clone never
 * receives its scrollTop. */
function syncScrollPositions(live: Element, clone: Element): void {
  if (live.scrollTop !== 0) clone.scrollTop = live.scrollTop;
  if (live.scrollLeft !== 0) clone.scrollLeft = live.scrollLeft;
  const liveChildren = visibleChildren(live);
  const cloneChildren = clone.children;
  const limit = Math.min(liveChildren.length, cloneChildren.length);
  for (let index = 0; index < limit; index += 1) {
    const liveChild = liveChildren[index];
    const cloneChild = cloneChildren[index];
    // Both are always defined for index < limit (noUncheckedIndexedAccess guard).
    /* v8 ignore next */
    if (liveChild !== undefined && cloneChild !== undefined) {
      syncScrollPositions(liveChild, cloneChild);
    }
  }
}

/**
 * Cursor-tracking magnifier lens. Renders a circular fixed-position viewport that
 * follows the cursor. Inside the viewport we mount a clone of `document.body.innerHTML`
 * shifted so its (0,0) maps to screen (0,0), then `transform: scale(zoom)` is applied
 * with `transform-origin` at the cursor's screen position. The result: the area under
 * the cursor stays anchored under the cursor while everything around it is enlarged.
 *
 * Two corrections vs. a naive clone: (1) window scroll position is added to the
 * clone offset and transform origin so the visible area lines up when the page
 * itself is scrolled; (2) each scrollable container's scrollTop/scrollLeft is
 * mirrored onto the clone so inner overflow:auto regions show what the user is
 * actually looking at.
 */
export function Magnifier({
  enabled,
  zoom = 2,
  size = 320,
}: Readonly<MagnifierProps>): React.JSX.Element | null {
  const [cursor, setCursor] = React.useState<{ x: number; y: number }>(() => ({
    x: Math.floor(globalThis.innerWidth / 2),
    y: Math.floor(globalThis.innerHeight / 2),
  }));
  const [bodyHtml, setBodyHtml] = React.useState<string>(() => captureBodyHtml());
  const cloneRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (event: MouseEvent): void => {
      setCursor({ x: event.clientX, y: event.clientY });
    };
    globalThis.addEventListener('mousemove', handleMouseMove);

    let debounceId: ReturnType<typeof setTimeout> | null = null;
    const refreshClone = (): void => {
      setBodyHtml(captureBodyHtml());
    };
    const observer = new MutationObserver((mutations) => {
      // Skip if EVERY mutation is inside a magnifier (self-triggered clone
      // refresh). Without this filter the clone's innerHTML reset fires the
      // observer, schedules another refresh DEBOUNCE_MS later, and loops
      // forever — producing a constant 100ms-period flicker.
      const meaningful = mutations.some((mutation) => !isInsideMagnifier(mutation.target));
      if (!meaningful) return;
      if (debounceId !== null) clearTimeout(debounceId);
      debounceId = setTimeout(refreshClone, DEBOUNCE_MS);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      // Animations (Framer Motion etc.) update inline styles. Without
      // attribute observation the clone would freeze on the first frame
      // of any animation — e.g. the chat-welcome subtitle whose opacity
      // animates from 0 to 1 would stay invisible forever. Debouncing
      // means continuous animations defer the refresh until they settle.
      attributes: true,
      attributeFilter: ['style'],
    });

    return () => {
      globalThis.removeEventListener('mousemove', handleMouseMove);
      observer.disconnect();
      if (debounceId !== null) clearTimeout(debounceId);
    };
  }, [enabled]);

  // Own the clone's innerHTML imperatively. JSX `dangerouslySetInnerHTML`
  // resets innerHTML on every render (the {__html: ...} object identity
  // changes), which wipes every descendant's scrollTop — so on cursor moves
  // (mousemove → setCursor → re-render), the clone snapped back to "scrolled
  // to top" even though no scroll happened. Setting it from an effect with
  // [bodyHtml] deps means innerHTML only resets when the captured body
  // actually changes, not on cursor-driven style updates. After each reset
  // we re-sync scroll positions, since innerHTML parsing creates fresh
  // descendants at scrollTop = 0.
  React.useEffect(() => {
    if (!enabled) return;
    const cloneRoot = cloneRef.current;
    // The clone ref is always attached whenever this enabled-only effect runs.
    /* v8 ignore next */
    if (cloneRoot === null) return;
    cloneRoot.innerHTML = bodyHtml;
    syncScrollPositions(document.body, cloneRoot);
  }, [enabled, bodyHtml]);

  // Mirror scroll positions on every scroll event (capture phase — scroll
  // doesn't bubble, so this is the only way to catch scrolls on inner
  // overflow:auto containers globally). Without this the clone goes stale
  // whenever the user scrolls without moving the mouse, and the magnifier
  // reveals a completely different part of the page.
  React.useEffect(() => {
    if (!enabled) return;
    const sync = (): void => {
      const cloneRoot = cloneRef.current;
      // The clone ref is always attached whenever this enabled-only effect runs.
      /* v8 ignore next */
      if (cloneRoot === null) return;
      syncScrollPositions(document.body, cloneRoot);
    };
    globalThis.addEventListener('scroll', sync, { capture: true, passive: true });
    return () => {
      globalThis.removeEventListener('scroll', sync, { capture: true });
    };
  }, [enabled]);

  if (!enabled) return null;

  const half = size / 2;
  const lensLeft = cursor.x - half;
  const lensTop = cursor.y - half;
  const scrollX = globalThis.scrollX;
  const scrollY = globalThis.scrollY;

  return (
    <div
      data-a11y-magnifier=""
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        borderRadius: '50%',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 9999,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
        border: '2px solid rgba(0, 0, 0, 0.6)',
        transform: `translate(${String(lensLeft)}px, ${String(lensTop)}px)`,
      }}
    >
      <div
        ref={cloneRef}
        data-a11y-magnifier-content=""
        style={{
          position: 'absolute',
          top: `${String(-lensTop - scrollY)}px`,
          left: `${String(-lensLeft - scrollX)}px`,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          transform: `scale(${String(zoom)})`,
          transformOrigin: `${String(cursor.x + scrollX)}px ${String(cursor.y + scrollY)}px`,
        }}
      />
    </div>
  );
}
