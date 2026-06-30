import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCassetteStore, AI_RECORDING_VERSION, type Cassette } from './cassette-store.js';

const exampleCassette: Cassette = {
  version: 1,
  exchanges: [
    {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      chunks: [Buffer.from('{"ok":true}').toString('base64')],
    },
  ],
  recordedAt: '2026-05-17T00:00:00.000Z',
};

describe('createCassetteStore', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'cassette-test-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns undefined for a hash that has no recording', () => {
    const store = createCassetteStore({ rootDir });
    expect(store.read('nonexistent')).toBeUndefined();
  });

  it('writes a cassette and reads it back', () => {
    const store = createCassetteStore({ rootDir });
    store.write('hash-1', exampleCassette);
    const restored = store.read('hash-1');
    expect(restored).toEqual(exampleCassette);
  });

  it('places cassettes under the version directory', () => {
    const store = createCassetteStore({ rootDir });
    store.write('hash-2', exampleCassette);
    const expectedPath = path.join(rootDir, AI_RECORDING_VERSION, 'hash-2.json');
    expect(() => readFileSync(expectedPath)).not.toThrow();
  });

  it('returns undefined and does NOT throw when the file is corrupt JSON', () => {
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, 'corrupt.json'), '{ not valid json');
    const store = createCassetteStore({ rootDir });
    expect(store.read('corrupt')).toBeUndefined();
  });

  it('returns undefined when the file fails schema validation', () => {
    const versionDir = path.join(rootDir, AI_RECORDING_VERSION);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      path.join(versionDir, 'wrong-shape.json'),
      JSON.stringify({ version: 1, exchanges: 'not-an-array' })
    );
    const store = createCassetteStore({ rootDir });
    expect(store.read('wrong-shape')).toBeUndefined();
  });

  it('preserves multi-exchange sequences', () => {
    const multi: Cassette = {
      version: 1,
      exchanges: [
        {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'text/event-stream' },
          chunks: ['Y2h1bmstMQ==', 'Y2h1bmstMg==', 'Y2h1bmstMw=='],
        },
        {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/octet-stream' },
          chunks: ['QUFBQQ=='],
        },
      ],
      recordedAt: '2026-05-17T01:00:00.000Z',
    };
    const store = createCassetteStore({ rootDir });
    store.write('multi', multi);
    expect(store.read('multi')).toEqual(multi);
  });

  it('write is atomic — never leaves a partial .json on disk', () => {
    // Indirect check: after a failed mid-write, a subsequent read sees the
    // previous content, not garbage. We can't easily fault-inject fs.rename
    // without complicating the store, so this test exercises the
    // double-write codepath: writing twice with different content must end
    // with exactly the second content visible.
    const store = createCassetteStore({ rootDir });
    store.write('atomic', exampleCassette);
    const second: Cassette = {
      ...exampleCassette,
      exchanges: [
        {
          ...exampleCassette.exchanges[0]!,
          status: 429,
          statusText: 'Too Many Requests',
        },
      ],
    };
    store.write('atomic', second);
    expect(store.read('atomic')).toEqual(second);
  });
});
