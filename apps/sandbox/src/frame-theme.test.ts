import { describe, it, expect } from 'vitest';
import { frameThemeCss } from './frame-theme.js';
import type { FrameAppearance } from '@hushbox/shared/documents';

/**
 * Read one declaration's value out of the generated rule. The property is
 * anchored to a declaration boundary so that reading `color` cannot pick up the
 * tail of `background-color`.
 */
function declaration(css: string, property: string): string | undefined {
  return new RegExp(String.raw`[{;]${property}:\s*([^;}]+)`).exec(css)?.[1]?.trim();
}

describe('frame theme stylesheet', () => {
  it('sets the colour scheme to the theme it is given', () => {
    expect(declaration(frameThemeCss({ theme: 'light' }), 'color-scheme')).toBe('light');
    expect(declaration(frameThemeCss({ theme: 'dark' }), 'color-scheme')).toBe('dark');
  });

  it('paints the colours the embedder resolved', () => {
    // The frame holds no palette of its own: what it paints is whatever the
    // embedder read off the app's tokens. A colour compiled in here would be a
    // copy of those tokens that nothing keeps honest.
    const css = frameThemeCss({ theme: 'dark', background: '#1a1816', foreground: '#f2f1ef' });
    expect(declaration(css, 'background-color')).toBe('#1a1816');
    expect(declaration(css, 'color')).toBe('#f2f1ef');
  });

  it('states only the parts of the appearance the embedder stated', () => {
    // An unstated part is not a part to guess at — leaving it out is what lets
    // an embedder that predates a field keep the appearance it always had.
    const css = frameThemeCss({ background: '#123456' });
    expect(declaration(css, 'background-color')).toBe('#123456');
    expect(css).not.toContain('color-scheme');
    expect(declaration(css, 'color')).toBeUndefined();
  });

  it('states nothing when the embedder stated no appearance', () => {
    const unstated: FrameAppearance = {};
    expect(frameThemeCss(unstated)).toBe('');
  });

  it('states its colours as a defeasible default', () => {
    // The frame's colours are the canvas a document sits on, not a house style
    // imposed on it: a document that paints its own background or text must
    // still win. The selector is the whole of that promise. `html` is the
    // weakest way to reach the root element, so any root-level rule a document
    // ships either ties it (and wins on order) or outranks it; `:root` selects
    // the same element but as a class-level selector, which would silently beat
    // every `html { … }` a document writes.
    const css = frameThemeCss({ theme: 'dark', background: '#1a1816', foreground: '#f2f1ef' });
    expect(css).not.toContain('!important');
    expect(css.startsWith('html{')).toBe(true);
  });
});
