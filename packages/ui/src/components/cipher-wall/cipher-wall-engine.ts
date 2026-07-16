import { getSecureRandomIndex, getSecureRandomElement } from '@hushbox/shared';

export interface Cell {
  cipherChar: string;
  targetChar: string;
  state: 'cipher' | 'decrypting' | 'readable' | 'encrypting';
  progress: number;
  rollChar: string;
  color: string;
}

export interface MessageReveal {
  startIndex: number;
  text: string;
  charIndex: number;
  state: 'decrypting' | 'holding' | 'fading';
  holdTimer: number;
  rollTimer: number;
  rollTickTimer: number;
}

export interface CipherWallState {
  cells: Cell[];
  cols: number;
  rows: number;
  reveals: MessageReveal[];
  revealTimer: number;
  messageQueue: number[];
  exclusionZone: Set<number> | null;
  /**
   * The pool of strings the animation reveals and the frozen snapshot bakes
   * in. Every caller of {@link createGrid} / {@link createFrozenSnapshot}
   * must supply this — there is no module-level fallback, on purpose: the
   * native splash PNG is byte-coupled to its specific 4-string pool and
   * deserves an explicit declaration at its call site (see
   * splash-screen.tsx), and each marketing page picks its own list to keep
   * the cipher copy thematic to the page.
   */
  messages: readonly string[];
}

export interface ThemeColors {
  background: string;
  foreground: string;
  brandRed: string;
  foregroundMuted: string;
}

export const CELL_WIDTH = 12;
export const CELL_HEIGHT = 22;
export const FONT_SIZE = 16;
export const FONT = `${String(FONT_SIZE)}px 'JetBrains Mono', monospace`;
export const REVEAL_INTERVAL = 2;
export const HOLD_DURATION = 5;
export const DECRYPT_TICK = 0.08;
export const DECRYPT_SPEED = 1 / 6;
export const ENCRYPT_ROLL_DURATION = 1;
export const ENCRYPT_TICK = 0.07;
export const MAX_ACTIVE_REVEALS = 6;
export const INITIAL_REVEALS = 3;
export const LOGO_OPACITY_BOOST = 0.15;
export const MARGIN_ROWS = 1;
export const MARGIN_COLS = 5;
export const EXCLUSION_STRIDE = 1024;

export const CIPHER_CHARS: readonly string[] = [
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  '#',
  '%',
  '&',
  '@',
  '$',
  '*',
  '+',
  '=',
  '~',
  '{',
  '}',
  '[',
  ']',
  '<',
  '>',
  '/',
  '\\',
  '|',
  '^',
  '`',
  ':',
  ';',
  '!',
  '?',
];

/** Strict cell lookup — throws if out of bounds. */
function getCell(cells: Cell[], index: number): Cell {
  const cell = cells[index];
  // Defensive: callers always index within bounds; the throw is a guard rail.
  /* v8 ignore next 2 */
  if (!cell)
    throw new Error(`Cell [${String(index)}] out of bounds (length=${String(cells.length)})`);

  return cell;
}

function createCipherCell(): Cell {
  return {
    cipherChar: randomCipherChar(),
    targetChar: '',
    state: 'cipher',
    progress: 0,
    rollChar: '',
    color: '',
  };
}

export function randomCipherChar(): string {
  return getSecureRandomElement(CIPHER_CHARS);
}

function createMessageQueue(length: number): number[] {
  const indices = Array.from({ length }, (_, index) => index);
  for (let index = indices.length - 1; index > 0; index--) {
    const index_ = getSecureRandomIndex(index + 1);
    const a = indices[index];
    const b = indices[index_];
    // Defensive: both indices are always in range during the Fisher-Yates walk.
    /* v8 ignore next */
    if (a !== undefined && b !== undefined) {
      indices[index] = b;
      indices[index_] = a;
    }
  }
  return indices;
}

export function createGrid(
  cols: number,
  rows: number,
  messages: readonly string[]
): CipherWallState {
  const total = cols * rows;
  const cells: Cell[] = [];
  for (let index = 0; index < total; index++) {
    cells.push(createCipherCell());
  }
  return {
    cells,
    cols,
    rows,
    reveals: [],
    revealTimer: REVEAL_INTERVAL,
    messageQueue: createMessageQueue(messages.length),
    exclusionZone: null,
    messages,
  };
}

export function resizeCells(state: CipherWallState, newCols: number, newRows: number): void {
  const newTotal = newCols * newRows;
  const oldTotal = state.cells.length;

  if (newCols === state.cols && newRows === state.rows) return;

  if (newTotal > oldTotal) {
    for (let index = oldTotal; index < newTotal; index++) {
      state.cells.push(createCipherCell());
    }
  } else if (newTotal < oldTotal) {
    state.cells.length = newTotal;
  }

  state.cols = newCols;
  state.rows = newRows;

  state.reveals = state.reveals.filter(
    (reveal) => reveal.startIndex + reveal.text.length <= newTotal
  );
}

function initializeRevealCells(cells: Cell[], reveal: MessageReveal): void {
  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(cells, reveal.startIndex + index);
    cell.state = 'decrypting';
    cell.targetChar = reveal.text.charAt(index);
    cell.rollChar = randomCipherChar();
    cell.progress = 1;
  }
}

export function seedInitialReveals(state: CipherWallState): void {
  for (let index = 0; index < INITIAL_REVEALS; index++) {
    const reveal = tryPlaceReveal(state);
    if (reveal) {
      state.reveals.push(reveal);
      initializeRevealCells(state.cells, reveal);
    }
  }
}

function parseHex(hex: string): [number, number, number] {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [r, g, b];
}

const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

function toHex(r: number, g: number, b: number): string {
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

export function interpolateColor(colorA: string, colorB: string, progress: number): string {
  const t = Math.max(0, Math.min(1, progress));
  const [rA, gA, bA] = parseHex(colorA);
  const [rB, gB, bB] = parseHex(colorB);
  return toHex(rA + (rB - rA) * t, gA + (gB - gA) * t, bA + (bB - bA) * t);
}

export function getDisplayChar(cell: Cell): string {
  switch (cell.state) {
    case 'cipher': {
      return cell.cipherChar;
    }
    case 'readable': {
      return cell.targetChar;
    }
    case 'decrypting':
    case 'encrypting': {
      return cell.rollChar;
    }
  }
}

export function getCellColor(cell: Cell, colors: ThemeColors): string {
  switch (cell.state) {
    case 'cipher': {
      return colors.foreground;
    }
    case 'readable': {
      return colors.brandRed;
    }
    case 'decrypting': {
      return interpolateColor(colors.foreground, colors.brandRed, cell.progress);
    }
    case 'encrypting': {
      return interpolateColor(colors.brandRed, colors.foreground, cell.progress);
    }
  }
}

function overlapsExclusionZone(
  excluded: Set<number> | null,
  startIndex: number,
  length: number,
  cols: number
): boolean {
  if (!excluded) return false;
  for (let index = 0; index < length; index++) {
    const flatIndex = startIndex + index;
    const row = Math.floor(flatIndex / cols);
    const col = flatIndex % cols;
    if (excluded.has(row * EXCLUSION_STRIDE + col)) return true;
  }
  return false;
}

function overlapsExistingReveal(
  reveals: MessageReveal[],
  startIndex: number,
  length: number
): boolean {
  const endIndex = startIndex + length;
  for (const r of reveals) {
    const rEnd = r.startIndex + r.text.length;
    if (startIndex < rEnd && r.startIndex < endIndex) return true;
  }
  return false;
}

function tryPlaceReveal(state: CipherWallState): MessageReveal | undefined {
  if (state.messageQueue.length === 0) {
    state.messageQueue = createMessageQueue(state.messages.length);
  }
  const index = state.messageQueue[0];
  if (index === undefined) return undefined;
  const text = state.messages[index];
  if (!text) return undefined;

  const availableRows = state.rows - 2 * MARGIN_ROWS;
  const availableCols = state.cols - 2 * MARGIN_COLS - text.length + 1;
  if (availableRows <= 0 || availableCols <= 0) return undefined;

  for (let attempt = 0; attempt < 20; attempt++) {
    const row = MARGIN_ROWS + getSecureRandomIndex(availableRows);
    const col = MARGIN_COLS + getSecureRandomIndex(availableCols);
    const startIndex = row * state.cols + col;
    if (overlapsExistingReveal(state.reveals, startIndex, text.length)) continue;
    if (overlapsExclusionZone(state.exclusionZone, startIndex, text.length, state.cols)) continue;
    state.messageQueue.shift();
    return {
      startIndex,
      text,
      charIndex: 0,
      state: 'decrypting',
      holdTimer: 0,
      rollTimer: 0,
      rollTickTimer: 0,
    };
  }
  return undefined;
}

function updateDecryptingPhase(reveal: MessageReveal, cells: Cell[], dt: number): boolean {
  reveal.charIndex += dt / DECRYPT_SPEED;
  const resolved = Math.min(Math.floor(reveal.charIndex), reveal.text.length);

  for (let index = 0; index < resolved; index++) {
    const cell = getCell(cells, reveal.startIndex + index);
    cell.state = 'readable';
    cell.targetChar = reveal.text.charAt(index);
    cell.progress = 1;
  }

  reveal.rollTickTimer += dt;
  if (reveal.rollTickTimer >= DECRYPT_TICK) {
    reveal.rollTickTimer -= DECRYPT_TICK;
    for (let index = resolved; index < reveal.text.length; index++) {
      getCell(cells, reveal.startIndex + index).rollChar = randomCipherChar();
    }
  }

  if (resolved >= reveal.text.length) {
    reveal.state = 'holding';
    reveal.holdTimer = HOLD_DURATION;
    reveal.charIndex = 0;
  }
  return false;
}

function updateHoldingPhase(reveal: MessageReveal, cells: Cell[], dt: number): boolean {
  reveal.holdTimer -= dt;
  if (reveal.holdTimer <= 0) {
    reveal.state = 'fading';
    reveal.rollTimer = ENCRYPT_ROLL_DURATION;
    reveal.rollTickTimer = 0;
    for (let index = 0; index < reveal.text.length; index++) {
      getCell(cells, reveal.startIndex + index).rollChar = randomCipherChar();
    }
  }
  return false;
}

function snapCellsToCipher(cells: Cell[], reveal: MessageReveal): void {
  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(cells, reveal.startIndex + index);
    cell.state = 'cipher';
    cell.targetChar = '';
    cell.progress = 0;
    cell.rollChar = '';
    cell.color = '';
    cell.cipherChar = randomCipherChar();
  }
}

function updateFadingPhase(reveal: MessageReveal, cells: Cell[], dt: number): boolean {
  reveal.rollTimer -= dt;
  reveal.rollTickTimer += dt;

  const progress = Math.min(1, Math.max(0, 1 - reveal.rollTimer / ENCRYPT_ROLL_DURATION));
  const changeRoll = reveal.rollTickTimer >= ENCRYPT_TICK;

  for (let index = 0; index < reveal.text.length; index++) {
    const cell = getCell(cells, reveal.startIndex + index);
    cell.state = 'encrypting';
    cell.progress = progress;
    if (changeRoll) {
      cell.rollChar = randomCipherChar();
    }
  }

  if (changeRoll) {
    reveal.rollTickTimer -= ENCRYPT_TICK;
  }

  if (reveal.rollTimer <= 0) {
    snapCellsToCipher(cells, reveal);
    return true;
  }
  return false;
}

function updateReveal(reveal: MessageReveal, cells: Cell[], dt: number): boolean {
  switch (reveal.state) {
    case 'decrypting': {
      return updateDecryptingPhase(reveal, cells, dt);
    }
    case 'holding': {
      return updateHoldingPhase(reveal, cells, dt);
    }
    case 'fading': {
      return updateFadingPhase(reveal, cells, dt);
    }
  }
}

export function updateState(state: CipherWallState, dt: number): void {
  state.revealTimer -= dt;

  if (state.revealTimer <= 0 && state.reveals.length < MAX_ACTIVE_REVEALS) {
    const reveal = tryPlaceReveal(state);
    if (reveal) {
      state.reveals.push(reveal);
      initializeRevealCells(state.cells, reveal);
    }
    state.revealTimer = REVEAL_INTERVAL;
  }

  const toRemove: number[] = [];
  for (const [index, reveal] of state.reveals.entries()) {
    if (updateReveal(reveal, state.cells, dt)) toRemove.push(index);
  }
  for (let index = toRemove.length - 1; index >= 0; index--) {
    const removeAt = toRemove[index];
    // Defensive: toRemove is a dense array of collected indices.
    /* v8 ignore next */
    if (removeAt !== undefined) state.reveals.splice(removeAt, 1);
  }
}

export function pruneExcludedReveals(state: CipherWallState): void {
  if (!state.exclusionZone) return;
  const { exclusionZone, cols, cells } = state;
  state.reveals = state.reveals.filter((reveal) => {
    if (overlapsExclusionZone(exclusionZone, reveal.startIndex, reveal.text.length, cols)) {
      snapCellsToCipher(cells, reveal);
      return false;
    }
    return true;
  });
}

const CIPHER_BASE_OPACITY = 0.8;
const READABLE_OPACITY = 1;

function getCellOpacity(cell: Cell, isInLogo: boolean): number {
  let alpha: number;
  switch (cell.state) {
    case 'cipher': {
      alpha = CIPHER_BASE_OPACITY;
      break;
    }
    case 'readable': {
      alpha = READABLE_OPACITY;
      break;
    }
    case 'decrypting': {
      alpha = CIPHER_BASE_OPACITY + (READABLE_OPACITY - CIPHER_BASE_OPACITY) * cell.progress;
      break;
    }
    case 'encrypting': {
      alpha = READABLE_OPACITY - (READABLE_OPACITY - CIPHER_BASE_OPACITY) * cell.progress;
      break;
    }
  }
  if (isInLogo) alpha += LOGO_OPACITY_BOOST;
  return Math.min(1, alpha);
}

export interface RenderFrameInput {
  ctx: CanvasRenderingContext2D;
  state: CipherWallState;
  colors: ThemeColors;
  width: number;
  height: number;
  logoMask: boolean[][] | null;
  cipherOpacity: number;
}

export function renderFrame(input: Readonly<RenderFrameInput>): void {
  const { ctx, state, colors, width, height, logoMask, cipherOpacity } = input;
  ctx.clearRect(0, 0, width, height);
  ctx.font = FONT;

  const total = state.cols * state.rows;
  for (let index = 0; index < total; index++) {
    const cell = state.cells[index];
    // Defensive: index stays within the cells array (total === cells.length).
    /* v8 ignore next */
    if (!cell) continue;

    const c = index % state.cols;
    const r = Math.floor(index / state.cols);

    const ch = getDisplayChar(cell);
    const color = getCellColor(cell, colors);
    const isInLogo = logoMask?.[r]?.[c] === true;
    const baseAlpha = getCellOpacity(cell, isInLogo);
    const alpha = cell.state === 'readable' ? baseAlpha : baseAlpha * cipherOpacity;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.fillText(ch, c * CELL_WIDTH, r * CELL_HEIGHT + FONT_SIZE);
  }
  ctx.globalAlpha = 1;
}

interface FrozenPlacement {
  state: CipherWallState;
  index: number;
  offsets: readonly number[];
  center: { row: number; col: number };
}

function placeFrozenMessage({ state, index, offsets, center }: FrozenPlacement): void {
  const text = state.messages[index];
  if (!text) return;

  const offset = offsets[index];
  // Defensive: index is always < offsets.length (bounded by the caller's count).
  /* v8 ignore next */
  if (offset === undefined) return;
  const row = center.row + offset;
  if (row < 0 || row >= state.rows) return;

  const middleChar = Math.floor((text.length - 1) / 2);
  const col = center.col - middleChar;
  if (col < 0 || col + text.length > state.cols) return;

  for (let c = 0; c < text.length; c++) {
    const flatIndex = row * state.cols + col + c;
    const cell = state.cells[flatIndex];
    // Defensive: row/col bounds were validated above, so flatIndex is in range.
    /* v8 ignore next */
    if (!cell) return;
    cell.state = 'readable';
    cell.targetChar = text.charAt(c);
    cell.progress = 1;
  }
}

/**
 * Build a frozen snapshot for the native splash PNG. The `messages` array
 * is laid out directly (no index indirection) — each `messages[i]` is
 * placed at row `center.row + offsets[i]`, in order. The placement offsets
 * are tuned for the four-message splash; passing more than 4 strings is
 * a no-op for the extras.
 *
 * `offset` shifts the whole message block off the grid center (negative `row`
 * = up, positive `col` = right). Defaults to no shift, so the splash and
 * marketing snapshots are unaffected; callers that need the messages moved
 * (e.g. the social banner clearing an avatar overlay) pass non-zero values.
 */
export interface FrozenMessageOffset {
  row?: number;
  col?: number;
}

export function createFrozenSnapshot(
  cols: number,
  rows: number,
  messages: readonly string[],
  offset: FrozenMessageOffset = {}
): CipherWallState {
  const state = createGrid(cols, rows, messages);
  const center = {
    row: Math.floor(rows / 2) + (offset.row ?? 0),
    col: Math.floor(cols / 2) + (offset.col ?? 0),
  };

  const offsets = [-8, -5, 5, 8] as const;
  const count = Math.min(messages.length, offsets.length);

  for (let index = 0; index < count; index++) {
    placeFrozenMessage({ state, index, offsets, center });
  }

  state.reveals = [];
  return state;
}
