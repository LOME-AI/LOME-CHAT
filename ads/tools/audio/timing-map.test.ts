import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildWav } from './audio-fixtures.js';
import { fitVoiceovers, timingMapSchema, type TimingMap } from './timing-map.js';

function makeMap(scenes: unknown[]): TimingMap {
  return timingMapSchema.parse({ fps: 30, width: 1080, height: 1920, scenes });
}

const sixSeconds = (): number => 6;

const scene = {
  id: 's1',
  start: 3,
  duration: 5,
  line: 'Welcome to HushBox.',
  videoFile: 's1.mp4',
};

describe('timingMapSchema', () => {
  it('defaults VO placement to center', () => {
    const map = makeMap([{ ...scene, voFile: 'vo.wav' }]);
    expect(map.scenes[0]?.voPlacement).toBe('center');
  });

  it('rejects a map with no scenes', () => {
    expect(() => makeMap([])).toThrow();
  });

  it('rejects a scene whose start is negative', () => {
    expect(() => makeMap([{ ...scene, start: -1 }])).toThrow();
  });
});

describe('fitVoiceovers', () => {
  it('skips scenes that have no VO file', () => {
    const fits = fitVoiceovers(makeMap([scene]), () => 2);
    expect(fits).toHaveLength(0);
  });

  it('centers the VO within its slot', () => {
    const fits = fitVoiceovers(makeMap([{ ...scene, voFile: 'vo.wav' }]), () => 2);
    expect(fits[0]).toEqual({ sceneId: 's1', voSeconds: 2, slotSeconds: 5, voStart: 4.5 });
  });

  it('places the VO after a numeric lead-in', () => {
    const map = makeMap([{ ...scene, voFile: 'vo.wav', voPlacement: 1.5 }]);
    const fits = fitVoiceovers(map, () => 2);
    expect(fits[0]?.voStart).toBe(4.5);
  });

  it('throws when a VO take is longer than its slot', () => {
    const map = makeMap([{ ...scene, voFile: 'vo.wav' }]);
    expect(() => fitVoiceovers(map, sixSeconds)).toThrow(/regenerate the take/);
  });

  it('measures duration from disk when no resolver is injected', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'timing-'));
    temporaryDirectories.push(dir);
    const voFile = path.join(dir, 'vo.wav');
    writeFileSync(voFile, buildWav({ byteRate: 1000, dataSize: 2000 }));

    const fits = fitVoiceovers(makeMap([{ ...scene, voFile }]));

    expect(fits[0]?.voSeconds).toBe(2);
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});
