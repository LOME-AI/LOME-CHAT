import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingGuide } from './reading-guide';

// fireEvent expects a Node/Window target; the unicorn rule wants `globalThis`.
// This typed alias lets us pass `window` to fireEvent without violating either.
const win = globalThis as unknown as Window;

interface DimRects {
  top: HTMLElement;
  bottom: HTMLElement;
}

function findDimRects(container: HTMLElement): DimRects {
  const dims = container.querySelectorAll<HTMLElement>('[data-a11y-reading-guide]');
  expect(dims.length).toBe(2);
  const [top, bottom] = [...dims].toSorted(
    (a, b) => Number.parseInt(a.style.top || '0', 10) - Number.parseInt(b.style.top || '0', 10)
  );
  return { top: top!, bottom: bottom! };
}

describe('ReadingGuide', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when disabled', () => {
    const { container } = render(<ReadingGuide enabled={false} />);
    expect(container.querySelector('[data-a11y-reading-guide]')).toBeNull();
  });

  it('renders two dim panels when enabled', () => {
    const { container } = render(<ReadingGuide enabled />);
    expect(container.querySelectorAll('[data-a11y-reading-guide]').length).toBe(2);
  });

  it('marks both panels as decorative for assistive tech', () => {
    const { container } = render(<ReadingGuide enabled />);
    const dims = container.querySelectorAll<HTMLElement>('[data-a11y-reading-guide]');
    for (const dim of dims) {
      expect(dim.getAttribute('aria-hidden')).toBe('true');
      expect(dim.style.pointerEvents).toBe('none');
    }
  });

  it('positions panels with z-index 9998', () => {
    const { container } = render(<ReadingGuide enabled />);
    const dims = container.querySelectorAll<HTMLElement>('[data-a11y-reading-guide]');
    for (const dim of dims) {
      expect(dim.style.zIndex).toBe('9998');
      expect(dim.style.position).toBe('fixed');
    }
  });

  it('uses the default dim opacity of 0.5', () => {
    const { container } = render(<ReadingGuide enabled />);
    const dims = container.querySelectorAll<HTMLElement>('[data-a11y-reading-guide]');
    for (const dim of dims) {
      expect(dim.style.background).toContain('0.5');
    }
  });

  it('applies a custom dim opacity', () => {
    const { container } = render(<ReadingGuide enabled dimOpacity={0.8} />);
    const dims = container.querySelectorAll<HTMLElement>('[data-a11y-reading-guide]');
    for (const dim of dims) {
      expect(dim.style.background).toContain('0.8');
    }
  });

  it('updates band position when the cursor moves', () => {
    const { container } = render(<ReadingGuide enabled bandHeight={50} />);
    fireEvent.mouseMove(win, { clientY: 200 });

    const { top, bottom } = findDimRects(container);
    // top dim ends at y - bandHeight/2 = 175
    expect(top.style.height).toBe('175px');
    // bottom dim starts at y + bandHeight/2 = 225
    expect(bottom.style.top).toBe('225px');
  });

  it('honors a custom band height', () => {
    const { container } = render(<ReadingGuide enabled bandHeight={100} />);
    fireEvent.mouseMove(win, { clientY: 300 });

    const { top, bottom } = findDimRects(container);
    expect(top.style.height).toBe('250px');
    expect(bottom.style.top).toBe('350px');
  });

  it('clamps the top dim height to zero when the cursor is near the top of the viewport', () => {
    const { container } = render(<ReadingGuide enabled bandHeight={50} />);
    fireEvent.mouseMove(win, { clientY: 10 });

    const { top, bottom } = findDimRects(container);
    expect(top.style.height).toBe('0px');
    expect(bottom.style.top).toBe('35px');
  });

  it('removes the mousemove listener on unmount', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { unmount } = render(<ReadingGuide enabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
  });

  it('removes the mousemove listener when toggled from enabled to disabled', () => {
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener');
    const { rerender } = render(<ReadingGuide enabled />);
    rerender(<ReadingGuide enabled={false} />);
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
  });

  it('does not register a mousemove listener when followFocus is true', () => {
    const addSpy = vi.spyOn(globalThis, 'addEventListener');
    render(<ReadingGuide enabled followFocus />);
    const mousemoveCalls = addSpy.mock.calls.filter(([event]) => event === 'mousemove');
    expect(mousemoveCalls).toHaveLength(0);
  });

  it('tracks document.activeElement when followFocus is true', () => {
    const button = document.createElement('button');
    button.getBoundingClientRect = vi.fn(() => ({
      top: 400,
      bottom: 440,
      left: 0,
      right: 100,
      width: 100,
      height: 40,
      x: 0,
      y: 400,
      toJSON: () => ({}),
    }));
    document.body.append(button);
    button.focus();

    const { container } = render(<ReadingGuide enabled followFocus bandHeight={40} />);
    fireEvent.focusIn(button);

    const { top, bottom } = findDimRects(container);
    // mid = (400 + 440) / 2 = 420; top = 420 - 20 = 400; bottom = 420 + 20 = 440
    expect(top.style.height).toBe('400px');
    expect(bottom.style.top).toBe('440px');

    button.remove();
  });

  it('removes the focusin listener on unmount when followFocus is true', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = render(<ReadingGuide enabled followFocus />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('focusin', expect.any(Function));
  });
});
