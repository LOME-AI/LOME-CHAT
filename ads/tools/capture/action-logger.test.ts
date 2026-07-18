import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionLogger } from './action-logger.js';
import type { CaptureLog } from './types.js';

const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 } as const;
const T0 = new Date('2026-01-01T00:00:00.000Z');

describe('ActionLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports its construction time as the shared clock origin', () => {
    const logger = new ActionLogger(VIEWPORT, 'out.webm');
    expect(logger.startedAtMs).toBe(T0.getTime());
  });

  it('records an action with elapsed time and the given coordinates', () => {
    const logger = new ActionLogger(VIEWPORT, 'out.webm');
    vi.advanceTimersByTime(250);

    logger.log('click', 12, 34, 'send-button');

    const [action] = logger.save(temporaryFile()).actions;
    expect(action).toEqual({ t: 250, x: 12, y: 34, kind: 'click', label: 'send-button' });
  });

  it('marks at the origin when no action has been logged yet', () => {
    const logger = new ActionLogger(VIEWPORT, 'out.webm');

    logger.mark('beat1');

    const [action] = logger.save(temporaryFile()).actions;
    expect(action).toMatchObject({ kind: 'mark', x: 0, y: 0, label: 'beat1' });
  });

  it('marks at the most recent action coordinates', () => {
    const logger = new ActionLogger(VIEWPORT, 'out.webm');
    logger.log('move', 99, 77, 'model-item');

    logger.mark('beat3');

    const mark = logger.save(temporaryFile()).actions.at(-1);
    expect(mark).toMatchObject({ kind: 'mark', x: 99, y: 77, label: 'beat3' });
  });

  it('writes the log to disk as the CaptureLog shape', () => {
    const logger = new ActionLogger(VIEWPORT, 'demo.webm');
    logger.log('move', 5, 6, 'cursor');
    const file = temporaryFile();

    logger.save(file);

    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as CaptureLog;
    expect(onDisk).toEqual({
      startedAt: T0.toISOString(),
      viewport: VIEWPORT,
      videoFile: 'demo.webm',
      actions: [{ t: 0, x: 5, y: 6, kind: 'move', label: 'cursor' }],
    });
  });

  it('returns the same log object it persisted', () => {
    const logger = new ActionLogger(VIEWPORT, 'demo.webm');

    const returned = logger.save(temporaryFile());

    expect(returned.videoFile).toBe('demo.webm');
    expect(returned.viewport).toEqual(VIEWPORT);
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

function temporaryFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'action-logger-'));
  temporaryDirectories.push(dir);
  return path.join(dir, 'log.json');
}
