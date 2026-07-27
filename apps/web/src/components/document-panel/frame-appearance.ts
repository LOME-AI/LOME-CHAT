import * as React from 'react';
import { DocumentColour, type FrameAppearance } from '@hushbox/shared/documents';
import { useTheme } from '@/providers/theme-provider';

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
 * The appearance the sandbox frame should take: the app's own colour scheme and
 * the colours behind it.
 *
 * The colours are read during render rather than after commit because the theme
 * mode and the `dark` class on the root element are set together, before the
 * re-render this hook is part of — so the computed values are already the new
 * ones by the time it runs, and reading them post-commit would only cost a
 * second render with the old colours on it.
 */
export function useFrameAppearance(): FrameAppearance {
  const { mode } = useTheme();

  return React.useMemo(() => {
    const style = globalThis.getComputedStyle(document.documentElement);
    const background = readToken(style, APPEARANCE_TOKENS.background);
    const foreground = readToken(style, APPEARANCE_TOKENS.foreground);
    return {
      theme: mode,
      ...(background === undefined ? {} : { background }),
      ...(foreground === undefined ? {} : { foreground }),
    };
  }, [mode]);
}
