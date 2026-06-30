import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseOrExit, requireEnv, writeGithubOutput } from './run-cli.js';

const mockExit = (): ReturnType<typeof vi.spyOn> => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseOrExit', () => {
  it('returns the parsed value when the parser succeeds', () => {
    expect(parseOrExit(() => ({ origins: ['a'] }), [])).toEqual({ origins: ['a'] });
  });

  it('prints the error and exits(1) when the parser returns an error', () => {
    const exit = mockExit();

    expect(() => parseOrExit(() => ({ error: 'bad args' }), [])).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith('bad args');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('requireEnv', () => {
  it('returns the value when the env var is set', () => {
    expect(requireEnv('FOO', { FOO: 'bar' })).toBe('bar');
  });

  it('exits(1) when the env var is undefined', () => {
    const exit = mockExit();

    expect(() => requireEnv('FOO', {})).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('treats an empty-string env var as missing', () => {
    const exit = mockExit();

    expect(() => requireEnv('FOO', { FOO: '' })).toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('writeGithubOutput', () => {
  it('appends key=value lines to the output file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'run-cli-'));
    const file = path.join(dir, 'out.txt');
    try {
      writeGithubOutput(file, 'file', 'ops/r2/configure-cors.ts');
      writeGithubOutput(file, 'pre', '[]');
      expect(readFileSync(file, 'utf8')).toBe('file=ops/r2/configure-cors.ts\npre=[]\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
