// A type-only import of the bridge's appearance, from the narrow
// `@hushbox/shared/documents` subpath like every other import in the bundles this
// credential-free origin serves — the top-level barrel `export *`s the backend
// env-config registry, which esbuild cannot tree-shake out.
import type { FrameAppearance } from '@hushbox/shared/documents';

/**
 * The frame's own appearance: the canvas a document is shown on, applied by both
 * sandbox pages from what the embedder states.
 *
 * There is no palette here, deliberately. The frame is cross-origin and cannot
 * read the app's CSS custom properties, but its parent can and is already
 * sending it a message, so the parent resolves them and sends the values. A
 * palette compiled into this bundle would be a copy of the app's theme tokens
 * that nothing keeps honest — the failure it produces is a frame whose canvas no
 * longer matches the panel around it, which no test can see — and this bundle is
 * served from a public origin that should carry none of the app's design.
 */

/**
 * The id of the single style element the appearance is written into. Stable so a
 * later message rewrites that element rather than stacking another one, which is
 * what lets an appearance change restyle a live frame without a remount.
 */
const THEME_STYLE_ID = 'hushbox-frame-theme';

/**
 * The stylesheet for an appearance, or nothing when the embedder stated none.
 * Each part is written only if it was stated, so an embedder that predates a
 * field leaves that part of the frame's appearance alone rather than having it
 * guessed at.
 *
 * `html` and no `!important`, deliberately: this is the default a document sits
 * on, not a style imposed on it. A type selector is the weakest way to reach the
 * root element, so every root-level rule a document ships either ties it — and
 * wins on order, since a document's styles always arrive after this element — or
 * outranks it outright. `:root` selects the same element but is a class-level
 * selector, and would beat an author's `html { … }` no matter what order the two
 * arrive in.
 *
 * `color-scheme` is not redundant with the colours: it is what reaches the parts
 * the browser draws itself — form controls, scrollbars, and a document's own
 * `Canvas`/`CanvasText` colours — which stay light-mode without it.
 */
export function frameThemeCss(appearance: FrameAppearance): string {
  const declarations = [
    appearance.theme === undefined ? undefined : `color-scheme:${appearance.theme}`,
    appearance.background === undefined ? undefined : `background-color:${appearance.background}`,
    appearance.foreground === undefined ? undefined : `color:${appearance.foreground}`,
  ].filter((declaration) => declaration !== undefined);
  if (declarations.length === 0) return '';
  return `html{${declarations.join(';')}}`;
}

/* v8 ignore start -- DOM plumbing that runs only inside a real frame; a Node-environment
   test of it would assert against a DOM this code never meets, so it is verified where the
   rest of the frame's behavior is: the browser integration tests, driven against the
   shipped bundles. The theme's own logic lives in `frameThemeCss`, which is covered. */
/**
 * Apply the embedder's appearance to this frame, replacing whatever was applied
 * before. It touches nothing but the one style element, so a document already
 * running in the frame keeps running — restyling never costs a re-execution.
 */
export function applyFrameTheme(appearance: FrameAppearance): void {
  const existing = document.querySelector<HTMLStyleElement>(`#${THEME_STYLE_ID}`);
  const style = existing ?? document.createElement('style');
  style.id = THEME_STYLE_ID;
  style.textContent = frameThemeCss(appearance);
  if (existing === null) document.head.append(style);
}
/* v8 ignore stop */
