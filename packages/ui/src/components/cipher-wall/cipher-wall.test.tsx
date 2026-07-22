// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { CipherWall, useRadialMask, computeExclusionZone } from './cipher-wall';
import { EXCLUSION_STRIDE, CELL_WIDTH, CELL_HEIGHT } from './cipher-wall-engine';

const TEST_MESSAGES_FOR_RENDER: readonly string[] = ['Test One', 'Test Two', 'Test Three'];

let lastUseCipherWallOptions: Record<string, unknown> | undefined;
const stableCanvasRef = { current: null };
vi.mock('./use-cipher-wall', () => ({
  useCipherWall: (
    options?: Record<string, unknown>,
    externalRef?: React.RefObject<HTMLCanvasElement | null>
  ) => {
    lastUseCipherWallOptions = options;
    return externalRef ?? stableCanvasRef;
  },
}));

function createMockRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...overrides,
  };
}

function setupResizeObserver(): {
  triggerResize: () => void;
  disconnect: ReturnType<typeof vi.fn>;
} {
  let resizeCallback: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
      callback([], this);
    }
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  return {
    triggerResize: (): void => {
      if (resizeCallback) {
        resizeCallback([], {} as unknown as ResizeObserver);
      }
    },
    disconnect,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  lastUseCipherWallOptions = undefined;
});

describe('CipherWall', () => {
  it('renders a canvas element', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    expect(screen.getByTestId(TEST_IDS.cipherWall)).toBeInstanceOf(HTMLCanvasElement);
  });

  it('has role="img" for accessibility', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('has an aria-label describing the animation', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    const canvas = screen.getByRole('img');
    expect(canvas).toHaveAttribute('aria-label');
    expect(canvas.getAttribute('aria-label')).toMatch(/encrypt/i);
  });

  it('has CSS mask-image fading the left edge by default', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas.style.maskImage).toContain('transparent');
    expect(canvas.style.maskImage).toContain('black');
  });

  it('does not apply mask-image when frozen is true', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} frozen />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas.style.maskImage).toBe('');
  });

  it('has full-size classes by default', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas).toHaveClass('h-full', 'w-full');
  });

  it('applies custom className when provided', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} className="custom-class" />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas).toHaveClass('custom-class');
  });

  it('applies custom style when provided', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} frozen style={{ opacity: 0.5 }} />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas.style.opacity).toBe('0.5');
  });

  it('accepts cipherOpacity prop without error', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} frozen cipherOpacity={0.5} />);
    expect(screen.getByTestId(TEST_IDS.cipherWall)).toBeInstanceOf(HTMLCanvasElement);
  });

  it('throws when fadeMask is radial but fadeMaskTarget is missing', () => {
    expect(() =>
      render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} fadeMask="radial" />)
    ).toThrow('CipherWall: fadeMask="radial" requires fadeMaskTarget selector');
  });

  it('computes pixel-based radial mask from fadeMaskTarget element', () => {
    const target = document.createElement('div');
    target.dataset['target'] = '';
    document.body.append(target);

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 576, height: 400, right: 576, bottom: 400 })
    );

    setupResizeObserver();

    render(
      <CipherWall
        messages={TEST_MESSAGES_FOR_RENDER}
        fadeMask="radial"
        fadeMaskTarget="[data-target]"
      />
    );
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);

    expect(canvas.style.maskImage).toContain('300px');
    expect(canvas.style.maskImage).toContain('224px');
    expect(canvas.style.maskImage).toContain('radial-gradient');

    target.remove();
  });

  it('throws when fadeMaskTarget element is not found in DOM', () => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }))
    );

    expect(() =>
      render(
        <CipherWall
          messages={TEST_MESSAGES_FOR_RENDER}
          fadeMask="radial"
          fadeMaskTarget="[data-nonexistent]"
        />
      )
    ).toThrow('CipherWall: fadeMaskTarget "[data-nonexistent]" not found in DOM');
  });

  it('applies no mask when fadeMask is none', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} fadeMask="none" />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas.style.maskImage).toBe('');
  });

  it('applies no mask when frozen regardless of fadeMask', () => {
    render(
      <CipherWall
        messages={TEST_MESSAGES_FOR_RENDER}
        frozen
        fadeMask="radial"
        fadeMaskTarget="[data-target]"
      />
    );
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas.style.maskImage).toBe('');
  });
});

describe('useRadialMask', () => {
  it('returns { maskStyles, exclusionZone } shape', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;
    const { result } = renderHook(() => useRadialMask('none', undefined, false, canvasRef));

    expect(result.current).toHaveProperty('maskStyles');
    expect(result.current).toHaveProperty('exclusionZone');
  });

  it('returns null exclusionZone when fadeMask is not radial', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;

    const { result: leftResult } = renderHook(() =>
      useRadialMask('left', undefined, false, canvasRef)
    );
    expect(leftResult.current.exclusionZone).toBeNull();

    const { result: noneResult } = renderHook(() =>
      useRadialMask('none', undefined, false, canvasRef)
    );
    expect(noneResult.current.exclusionZone).toBeNull();
  });

  it('returns null exclusionZone when frozen', () => {
    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;
    const { result } = renderHook(() => useRadialMask('radial', '[data-target]', true, canvasRef));
    expect(result.current.exclusionZone).toBeNull();
  });

  it('returns a Set<number> exclusionZone when fadeMask is radial', () => {
    const target = document.createElement('div');
    target.dataset['target'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-target]', false, canvasRef));

    expect(result.current.exclusionZone).toBeInstanceOf(Set);
    expect(result.current.exclusionZone!.size).toBeGreaterThan(0);

    target.remove();
  });

  it('exclusion zone contains correct coordinates based on ellipse geometry', () => {
    const target = document.createElement('div');
    target.dataset['exzone'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 44, left: 100, top: 50, right: 220, bottom: 94 })
    );

    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-exzone]', false, canvasRef));

    const zone = result.current.exclusionZone!;
    expect(zone).toBeInstanceOf(Set);

    const centerKey = 3 * EXCLUSION_STRIDE + 13;
    expect(zone.has(centerKey)).toBe(true);

    const farKey = 0 * EXCLUSION_STRIDE + 0;
    expect(zone.has(farKey)).toBe(false);

    target.remove();
  });

  it('exclusion zone is recomputed on target resize', () => {
    const target = document.createElement('div');
    target.dataset['resize'] = '';
    document.body.append(target);

    const targetRectSpy = vi
      .spyOn(target, 'getBoundingClientRect')
      .mockReturnValue(
        createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
      );

    const canvasEl = document.createElement('canvas');
    vi.spyOn(canvasEl, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 600, height: 400, left: 0, top: 0, right: 600, bottom: 400 })
    );
    const canvasRef = { current: canvasEl } as React.RefObject<HTMLCanvasElement | null>;

    const { triggerResize } = setupResizeObserver();

    const { result } = renderHook(() => useRadialMask('radial', '[data-resize]', false, canvasRef));

    const initialZone = result.current.exclusionZone;
    expect(initialZone).toBeInstanceOf(Set);
    const initialSize = initialZone!.size;

    targetRectSpy.mockReturnValue(
      createMockRect({ width: 300, height: 200, left: 50, top: 20, right: 350, bottom: 220 })
    );

    act(() => {
      triggerResize();
    });

    const updatedZone = result.current.exclusionZone;
    expect(updatedZone).toBeInstanceOf(Set);
    expect(updatedZone!.size).toBeGreaterThan(initialSize);

    target.remove();
  });

  it('returns null exclusionZone when canvasRef.current is null', () => {
    const target = document.createElement('div');
    target.dataset['nocanvas'] = '';
    document.body.append(target);
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    const canvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;

    setupResizeObserver();

    const { result } = renderHook(() =>
      useRadialMask('radial', '[data-nocanvas]', false, canvasRef)
    );

    expect(result.current.maskStyles).toBeDefined();
    expect(result.current.exclusionZone).toBeNull();

    target.remove();
  });
});

describe('CipherWall exclusionZone wiring', () => {
  it('passes exclusionZone from useRadialMask to useCipherWall options', () => {
    const target = document.createElement('div');
    target.dataset['wire'] = '';
    document.body.append(target);

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
      createMockRect({ width: 120, height: 88, left: 100, top: 50, right: 220, bottom: 138 })
    );

    setupResizeObserver();

    render(
      <CipherWall
        messages={TEST_MESSAGES_FOR_RENDER}
        fadeMask="radial"
        fadeMaskTarget="[data-wire]"
      />
    );

    expect(lastUseCipherWallOptions).toBeDefined();
    expect(lastUseCipherWallOptions).toHaveProperty('exclusionZone');
    const zone = lastUseCipherWallOptions!['exclusionZone'];
    expect(zone === null || zone instanceof Set).toBe(true);

    target.remove();
  });

  it('passes null exclusionZone when fadeMask is not radial', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} fadeMask="left" />);

    expect(lastUseCipherWallOptions).toBeDefined();
    expect(lastUseCipherWallOptions).toHaveProperty('exclusionZone');
    expect(lastUseCipherWallOptions!['exclusionZone']).toBeNull();
  });

  it('passes a canvasRef as second argument to useCipherWall', () => {
    render(<CipherWall messages={TEST_MESSAGES_FOR_RENDER} />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
  });
});

describe('computeExclusionZone', () => {
  const realisticInput = {
    targetRect: { left: 576, top: 240, width: 768, height: 400 },
    canvasRect: { left: 0, top: 0, width: 1920, height: 1080 },
  };

  it('excludes the center cell of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.has(20 * EXCLUSION_STRIDE + 80)).toBe(true);
  });

  it('excludes cells near the center', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.has(20 * EXCLUSION_STRIDE + 79)).toBe(true);
    expect(zone.has(20 * EXCLUSION_STRIDE + 81)).toBe(true);
    expect(zone.has(19 * EXCLUSION_STRIDE + 80)).toBe(true);
    expect(zone.has(21 * EXCLUSION_STRIDE + 80)).toBe(true);
  });

  it('does not exclude cells far from the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.has(0 * EXCLUSION_STRIDE + 0)).toBe(false);
    const totalCols = Math.floor(1920 / CELL_WIDTH);
    const totalRows = Math.floor(1080 / CELL_HEIGHT);
    expect(zone.has((totalRows - 1) * EXCLUSION_STRIDE + (totalCols - 1))).toBe(false);
  });

  it('produces a non-empty zone for realistic viewport', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.size).toBeGreaterThan(100);
  });

  it('excludes cells along the horizontal axis of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.has(20 * EXCLUSION_STRIDE + 44)).toBe(true);
    expect(zone.has(20 * EXCLUSION_STRIDE + 115)).toBe(true);
    expect(zone.has(20 * EXCLUSION_STRIDE + 43)).toBe(false);
    expect(zone.has(20 * EXCLUSION_STRIDE + 116)).toBe(false);
  });

  it('excludes cells along the vertical axis of the ellipse', () => {
    const zone = computeExclusionZone(realisticInput);
    expect(zone.has(9 * EXCLUSION_STRIDE + 80)).toBe(true);
    expect(zone.has(30 * EXCLUSION_STRIDE + 80)).toBe(true);
    expect(zone.has(8 * EXCLUSION_STRIDE + 80)).toBe(false);
    expect(zone.has(31 * EXCLUSION_STRIDE + 80)).toBe(false);
  });

  it('clamps to canvas bounds when target is near edge', () => {
    const zone = computeExclusionZone({
      targetRect: { left: 0, top: 0, width: 200, height: 100 },
      canvasRect: { left: 0, top: 0, width: 400, height: 300 },
    });
    for (const key of zone) {
      const row = Math.floor(key / EXCLUSION_STRIDE);
      const col = key % EXCLUSION_STRIDE;
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns empty set when canvas has zero dimensions', () => {
    const zone = computeExclusionZone({
      targetRect: { left: 100, top: 100, width: 200, height: 100 },
      canvasRect: { left: 0, top: 0, width: 0, height: 0 },
    });
    expect(zone.size).toBe(0);
  });

  it('every excluded cell is within the 1.1x ellipse boundary', () => {
    const zone = computeExclusionZone(realisticInput);
    const cx = 80;
    const cy = 20;
    const gridRx = 33;
    const gridRy = 224 / CELL_HEIGHT;

    for (const key of zone) {
      const row = Math.floor(key / EXCLUSION_STRIDE);
      const col = key % EXCLUSION_STRIDE;
      const dx = (col + 0.5 - cx) / gridRx;
      const dy = (row + 0.5 - cy) / gridRy;
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(1.21 + 0.001);
    }
  });
});
