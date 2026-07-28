import * as React from 'react';
import { DocumentColour, type FrameAppearance } from '@hushbox/shared/documents';

/**
 * The two tokens the sandbox frame is painted with. They are read from the live
 * computed style rather than restated here so the app's stylesheet stays the
 * single source of the palette — the frame is a separate origin that cannot
 * read them itself, and a copy on either side of that boundary is a mirror
 * nothing keeps honest.
 */
const APPEARANCE_TOKENS = { background: '--background', foreground: '--foreground' } as const;

/**
 * A token's value, if it is a colour the bridge can carry. The frame validates
 * every inbound message and drops one that fails, so a token that is not plain
 * six-digit hex (an `oklch()` palette, say) is left out rather than sent — an
 * unsendable colour must cost the frame its colour, never its document.
 */
function readToken(style: CSSStyleDeclaration, token: string): string | undefined {
  const parsed = DocumentColour.safeParse(style.getPropertyValue(token).trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * The one place an appearance is produced; every trigger below routes here.
 *
 * All three values come off the root element in a single pass, and the colour
 * scheme is taken from the `dark` class rather than from React state, because
 * that class is the very thing the stylesheet resolves the two colours through —
 * so the scheme and the colours cannot describe different moments. React state
 * cannot serve here: the theme provider writes this class from inside
 * `startViewTransition`'s callback, which is not a React event, so the class is
 * already flipped a microtask before React has re-rendered anything. Reading the
 * mode from a hook or a ref at that instant yields the previous theme against
 * the new colours. The class is the app's own theme output — `index.html`'s
 * pre-paint block, `theme-flash-script.ts`, and the theme provider all write it,
 * and it is what `.dark` in the stylesheet selects on.
 */
function readAppearance(): FrameAppearance {
  const root = document.documentElement;
  const style = globalThis.getComputedStyle(root);
  const background = readToken(style, APPEARANCE_TOKENS.background);
  const foreground = readToken(style, APPEARANCE_TOKENS.foreground);
  return {
    theme: root.classList.contains('dark') ? 'dark' : 'light',
    ...(background === undefined ? {} : { background }),
    ...(foreground === undefined ? {} : { foreground }),
  };
}

function isSameAppearance(a: FrameAppearance, b: FrameAppearance): boolean {
  return a.theme === b.theme && a.background === b.background && a.foreground === b.foreground;
}

/**
 * The appearance the sandbox frame should take: the app's own colour scheme and
 * the colours behind it.
 *
 * Two controls move it — the theme toggle, and the accessibility contrast tiers,
 * which override the same two tokens without touching the theme. Both land the
 * same way, as an attribute written onto the root element, so the trigger is
 * that write rather than either control: one observer, one read, one value, and
 * a tier change cannot be the case somebody forgot. Subscribing to either
 * control's React state instead would fire at the wrong moment — the
 * accessibility store updates a render before its provider's effect writes the
 * class, and the theme provider writes its class outside React entirely, from a
 * view transition callback.
 *
 * The value is compared before it is stored, so a root-element write that moves
 * nothing it reads (a focus width, a font class) does not churn the identity the
 * frame's restyle is keyed on. Holding the whole appearance as one lagging value
 * is also what keeps a change to one message: the frame is told the new
 * appearance once both halves of it have been read, never once per half.
 */
export function useFrameAppearance(): FrameAppearance {
  // Seeded synchronously, so a frame that hands its port over during the commit
  // that mounted it is still painted by the `init` answering that handshake.
  const [appearance, setAppearance] = React.useState<FrameAppearance>(readAppearance);

  React.useEffect(() => {
    const sync = (): void => {
      setAppearance((current) => {
        const next = readAppearance();
        return isSameAppearance(current, next) ? current : next;
      });
    };

    // Covers a write that landed between the seeding render and this effect.
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  return appearance;
}
