import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createChunkHighlighter } from './chunk-highlighter';
import { normalizeForSpeech } from './text-normalizer';
import { useA11yStore } from '../store';

const HIGHLIGHT_NAME = 'tts-reading';
const BLOCK_CLASS = 'tts-reading-block';

const libraryDir = path.dirname(fileURLToPath(import.meta.url));

/** A stand-in for the browser's Highlight: a set of ranges the registry holds. */
class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/**
 * Install a fake CSS Custom Highlight API for the duration of a test. happy-dom
 * ships no `CSS.highlights`/`Highlight`, so the highlighter's feature detection
 * falls to the block-class path unless we inject these. Cleared by
 * `vi.unstubAllGlobals()` in afterEach.
 */
function installHighlightApi(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', FakeHighlight);
  return registry;
}

function registeredRange(registry: Map<string, FakeHighlight>): Range {
  const entry = registry.get(HIGHLIGHT_NAME);
  if (entry === undefined) throw new Error('no highlight registered');
  const range = entry.ranges.at(0);
  if (range === undefined) throw new Error('highlight has no range');
  return range;
}

/** Render `html` inside a container and return the container plus a block picker. */
function mount(html: string): { container: HTMLElement; block: (selector: string) => HTMLElement } {
  document.body.innerHTML = `<article data-reading>${html}</article>`;
  const container = document.body.querySelector('article');
  if (container === null) throw new Error('no container');
  return {
    container,
    block: (selector) => {
      const el = container.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`no block: ${selector}`);
      return el;
    },
  };
}

/** Offsets of a normalized piece within a block, exactly as the reader emits them. */
function spanOf(block: HTMLElement, piece: string): { startOffset: number; endOffset: number } {
  const startOffset = normalizeForSpeech(block.textContent).indexOf(piece);
  return { startOffset, endOffset: startOffset + piece.length };
}

function setViewportRect(el: HTMLElement, top: number, bottom: number): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  useA11yStore.setState({ stopAnimations: false });
});

describe('createChunkHighlighter — block-class fallback (no Highlight API)', () => {
  it('adds the reading block class to the highlighted block', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(p.classList.contains(BLOCK_CLASS)).toBe(true);
  });

  it('clear() removes the block class', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);
    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    hl.clear();

    expect(p.classList.contains(BLOCK_CLASS)).toBe(false);
  });

  it('moves the highlight off the previous block when a new block is highlighted', () => {
    const { container, block } = mount('<p id="a">First one.</p><p id="b">Second one.</p>');
    const first = block('#a');
    const second = block('#b');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: first, ...spanOf(first, 'First one.') });
    hl.highlight({ blockEl: second, ...spanOf(second, 'Second one.') });

    expect(first.classList.contains(BLOCK_CLASS)).toBe(false);
    expect(second.classList.contains(BLOCK_CLASS)).toBe(true);
  });
});

describe('createChunkHighlighter — CSS Custom Highlight API path', () => {
  it('builds a Range covering exactly the chunk span across inline elements', () => {
    const registry = installHighlightApi();
    const { container, block } = mount(
      '<p id="a">Hello <a href="#">world</a> and <code>foo</code> bar.</p>'
    );
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'world and foo') });

    expect(registeredRange(registry).toString()).toBe('world and foo');
  });

  it('maps a span onto raw text nodes even when normalization collapsed whitespace', () => {
    const registry = installHighlightApi();
    // The source HTML wraps an inline link with newlines + indentation, so the
    // block's raw textContent has runs of whitespace the normalizer collapses.
    const { container, block } = mount(
      '<p id="a">Hello\n  <a href="#">world</a>\n  again now.</p>'
    );
    const p = block('#a');
    // The normalizer joins the block's collapsed lines with newlines, so the
    // span is taken directly from the normalized text (significant content
    // "world again now.").
    const norm = normalizeForSpeech(p.textContent);
    const startOffset = norm.indexOf('world');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset, endOffset: norm.length });

    const range = registeredRange(registry);
    // toString returns the RAW text (with un-collapsed whitespace); its
    // significant content must be exactly the mapped span.
    expect(range.toString().replaceAll(/\s+/g, ' ')).toBe('world again now.');
    expect(range.toString().startsWith('world')).toBe(true);
  });

  it('clear() removes the registered highlight', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);
    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });
    expect(registry.has(HIGHLIGHT_NAME)).toBe(true);

    hl.clear();

    expect(registry.has(HIGHLIGHT_NAME)).toBe(false);
  });

  it('replaces the previous highlight when a new chunk is highlighted', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">First. Second sentence here.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'First.') });
    hl.highlight({ blockEl: p, ...spanOf(p, 'Second sentence here.') });

    expect(registry.size).toBe(1);
    expect(registeredRange(registry).toString()).toBe('Second sentence here.');
  });
});

describe('createChunkHighlighter — match-failure degradation', () => {
  it('highlights the whole block when the span cannot map (URL normalized to "link")', () => {
    const registry = installHighlightApi();
    // textContent has a raw URL; normalizeForSpeech turns it into "link", so the
    // normalized offsets do not map onto the raw text nodes.
    const { container, block } = mount('<p id="a">See https://example.com/page now.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    expect(() => {
      hl.highlight({ blockEl: p, ...spanOf(p, 'link') });
    }).not.toThrow();

    expect(registeredRange(registry).toString()).toBe('See https://example.com/page now.');
  });

  it('falls back to a whole-block range for inverted offsets', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: 5, endOffset: 5 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range for a negative start offset', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: -1, endOffset: 5 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range when the end offset exceeds the text', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: 0, endOffset: 999 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range when the span is whitespace only', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hi there.</p>');
    const p = block('#a');
    // The single space between the two words is a whitespace-only span.
    const spaceIndex = normalizeForSpeech(p.textContent).indexOf(' ');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: spaceIndex, endOffset: spaceIndex + 1 });

    expect(registeredRange(registry).toString()).toBe('Hi there.');
  });

  it('never throws and degrades to the block class if the Highlight registry errors', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    vi.stubGlobal('CSS', {
      highlights: {
        set: (): never => {
          throw new Error('registry boom');
        },
        delete: (): void => {},
      },
    });
    vi.stubGlobal('Highlight', FakeHighlight);
    const hl = createChunkHighlighter(container);

    expect(() => {
      hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });
    }).not.toThrow();
    expect(p.classList.contains(BLOCK_CLASS)).toBe(true);
  });
});

describe('createChunkHighlighter — auto-scroll', () => {
  it('scrolls the block into view when it is below the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 1000, 1040);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('scrolls the block into view when it is above the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, -80, -40);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('does not scroll when the block is already in the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 100, 140);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls instantly when reduced motion is requested (stop-animations)', () => {
    useA11yStore.setState({ stopAnimations: true });
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 1000, 1040);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
  });
});

describe('reading-highlight stylesheet contract', () => {
  it('index.css imports the reading-highlight stylesheet into the accessibility layer', () => {
    const index = readFileSync(path.join(libraryDir, '../styles/index.css'), 'utf8');
    expect(index).toMatch(/@import\s+'\.\/reading-highlight\.css'\s+layer\(accessibility\)/);
  });

  it('styles the highlight and fallback via the brand tint token, no border', () => {
    const css = readFileSync(path.join(libraryDir, '../styles/reading-highlight.css'), 'utf8');
    expect(css).toContain(`::highlight(${HIGHLIGHT_NAME})`);
    expect(css).toContain(`.${BLOCK_CLASS}`);
    expect(css).toContain('var(--brand-red-subtle)');
    expect(css).not.toMatch(/\bborder\b/);
  });
});
