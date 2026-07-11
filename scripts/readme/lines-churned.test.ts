import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execaSync } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countLinesChurned, resolveNumstatPath, sumNumstatChurn } from './lines-churned.js';

describe('resolveNumstatPath', () => {
  it('returns a plain path unchanged', () => {
    expect(resolveNumstatPath('apps/web/src/main.tsx')).toBe('apps/web/src/main.tsx');
  });

  it('resolves a braced rename to the new path', () => {
    expect(resolveNumstatPath('apps/api/src/{adapters => domain}/keys.ts')).toBe(
      'apps/api/src/domain/keys.ts'
    );
  });

  it('resolves a braced rename spanning multiple segments', () => {
    expect(resolveNumstatPath('apps/api/{adapters/auth.ts => domain/rate-limit.ts}')).toBe(
      'apps/api/domain/rate-limit.ts'
    );
  });

  it('resolves a rename into a new subdirectory', () => {
    expect(resolveNumstatPath('apps/{ => web}/main.ts')).toBe('apps/web/main.ts');
  });

  it('resolves a rename that removes a subdirectory', () => {
    expect(resolveNumstatPath('apps/{web => }/main.ts')).toBe('apps/main.ts');
  });

  it('resolves a bare whole-path rename to the new path', () => {
    expect(resolveNumstatPath('old-name.ts => scripts/new-name.ts')).toBe('scripts/new-name.ts');
  });
});

describe('sumNumstatChurn', () => {
  it('sums additions and deletions across lines', () => {
    expect(sumNumstatChurn('3\t1\ta.ts\n10\t2\tb.tsx\n')).toBe(16);
  });

  it('skips blank lines between commits', () => {
    expect(sumNumstatChurn('3\t1\ta.ts\n\n\n2\t0\tb.ts\n')).toBe(6);
  });

  it('skips binary files', () => {
    expect(sumNumstatChurn('3\t1\ta.ts\n-\t-\tlogo.png\n')).toBe(4);
  });

  it('skips files with unlisted extensions', () => {
    expect(sumNumstatChurn('3\t1\ta.ts\n50\t0\tfont.woff2\n')).toBe(4);
  });

  it('skips files under ignored directories', () => {
    expect(sumNumstatChurn('3\t1\ta.ts\n500\t0\tnode_modules/pkg/index.ts\n')).toBe(4);
  });

  it('skips lockfiles and generated files', () => {
    expect(
      sumNumstatChurn('3\t1\ta.ts\n900\t0\tpnpm-lock.yaml\n5\t0\tsrc/routeTree.gen.ts\n')
    ).toBe(4);
  });

  it('filters renamed files by their post-rename path', () => {
    expect(sumNumstatChurn('7\t2\tsrc/{legacy => current}/a.ts\n')).toBe(9);
    expect(sumNumstatChurn('7\t2\t{src => node_modules}/a.ts\n')).toBe(0);
  });

  it('skips lines that are not numstat rows', () => {
    expect(sumNumstatChurn('not-a-numstat-row\n2\t3\n3\t1\ta.ts\n')).toBe(4);
  });

  it('returns zero for empty output', () => {
    expect(sumNumstatChurn('')).toBe(0);
  });
});

describe('countLinesChurned', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'lines-churned-test-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function git(directory: string, ...gitArguments: string[]): void {
    execaSync('git', ['-C', directory, ...gitArguments]);
  }

  function commitAll(directory: string, message: string): void {
    git(directory, 'add', '--all');
    git(
      directory,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      message
    );
  }

  function write(relativePath: string, contents: string): void {
    const absolute = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  it('throws a clear error when the directory is not a git repository', () => {
    expect(() => countLinesChurned(rootDir)).toThrow(/not a git repository/);
  });

  it('returns zero for a repository with no commits', () => {
    git(rootDir, 'init', '--quiet');

    expect(countLinesChurned(rootDir)).toBe(0);
  });

  it('counts lines added and deleted across commits', () => {
    git(rootDir, 'init', '--quiet');
    write('a.ts', 'one\ntwo\nthree\n');
    commitAll(rootDir, 'add three lines');
    write('a.ts', 'one\ntwo\n');
    commitAll(rootDir, 'delete one line');

    // 3 added in the first commit + 1 deleted in the second.
    expect(countLinesChurned(rootDir)).toBe(4);
  });

  it('excludes files the source-line count also excludes', () => {
    git(rootDir, 'init', '--quiet');
    write('a.ts', 'one\n');
    write('pnpm-lock.yaml', 'x\ny\nz\n');
    write('node_modules/pkg/index.ts', 'x\ny\n');
    commitAll(rootDir, 'mixed content');

    expect(countLinesChurned(rootDir)).toBe(1);
  });

  it('does not count a pure rename as churn', () => {
    git(rootDir, 'init', '--quiet');
    write('old.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
    commitAll(rootDir, 'add file');
    const before = countLinesChurned(rootDir);
    git(rootDir, 'mv', 'old.ts', 'new.ts');
    commitAll(rootDir, 'rename file');

    expect(countLinesChurned(rootDir)).toBe(before);
  });

  it('fails fast on a shallow clone', () => {
    git(rootDir, 'init', '--quiet');
    write('a.ts', 'one\n');
    commitAll(rootDir, 'first');
    write('a.ts', 'one\ntwo\n');
    commitAll(rootDir, 'second');
    const cloneDir = mkdtempSync(path.join(tmpdir(), 'lines-churned-shallow-'));
    try {
      execaSync('git', ['clone', '--quiet', '--depth', '1', `file://${rootDir}`, cloneDir]);

      expect(() => countLinesChurned(cloneDir)).toThrow(/shallow/);
    } finally {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });
});
