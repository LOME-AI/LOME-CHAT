import { describe, expect, it } from 'vitest';

import { cursorPosition, cursorPressSize } from './cursor-position.js';
import type { CaptureAction, CaptureLog } from '../capture/types.js';

function log(actions: CaptureAction[]): CaptureLog {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    videoFile: 'demo.webm',
    actions,
  };
}

const path = log([
  { t: 0, x: 0, y: 0, kind: 'move', label: '' },
  { t: 100, x: 100, y: 200, kind: 'move', label: '' },
]);

describe('cursorPosition', () => {
  it('returns null when the log has no move or click events', () => {
    expect(
      cursorPosition(log([{ t: 0, x: 0, y: 0, kind: 'mark', label: 'beat' }]), 0, 1)
    ).toBeNull();
  });

  it('interpolates between the bracketing events and applies scale', () => {
    expect(cursorPosition(path, 50, 2)).toEqual({ x: 100, y: 200 });
  });

  it('clamps to the first event before the timeline starts', () => {
    expect(cursorPosition(path, 0, 2)).toEqual({ x: 0, y: 0 });
  });

  it('rests on the last event after the timeline ends', () => {
    expect(cursorPosition(path, 150, 2)).toEqual({ x: 200, y: 400 });
  });
});

describe('cursorPressSize', () => {
  it('rests at full size when no click has happened yet', () => {
    expect(cursorPressSize(path, 3, 30)).toBe(22);
  });

  it('dips below full size while a recent click springs', () => {
    const clicked = log([{ t: 0, x: 0, y: 0, kind: 'click', label: 'send' }]);
    const size = cursorPressSize(clicked, 6, 30);
    expect(size).toBeGreaterThanOrEqual(17);
    expect(size).toBeLessThan(22);
  });
});
