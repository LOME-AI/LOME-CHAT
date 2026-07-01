import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createGrid,
  resizeCells,
  pruneExcludedReveals,
  seedInitialReveals,
  updateState,
  interpolateColor,
  getDisplayChar,
  getCellColor,
  renderFrame,
  createFrozenSnapshot,
  CIPHER_CHARS,
  CELL_WIDTH,
  CELL_HEIGHT,
  FONT_SIZE,
  FONT,
  REVEAL_INTERVAL,
  HOLD_DURATION,
  DECRYPT_TICK,
  DECRYPT_SPEED,
  ENCRYPT_ROLL_DURATION,
  ENCRYPT_TICK,
  MAX_ACTIVE_REVEALS,
  INITIAL_REVEALS,
  LOGO_OPACITY_BOOST,
  MARGIN_ROWS,
  MARGIN_COLS,
  EXCLUSION_STRIDE,
} from './cipher-wall-engine';
import type { Cell, CipherWallState, ThemeColors } from './cipher-wall-engine';

/**
 * The engine no longer ships a default message pool — every caller passes
 * its own. Tests share this fixed list so they don't depend on a specific
 * call site (welcome.astro, splash-screen.tsx, etc.) and individual tests
 * stay readable.
 */
const TEST_MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Only You Hold The Key',
  'Every Model, One Place',
  'Private Group Chats',
  'Zero-Knowledge Password',
  'Switch Models Anytime',
  'Your Messages, Your Control',
  'No Subscriptions Required',
  'One App, Every AI',
  'Never Lose A Conversation',
  'Stop Juggling Subscriptions',
  'Try Any Model Instantly',
  'Your Ideas Stay Yours',
  'Simple, Honest Pricing',
  'No More App Switching',
  'Built For Your Workflow',
];

/** First four messages — used as the splash placement pool in frozen tests. */
const TEST_SPLASH_MESSAGES: readonly string[] = TEST_MESSAGES.slice(0, 4);

function makeGrid(cols: number, rows: number): CipherWallState {
  return createGrid(cols, rows, TEST_MESSAGES);
}

function makeSnapshot(cols: number, rows: number, count: number): CipherWallState {
  return createFrozenSnapshot(cols, rows, TEST_SPLASH_MESSAGES.slice(0, count));
}

const longestMessage = Math.max(...TEST_MESSAGES.map((m) => m.length));

function wideGrid(): CipherWallState {
  return makeGrid(longestMessage + 2 * MARGIN_COLS + 10, 2 * MARGIN_ROWS + 20);
}

function triggerReveal(state: CipherWallState): void {
  state.revealTimer = 0.001;
  updateState(state, 0.002);
}

function excludeAllPlaceableCells(state: CipherWallState): Set<number> {
  const zone = new Set<number>();
  for (let r = MARGIN_ROWS; r < state.rows - MARGIN_ROWS; r++) {
    for (let c = MARGIN_COLS; c < state.cols - MARGIN_COLS; c++) {
      zone.add(r * EXCLUSION_STRIDE + c);
    }
  }
  return zone;
}

function suppressNewReveals(state: CipherWallState): void {
  state.revealTimer = 9999;
}

function countReadableCells(cells: Cell[]): number {
  let count = 0;
  for (const cell of cells) {
    if (cell.state === 'readable') count++;
  }
  return count;
}

function getReadableRows(state: CipherWallState): Set<number> {
  const rowSet = new Set<number>();
  for (let cellIndex = 0; cellIndex < state.cells.length; cellIndex++) {
    if (state.cells[cellIndex]!.state === 'readable') {
      rowSet.add(Math.floor(cellIndex / state.cols));
    }
  }
  return rowSet;
}

function resetCells(state: CipherWallState): void {
  for (const cell of state.cells) {
    cell.state = 'cipher';
    cell.progress = 0;
    cell.targetChar = '';
    cell.rollChar = '';
    cell.color = '';
  }
}

describe('constants', () => {
  it('has non-empty CIPHER_CHARS array', () => {
    expect(CIPHER_CHARS.length).toBeGreaterThan(0);
    for (const ch of CIPHER_CHARS) {
      expect(typeof ch).toBe('string');
      expect(ch).toHaveLength(1);
    }
  });

  it('stores the supplied messages on the state', () => {
    const state = createGrid(10, 5, TEST_MESSAGES);
    expect(state.messages).toBe(TEST_MESSAGES);
  });

  it('has positive numeric constants', () => {
    expect(CELL_WIDTH).toBeGreaterThan(0);
    expect(CELL_HEIGHT).toBeGreaterThan(0);
    expect(FONT_SIZE).toBeGreaterThan(0);
    expect(REVEAL_INTERVAL).toBeGreaterThan(0);
    expect(HOLD_DURATION).toBe(5);
    expect(DECRYPT_TICK).toBe(0.08);
    expect(DECRYPT_SPEED).toBeCloseTo(1 / 6, 10);
    expect(ENCRYPT_ROLL_DURATION).toBe(1);
    expect(ENCRYPT_TICK).toBe(0.07);
    expect(MAX_ACTIVE_REVEALS).toBeGreaterThan(0);
    expect(INITIAL_REVEALS).toBe(3);
    expect(LOGO_OPACITY_BOOST).toBeGreaterThan(0);
    expect(LOGO_OPACITY_BOOST).toBeLessThan(1);
    expect(MARGIN_ROWS).toBeGreaterThan(0);
    expect(MARGIN_COLS).toBeGreaterThan(0);
  });

  it('has a font string containing JetBrains Mono with monospace fallback', () => {
    expect(FONT).toContain('JetBrains Mono');
    expect(FONT).toContain('monospace');
  });

  it('uses 16px font with proportional cell dimensions', () => {
    expect(FONT_SIZE).toBe(16);
    expect(CELL_WIDTH).toBe(12);
    expect(CELL_HEIGHT).toBe(22);
    expect(FONT).toBe(`${String(FONT_SIZE)}px 'JetBrains Mono', monospace`);
  });

  it('exports EXCLUSION_STRIDE as 1024', () => {
    expect(EXCLUSION_STRIDE).toBe(1024);
  });
});

describe('createGrid', () => {
  it('creates flat cell array with expected total length', () => {
    const state = makeGrid(80, 30);
    expect(state.cols).toBe(80);
    expect(state.rows).toBe(30);
    expect(state.cells).toHaveLength(80 * 30);
  });

  it('initializes every cell in cipher state', () => {
    const state = makeGrid(10, 5);
    for (const cell of state.cells) {
      expect(cell.state).toBe('cipher');
    }
  });

  it('assigns a non-empty cipherChar from CIPHER_CHARS to every cell', () => {
    const state = makeGrid(10, 5);
    for (const cell of state.cells) {
      expect(cell.cipherChar).toBeTruthy();
      expect(CIPHER_CHARS).toContain(cell.cipherChar);
    }
  });

  it('initializes cells with empty targetChar', () => {
    const state = makeGrid(10, 5);
    for (const cell of state.cells) {
      expect(cell.targetChar).toBe('');
    }
  });

  it('initializes cells with zero progress', () => {
    const state = makeGrid(10, 5);
    for (const cell of state.cells) {
      expect(cell.progress).toBe(0);
    }
  });

  it('initializes cells with empty rollChar and color', () => {
    const state = makeGrid(10, 5);
    for (const cell of state.cells) {
      expect(cell.rollChar).toBe('');
      expect(cell.color).toBe('');
    }
  });

  it('starts with empty reveals array', () => {
    const state = makeGrid(10, 5);
    expect(state.reveals).toEqual([]);
  });

  it('starts with revealTimer set to REVEAL_INTERVAL', () => {
    const state = makeGrid(10, 5);
    expect(state.revealTimer).toBe(REVEAL_INTERVAL);
  });

  it('uses randomness for cipherChar — not all identical', () => {
    const state = makeGrid(40, 20);
    const chars = new Set<string>();
    for (const cell of state.cells) {
      chars.add(cell.cipherChar);
    }
    expect(chars.size).toBeGreaterThan(1);
  });

  it('initializes messageQueue with TEST_MESSAGES.length indices', () => {
    const state = makeGrid(10, 5);
    expect(state.messageQueue).toHaveLength(TEST_MESSAGES.length);
    const sorted = state.messageQueue.toSorted((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: TEST_MESSAGES.length }, (_, index) => index));
  });

  it('initializes exclusionZone as null', () => {
    const state = makeGrid(10, 5);
    expect(state.exclusionZone).toBeNull();
  });

  it('does not place reveals overlapping the exclusion zone', () => {
    const state = wideGrid();
    state.exclusionZone = excludeAllPlaceableCells(state);

    for (let index = 0; index < 10; index++) {
      triggerReveal(state);
    }
    expect(state.reveals).toHaveLength(0);
  });

  it('places reveals when exclusionZone is null (no exclusion)', () => {
    const state = wideGrid();
    state.exclusionZone = null;
    triggerReveal(state);
    expect(state.reveals.length).toBeGreaterThan(0);
  });

  it('places reveals in cells not covered by the exclusion zone', () => {
    const state = wideGrid();
    const excluded = new Set<number>();
    for (let c = 0; c < state.cols; c++) {
      excluded.add(0 * EXCLUSION_STRIDE + c);
    }
    state.exclusionZone = excluded;

    triggerReveal(state);
    expect(state.reveals.length).toBeGreaterThan(0);
  });

  it('skips placement when any character of message overlaps an excluded cell', () => {
    const state = wideGrid();
    const centerRow = Math.floor(state.rows / 2);
    const centerCol = Math.floor(state.cols / 2);
    const excluded = new Set<number>([centerRow * EXCLUSION_STRIDE + centerCol]);
    state.exclusionZone = excluded;

    for (let index = 0; index < 20; index++) {
      state.revealTimer = 0.001;
      updateState(state, 0.002);
    }

    for (const reveal of state.reveals) {
      for (let charIndex = 0; charIndex < reveal.text.length; charIndex++) {
        const flatIndex = reveal.startIndex + charIndex;
        const r = Math.floor(flatIndex / state.cols);
        const c = flatIndex % state.cols;
        if (r === centerRow) {
          expect(c).not.toBe(centerCol);
        }
      }
    }
  });
});

describe('resizeCells', () => {
  it('is a no-op when dimensions are unchanged', () => {
    const state = makeGrid(10, 5);
    const originalLength = state.cells.length;
    const firstCell = state.cells[0];
    resizeCells(state, 10, 5);
    expect(state.cells).toHaveLength(originalLength);
    expect(state.cells[0]).toBe(firstCell);
  });

  it('expands the array when total increases', () => {
    const state = makeGrid(10, 5);
    expect(state.cells).toHaveLength(50);
    resizeCells(state, 10, 8);
    expect(state.cells).toHaveLength(80);
    expect(state.cols).toBe(10);
    expect(state.rows).toBe(8);
  });

  it('fills new cells with cipher state', () => {
    const state = makeGrid(10, 5);
    resizeCells(state, 10, 8);
    for (let cellIndex = 50; cellIndex < 80; cellIndex++) {
      expect(state.cells[cellIndex]!.state).toBe('cipher');
      expect(CIPHER_CHARS).toContain(state.cells[cellIndex]!.cipherChar);
    }
  });

  it('preserves existing cell identity on expansion', () => {
    const state = makeGrid(10, 5);
    const references = state.cells.map((c) => c);
    resizeCells(state, 10, 8);
    for (let cellIndex = 0; cellIndex < 50; cellIndex++) {
      expect(state.cells[cellIndex]).toBe(references[cellIndex]);
    }
  });

  it('shrinks the array when total decreases', () => {
    const state = makeGrid(10, 5);
    resizeCells(state, 10, 3);
    expect(state.cells).toHaveLength(30);
    expect(state.cols).toBe(10);
    expect(state.rows).toBe(3);
  });

  it('preserves existing cell identity on shrink', () => {
    const state = makeGrid(10, 5);
    const references = state.cells.slice(0, 30).map((c) => c);
    resizeCells(state, 10, 3);
    for (let cellIndex = 0; cellIndex < 30; cellIndex++) {
      expect(state.cells[cellIndex]).toBe(references[cellIndex]);
    }
  });

  it('prunes reveals that extend past the new total', () => {
    const state = makeGrid(80, 30);
    // Manually place a reveal near the end
    state.reveals.push({
      startIndex: 80 * 29, // last row
      text: 'Test Message',
      charIndex: 0,
      state: 'decrypting',
      holdTimer: 0,
      rollTimer: 0,
      rollTickTimer: 0,
    });
    resizeCells(state, 80, 20);
    expect(state.reveals).toHaveLength(0);
  });

  it('preserves reveals that are still within bounds', () => {
    const state = makeGrid(80, 30);
    state.reveals.push({
      startIndex: 80 * 2 + 5, // row 2, safe
      text: 'Test',
      charIndex: 0,
      state: 'decrypting',
      holdTimer: 0,
      rollTimer: 0,
      rollTickTimer: 0,
    });
    resizeCells(state, 80, 20);
    expect(state.reveals).toHaveLength(1);
  });

  it('handles cols change correctly', () => {
    const state = makeGrid(80, 30);
    resizeCells(state, 60, 30);
    expect(state.cells).toHaveLength(60 * 30);
    expect(state.cols).toBe(60);
    expect(state.rows).toBe(30);
  });
});

describe('pruneExcludedReveals', () => {
  it('removes reveals that overlap the exclusion zone', () => {
    const state = wideGrid();
    seedInitialReveals(state);
    expect(state.reveals.length).toBeGreaterThan(0);

    // Exclude every placeable cell — all reveals should be pruned
    state.exclusionZone = excludeAllPlaceableCells(state);
    pruneExcludedReveals(state);
    expect(state.reveals).toHaveLength(0);
  });

  it('keeps reveals that do not overlap the exclusion zone', () => {
    const state = wideGrid();
    seedInitialReveals(state);
    const revealCount = state.reveals.length;
    expect(revealCount).toBeGreaterThan(0);

    // Exclude only row 0 (within margin, no reveals there)
    const zone = new Set<number>();
    for (let c = 0; c < state.cols; c++) {
      zone.add(0 * EXCLUSION_STRIDE + c);
    }
    state.exclusionZone = zone;
    pruneExcludedReveals(state);
    expect(state.reveals).toHaveLength(revealCount);
  });

  it('resets pruned reveal cells to cipher state', () => {
    const state = wideGrid();
    triggerReveal(state);
    const reveal = state.reveals[0]!;

    for (let index = 0; index < reveal.text.length; index++) {
      expect(state.cells[reveal.startIndex + index]!.state).not.toBe('cipher');
    }

    // Exclude the exact cells of the reveal
    const zone = new Set<number>();
    for (let index = 0; index < reveal.text.length; index++) {
      const flatIndex = reveal.startIndex + index;
      const row = Math.floor(flatIndex / state.cols);
      const col = flatIndex % state.cols;
      zone.add(row * EXCLUSION_STRIDE + col);
    }
    state.exclusionZone = zone;
    pruneExcludedReveals(state);

    for (let index = 0; index < reveal.text.length; index++) {
      expect(state.cells[reveal.startIndex + index]!.state).toBe('cipher');
    }
  });

  it('is a no-op when exclusion zone is null', () => {
    const state = wideGrid();
    seedInitialReveals(state);
    const revealCount = state.reveals.length;
    state.exclusionZone = null;
    pruneExcludedReveals(state);
    expect(state.reveals).toHaveLength(revealCount);
  });
});

describe('seedInitialReveals', () => {
  it('places INITIAL_REVEALS reveals on the grid', () => {
    const state = wideGrid();
    seedInitialReveals(state);
    expect(state.reveals).toHaveLength(INITIAL_REVEALS);
  });

  it('sets seeded reveal cells to decrypting with progress=1', () => {
    const state = wideGrid();
    seedInitialReveals(state);

    for (const reveal of state.reveals) {
      for (let index = 0; index < reveal.text.length; index++) {
        const cell = state.cells[reveal.startIndex + index]!;
        expect(cell.state).toBe('decrypting');
        expect(cell.progress).toBe(1);
        expect(cell.targetChar).toBe(reveal.text[index]);
        expect(cell.rollChar).toBeTruthy();
      }
    }
  });

  it('places no reveals when grid is too small', () => {
    const state = makeGrid(5, 5);
    seedInitialReveals(state);
    expect(state.reveals).toHaveLength(0);
  });

  it('does not place reveals overlapping the exclusion zone', () => {
    const state = wideGrid();
    state.exclusionZone = excludeAllPlaceableCells(state);

    seedInitialReveals(state);

    expect(state.reveals).toHaveLength(0);
  });
});

describe('updateState', () => {
  describe('reveal creation', () => {
    it('decrements revealTimer over time', () => {
      const state = wideGrid();
      const before = state.revealTimer;
      updateState(state, 0.5);
      expect(state.revealTimer).toBeCloseTo(before - 0.5);
    });

    it('creates a new reveal when revealTimer hits 0', () => {
      const state = wideGrid();
      expect(state.reveals).toHaveLength(0);
      updateState(state, REVEAL_INTERVAL + 0.01);
      expect(state.reveals).toHaveLength(1);
    });

    it('resets revealTimer after creating a reveal', () => {
      const state = wideGrid();
      updateState(state, REVEAL_INTERVAL + 0.01);
      expect(state.revealTimer).toBeGreaterThan(0);
      expect(state.revealTimer).toBeLessThanOrEqual(REVEAL_INTERVAL);
    });

    it('creates reveal in decrypting state', () => {
      const state = wideGrid();
      triggerReveal(state);
      expect(state.reveals[0]!.state).toBe('decrypting');
    });

    it('selects a message from the supplied messages array', () => {
      const state = wideGrid();
      triggerReveal(state);
      expect(TEST_MESSAGES).toContain(state.reveals[0]!.text);
    });

    it('respects MAX_ACTIVE_REVEALS', () => {
      const state = wideGrid();
      for (let index = 0; index < MAX_ACTIVE_REVEALS + 5; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.01);
      }
      expect(state.reveals.length).toBeLessThanOrEqual(MAX_ACTIVE_REVEALS);
    });

    it('does not create overlapping reveals', () => {
      const state = wideGrid();
      for (let index = 0; index < 3; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.01);
      }
      for (let index = 0; index < state.reveals.length; index++) {
        for (let index_ = index + 1; index_ < state.reveals.length; index_++) {
          const a = state.reveals[index]!;
          const b = state.reveals[index_]!;
          const aEnd = a.startIndex + a.text.length;
          const bEnd = b.startIndex + b.text.length;
          expect(a.startIndex < bEnd && b.startIndex < aEnd).toBe(false);
        }
      }
    });

    it('places reveals within row margins', () => {
      const state = wideGrid();
      for (let index = 0; index < 30; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        for (const reveal of state.reveals) {
          const startRow = Math.floor(reveal.startIndex / state.cols);
          expect(startRow).toBeGreaterThanOrEqual(MARGIN_ROWS);
          const endIndex = reveal.startIndex + reveal.text.length - 1;
          const endRow = Math.floor(endIndex / state.cols);
          expect(endRow).toBeLessThan(state.rows - MARGIN_ROWS);
        }
        state.reveals = [];
        resetCells(state);
      }
    });

    it('places reveals within col margins', () => {
      const state = wideGrid();
      for (let index = 0; index < 30; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        for (const reveal of state.reveals) {
          const startCol = reveal.startIndex % state.cols;
          expect(startCol).toBeGreaterThanOrEqual(MARGIN_COLS);
          expect(startCol + reveal.text.length).toBeLessThanOrEqual(state.cols - MARGIN_COLS);
        }
        state.reveals = [];
        resetCells(state);
      }
    });

    it('places reveals on a single row without wrapping', () => {
      const state = wideGrid();
      for (let index = 0; index < 30; index++) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        for (const reveal of state.reveals) {
          const startRow = Math.floor(reveal.startIndex / state.cols);
          const endRow = Math.floor((reveal.startIndex + reveal.text.length - 1) / state.cols);
          expect(startRow).toBe(endRow);
        }
        state.reveals = [];
        resetCells(state);
      }
    });

    it('sets all chars in message to decrypting with progress=1 on creation', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;
      for (let index = 0; index < reveal.text.length; index++) {
        const cell = state.cells[reveal.startIndex + index]!;
        expect(cell.state).toBe('decrypting');
        expect(cell.progress).toBe(1);
      }
    });
  });

  describe('decrypting phase', () => {
    it('does not cycle chars before DECRYPT_TICK', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      for (let index = 0; index < reveal.text.length; index++) {
        state.cells[reveal.startIndex + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, DECRYPT_TICK * 0.3);

      const resolved = Math.floor((DECRYPT_TICK * 0.3) / DECRYPT_SPEED);
      for (let index = resolved; index < reveal.text.length; index++) {
        expect(state.cells[reveal.startIndex + index]!.rollChar).toBe('MARKER');
      }
    });

    it('cycles unresolved chars after DECRYPT_TICK', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      for (let index = 0; index < reveal.text.length; index++) {
        state.cells[reveal.startIndex + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, DECRYPT_TICK + 0.01);

      const resolved = Math.floor((DECRYPT_TICK + 0.01) / DECRYPT_SPEED);
      let anyChanged = false;
      for (let index = resolved; index < reveal.text.length; index++) {
        if (state.cells[reveal.startIndex + index]!.rollChar !== 'MARKER') {
          anyChanged = true;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it('resolves chars L→R at 6 chars/sec during decrypting', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, 1);

      let readableCount = 0;
      for (let index = 0; index < reveal.text.length; index++) {
        if (state.cells[reveal.startIndex + index]!.state === 'readable') {
          readableCount++;
        }
      }
      expect(readableCount).toBe(6);
    });

    it('sets resolved cells to readable with correct targetChar', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, DECRYPT_SPEED * 3 + 0.01);

      for (let index = 0; index < 3; index++) {
        const cell = state.cells[reveal.startIndex + index]!;
        expect(cell.state).toBe('readable');
        expect(cell.targetChar).toBe(reveal.text[index]);
      }
    });

    it('transitions from decrypting to holding when all chars resolved', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      expect(reveal.state).toBe('holding');
    });

    it('sets all cells to readable after full decrypt', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      for (let index = 0; index < reveal.text.length; index++) {
        expect(state.cells[reveal.startIndex + index]!.state).toBe('readable');
      }
    });

    it('accumulates charIndex fractionally across frames', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      for (let index = 0; index < 10; index++) {
        updateState(state, 0.016);
      }
      expect(state.cells[reveal.startIndex]!.state).toBe('decrypting');

      for (let index = 0; index < 3; index++) {
        updateState(state, 0.016);
      }
      expect(state.cells[reveal.startIndex]!.state).toBe('readable');
    });
  });

  describe('holding phase', () => {
    it('sets holdTimer to HOLD_DURATION when entering holding', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      expect(reveal.holdTimer).toBeCloseTo(HOLD_DURATION, 0);
    });

    it('decrements holdTimer during holding', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);

      const holdBefore = reveal.holdTimer;
      suppressNewReveals(state);
      updateState(state, 0.5);
      expect(reveal.holdTimer).toBeCloseTo(holdBefore - 0.5, 1);
    });

    it('transitions from holding to fading when holdTimer expires', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      expect(reveal.state).toBe('fading');
    });
  });

  describe('fading phase', () => {
    it('sets all cells to encrypting during fading', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      suppressNewReveals(state);
      updateState(state, 0.01);

      for (let index = 0; index < reveal.text.length; index++) {
        expect(state.cells[reveal.startIndex + index]!.state).toBe('encrypting');
      }
    });

    it('cycles chars at ENCRYPT_TICK rate during fading', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;

      suppressNewReveals(state);
      updateState(state, reveal.text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);

      for (let index = 0; index < reveal.text.length; index++) {
        state.cells[reveal.startIndex + index]!.rollChar = 'MARKER';
      }

      suppressNewReveals(state);
      updateState(state, ENCRYPT_TICK + 0.001);

      let anyChanged = false;
      for (let index = 0; index < reveal.text.length; index++) {
        if (state.cells[reveal.startIndex + index]!.rollChar !== 'MARKER') {
          anyChanged = true;
        }
      }
      expect(anyChanged).toBe(true);
    });

    it('snaps all cells to cipher and removes reveal when fading completes', () => {
      const state = wideGrid();
      triggerReveal(state);
      const reveal = state.reveals[0]!;
      const { startIndex, text } = reveal;

      suppressNewReveals(state);
      updateState(state, text.length * DECRYPT_SPEED + 0.01);
      suppressNewReveals(state);
      updateState(state, HOLD_DURATION + 0.1);
      suppressNewReveals(state);
      updateState(state, ENCRYPT_ROLL_DURATION + 0.01);

      for (let index = 0; index < text.length; index++) {
        expect(state.cells[startIndex + index]!.state).toBe('cipher');
      }
      expect(state.reveals).toHaveLength(0);
    });
  });

  describe('message cycling', () => {
    it('cycles through all messages before repeating', () => {
      const state = wideGrid();
      const seen: string[] = [];

      for (let remaining = TEST_MESSAGES.length; remaining > 0; remaining--) {
        state.revealTimer = 0.001;
        updateState(state, 0.002);
        if (state.reveals.length > 0) {
          seen.push(state.reveals.at(-1)!.text);
        }
        state.reveals = [];
        resetCells(state);
      }

      expect(new Set(seen).size).toBe(TEST_MESSAGES.length);
    });
  });
});

describe('interpolateColor', () => {
  it('returns colorA at progress 0', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 0)).toBe('#ff0000');
  });

  it('returns colorB at progress 1', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 1)).toBe('#0000ff');
  });

  it('blends colors at midpoint', () => {
    const mid = interpolateColor('#ff0000', '#0000ff', 0.5);
    expect(mid).toBe('#800080');
  });

  it('handles white to black', () => {
    expect(interpolateColor('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('clamps progress below 0', () => {
    expect(interpolateColor('#ff0000', '#0000ff', -1)).toBe('#ff0000');
  });

  it('clamps progress above 1', () => {
    expect(interpolateColor('#ff0000', '#0000ff', 2)).toBe('#0000ff');
  });
});

describe('getDisplayChar', () => {
  const baseCell: Cell = {
    cipherChar: 'X',
    targetChar: 'H',
    state: 'cipher',
    progress: 0,
    rollChar: 'R',
    color: '',
  };

  it('returns cipherChar for cipher state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'cipher' })).toBe('X');
  });

  it('returns targetChar for readable state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'readable' })).toBe('H');
  });

  it('returns rollChar for decrypting state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'decrypting' })).toBe('R');
  });

  it('returns rollChar for encrypting state', () => {
    expect(getDisplayChar({ ...baseCell, state: 'encrypting' })).toBe('R');
  });
});

describe('getCellColor', () => {
  const colors: ThemeColors = {
    background: '#000000',
    foreground: '#ffffff',
    brandRed: '#ec4755',
    foregroundMuted: '#888888',
  };

  it('returns foreground for cipher state', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: '',
      state: 'cipher',
      progress: 0,
      rollChar: '',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ffffff');
  });

  it('returns brandRed for readable state', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'readable',
      progress: 1,
      rollChar: '',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ec4755');
  });

  it('interpolates between foreground and brandRed during decrypting', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'decrypting',
      progress: 0.5,
      rollChar: 'R',
      color: '',
    };
    const result = getCellColor(cell, colors);
    expect(result).not.toBe('#ffffff');
    expect(result).not.toBe('#ec4755');
  });

  it('interpolates between brandRed and foreground during encrypting', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 0.5,
      rollChar: 'R',
      color: '',
    };
    const result = getCellColor(cell, colors);
    expect(result).not.toBe('#ffffff');
    expect(result).not.toBe('#ec4755');
  });

  it('returns brandRed at start of encrypting (progress 0)', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 0,
      rollChar: 'R',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ec4755');
  });

  it('returns foreground at end of encrypting (progress 1)', () => {
    const cell: Cell = {
      cipherChar: 'X',
      targetChar: 'H',
      state: 'encrypting',
      progress: 1,
      rollChar: 'R',
      color: '',
    };
    expect(getCellColor(cell, colors)).toBe('#ffffff');
  });
});

describe('renderFrame', () => {
  const themeColors: ThemeColors = {
    background: '#1a1816',
    foreground: '#f2f1ef',
    brandRed: '#ec4755',
    foregroundMuted: '#888888',
  };

  interface DrawnCell {
    char: string;
    x: number;
    y: number;
    alpha: number;
    fillStyle: CanvasRenderingContext2D['fillStyle'];
  }

  interface RecordingCtx {
    ctx: CanvasRenderingContext2D;
    drawn: DrawnCell[];
  }

  function mockCtx(): CanvasRenderingContext2D {
    return recordingCtx().ctx;
  }

  /**
   * Records the alpha/fillStyle in effect at each fillText, because the
   * renderer resets globalAlpha after the loop — reading the ctx's final
   * globalAlpha no longer reflects the alpha any individual cell drew with.
   */
  function recordingCtx(): RecordingCtx {
    const drawn: DrawnCell[] = [];
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      fillStyle: '',
      globalAlpha: 1,
      font: '',
      fillText: vi.fn((char: string, x: number, y: number) => {
        drawn.push({ char, x, y, alpha: ctx.globalAlpha, fillStyle: ctx.fillStyle });
      }),
    } as unknown as CanvasRenderingContext2D;
    return { ctx, drawn };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls clearRect with full dimensions', () => {
    const ctx = mockCtx();
    const state = makeGrid(5, 3);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 400,
      height: 300,
      logoMask: null,
      cipherOpacity: 1,
    });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 400, 300);
  });

  it('calls fillText for every cell in the grid', () => {
    const ctx = mockCtx();
    const state = makeGrid(5, 3);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 400,
      height: 300,
      logoMask: null,
      cipherOpacity: 1,
    });
    expect(ctx.fillText).toHaveBeenCalledTimes(15);
  });

  it('sets font to FONT constant', () => {
    const ctx = mockCtx();
    const state = makeGrid(2, 2);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 200,
      height: 200,
      logoMask: null,
      cipherOpacity: 1,
    });
    expect(ctx.font).toBe(FONT);
  });

  it('uses brandRed fillStyle for readable cells', () => {
    const ctx = mockCtx();
    const state = makeGrid(5, 3);
    // cell at row 1, col 2 = flat index 1*5+2 = 7
    state.cells[7]!.state = 'readable';
    state.cells[7]!.targetChar = 'H';

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 400,
      height: 300,
      logoMask: null,
      cipherOpacity: 1,
    });

    const fillTextCalls = vi.mocked(ctx.fillText).mock.calls;
    const callIndex = 7;
    expect(fillTextCalls[callIndex]![0]).toBe('H');
  });

  it('uses 0.8 opacity for cipher cells', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 1,
    });

    expect(drawn[0]!.alpha).toBe(0.8);
  });

  it('boosts opacity for cells inside logo mask', () => {
    const ctx = mockCtx();
    const state = makeGrid(3, 2);
    const logoMask = [
      [false, true, false],
      [false, false, false],
    ];

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 300,
      height: 200,
      logoMask,
      cipherOpacity: 1,
    });
    expect(ctx.fillText).toHaveBeenCalledTimes(6);
  });

  it('positions fillText at correct coordinates using CELL_WIDTH and CELL_HEIGHT', () => {
    const ctx = mockCtx();
    const state = makeGrid(2, 2);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 200,
      height: 200,
      logoMask: null,
      cipherOpacity: 1,
    });

    const fillTextCalls = vi.mocked(ctx.fillText).mock.calls;
    // flat index 0 → col=0, row=0
    expect(fillTextCalls[0]![1]).toBe(0 * CELL_WIDTH);
    expect(fillTextCalls[0]![2]).toBe(0 * CELL_HEIGHT + FONT_SIZE);
    // flat index 1 → col=1, row=0
    expect(fillTextCalls[1]![1]).toBe(1 * CELL_WIDTH);
    expect(fillTextCalls[1]![2]).toBe(0 * CELL_HEIGHT + FONT_SIZE);
    // flat index 2 → col=0, row=1
    expect(fillTextCalls[2]![1]).toBe(0 * CELL_WIDTH);
    expect(fillTextCalls[2]![2]).toBe(1 * CELL_HEIGHT + FONT_SIZE);
  });

  it('applies cipherOpacity to cipher cells', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 0.5,
    });

    expect(drawn[0]!.alpha).toBeCloseTo(0.4);
  });

  it('does not apply cipherOpacity to readable cells', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    state.cells[0]!.state = 'readable';
    state.cells[0]!.targetChar = 'H';
    state.cells[0]!.progress = 1;

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 0.5,
    });

    expect(drawn[0]!.alpha).toBeCloseTo(1);
  });

  it('applies cipherOpacity to decrypting cells', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    state.cells[0]!.state = 'decrypting';
    state.cells[0]!.progress = 0.5;
    state.cells[0]!.rollChar = 'X';

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 0.5,
    });

    expect(drawn[0]!.alpha).toBeCloseTo(0.45);
  });

  it('applies cipherOpacity to encrypting cells', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    state.cells[0]!.state = 'encrypting';
    state.cells[0]!.progress = 0.5;
    state.cells[0]!.rollChar = 'X';

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 0.5,
    });

    expect(drawn[0]!.alpha).toBeCloseTo(0.45);
  });

  it('treats cipherOpacity of 1 as no change', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(1, 1);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 1,
    });

    expect(drawn[0]!.alpha).toBeCloseTo(0.8);
  });

  it('does not save/restore per cell', () => {
    const ctx = mockCtx();
    const state = makeGrid(5, 3);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 400,
      height: 300,
      logoMask: null,
      cipherOpacity: 1,
    });

    expect(ctx.save).not.toHaveBeenCalled();
    expect(ctx.restore).not.toHaveBeenCalled();
  });

  it('resets globalAlpha to 1 after the loop', () => {
    const ctx = mockCtx();
    const state = makeGrid(1, 1);
    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 100,
      height: 100,
      logoMask: null,
      cipherOpacity: 0.5,
    });

    expect(ctx.globalAlpha).toBe(1);
  });

  it('draws each cell with its own alpha and fillStyle despite no per-cell save/restore', () => {
    const { ctx, drawn } = recordingCtx();
    const state = makeGrid(2, 1);
    state.cells[0]!.state = 'cipher';
    state.cells[1]!.state = 'readable';
    state.cells[1]!.targetChar = 'H';
    state.cells[1]!.progress = 1;

    renderFrame({
      ctx,
      state,
      colors: themeColors,
      width: 200,
      height: 100,
      logoMask: null,
      cipherOpacity: 1,
    });

    expect(drawn[0]!.alpha).toBe(0.8);
    expect(drawn[0]!.fillStyle).toBe(themeColors.foreground);
    expect(drawn[1]!.alpha).toBe(1);
    expect(drawn[1]!.fillStyle).toBe(themeColors.brandRed);
  });
});

function findReadableSpan(
  state: CipherWallState,
  row: number
): { firstCol: number; lastCol: number } | undefined {
  let firstCol = -1;
  let lastCol = -1;
  for (let c = 0; c < state.cols; c++) {
    if (state.cells[row * state.cols + c]!.state === 'readable') {
      if (firstCol === -1) firstCol = c;
      lastCol = c;
    }
  }
  return firstCol === -1 ? undefined : { firstCol, lastCol };
}

describe('createFrozenSnapshot', () => {
  const cols = 113;
  const rows = 62;
  const centerRow = Math.floor(rows / 2);
  const centerCol = Math.floor(cols / 2);

  it('returns cells with correct dimensions', () => {
    const state = makeSnapshot(cols, rows, 4);
    expect(state.cols).toBe(cols);
    expect(state.rows).toBe(rows);
    expect(state.cells).toHaveLength(cols * rows);
  });

  it('places 4 messages on 4 distinct rows', () => {
    const state = makeSnapshot(cols, rows, 4);
    const readableRows = getReadableRows(state);
    expect(readableRows.size).toBe(4);
  });

  it('places messages at symmetric row offsets from center (±5 and ±8)', () => {
    const state = makeSnapshot(cols, rows, 4);
    const readableRows = getReadableRows(state);
    const sorted = [...readableRows].toSorted((a, b) => a - b);
    expect(sorted).toEqual([centerRow - 8, centerRow - 5, centerRow + 5, centerRow + 8]);
  });

  it('centers each message by its middle character on the center column', () => {
    const state = makeSnapshot(cols, rows, 4);
    for (let r = 0; r < state.rows; r++) {
      const span = findReadableSpan(state, r);
      if (!span) continue;
      const length = span.lastCol - span.firstCol + 1;
      const middleChar = Math.floor((length - 1) / 2);
      expect(span.firstCol + middleChar).toBe(centerCol);
    }
  });

  it('shifts every message by rowOffset (up) and colOffset (right)', () => {
    const state = createFrozenSnapshot(cols, rows, TEST_SPLASH_MESSAGES.slice(0, 4), {
      row: -2,
      col: 4,
    });
    const sortedRows = [...getReadableRows(state)].toSorted((a, b) => a - b);
    expect(sortedRows).toEqual([centerRow - 10, centerRow - 7, centerRow + 3, centerRow + 6]);
    for (let r = 0; r < state.rows; r++) {
      const span = findReadableSpan(state, r);
      if (!span) continue;
      const length = span.lastCol - span.firstCol + 1;
      const middleChar = Math.floor((length - 1) / 2);
      expect(span.firstCol + middleChar).toBe(centerCol + 4);
    }
  });

  it('places the supplied splash messages in order', () => {
    const state = makeSnapshot(cols, rows, 4);
    const placedMessages: string[] = [];
    for (let r = 0; r < state.rows; r++) {
      let rowText = '';
      for (let c = 0; c < state.cols; c++) {
        const cell = state.cells[r * state.cols + c]!;
        if (cell.state === 'readable') rowText += cell.targetChar;
      }
      if (rowText.length > 0) placedMessages.push(rowText);
    }
    expect(placedMessages).toEqual([...TEST_SPLASH_MESSAGES]);
  });

  it('has no active reveals (static)', () => {
    const state = makeSnapshot(cols, rows, 4);
    expect(state.reveals).toHaveLength(0);
  });

  it('all non-readable cells are in cipher state', () => {
    const state = makeSnapshot(cols, rows, 4);
    for (const cell of state.cells) {
      if (cell.state !== 'readable') {
        expect(cell.state).toBe('cipher');
      }
    }
  });

  it('handles zero messageCount', () => {
    const state = makeSnapshot(cols, rows, 0);
    expect(countReadableCells(state.cells)).toBe(0);
    expect(state.reveals).toHaveLength(0);
  });

  it('skips messages that do not fit in a small grid', () => {
    const state = makeSnapshot(cols, 5, 4);
    const readableRows = getReadableRows(state);
    expect(readableRows.size).toBeLessThan(4);
  });

  it('skips messages that overflow columns in a narrow grid', () => {
    const state = makeSnapshot(10, rows, 4);
    expect(countReadableCells(state.cells)).toBe(0);
  });

  it('initializes exclusionZone as null', () => {
    const state = makeSnapshot(cols, rows, 4);
    expect(state.exclusionZone).toBeNull();
  });
});
