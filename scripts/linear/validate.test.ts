import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { countUngroomed, groomedHash, validateBackup } from './validate.js';

import type { Backup, BackupIssue } from './schema.js';

function issue(overrides: Partial<BackupIssue> = {}): BackupIssue {
  return {
    id: 'iss-1',
    identifier: 'HUS-1',
    number: 1,
    title: 'A title',
    description: 'A description',
    priority: 3,
    estimate: 2,
    url: 'https://linear.app/hus/issue/HUS-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    stateId: 'st-backlog',
    projectId: null,
    parentId: null,
    state: { name: 'Backlog', type: 'backlog' },
    project: null,
    parent: null,
    labels: [],
    comments: [],
    commentsComplete: true,
    labelsComplete: true,
    ...overrides,
  };
}

function backup(overrides: Partial<Backup> = {}): Backup {
  return {
    fetchedAt: '2026-07-16T00:00:00.000Z',
    pagination: { issues: true, projects: true, labels: true, workflowStates: true },
    issues: [issue()],
    projects: [],
    labels: [],
    workflowStates: [{ id: 'st-backlog', name: 'Backlog', type: 'backlog' }],
    ...overrides,
  };
}

describe('groomedHash', () => {
  it('hashes title and description joined by a newline with sha256 hex', () => {
    const expected = createHash('sha256').update('T\nD').digest('hex');
    expect(groomedHash('T', 'D')).toBe(expected);
  });
});

describe('validateBackup', () => {
  it('returns the decoded board for a valid backup', () => {
    const result = validateBackup(backup(), {});
    expect(result.issues).toHaveLength(1);
  });

  it('rejects a payload that does not match the schema', () => {
    expect(() => validateBackup({ nope: true }, {})).toThrow();
  });

  it('rejects an empty issue set', () => {
    expect(() => validateBackup(backup({ issues: [] }), {})).toThrow(/no issues/i);
  });

  it('rejects an issue missing a title', () => {
    expect(() => validateBackup(backup({ issues: [issue({ title: '' })] }), {})).toThrow(
      /id\+title|title/i
    );
  });

  it('rejects an issue missing an id', () => {
    expect(() => validateBackup(backup({ issues: [issue({ id: '' })] }), {})).toThrow(/id/i);
  });

  it('rejects incomplete top-level pagination', () => {
    expect(() =>
      validateBackup(
        backup({
          pagination: { issues: false, projects: true, labels: true, workflowStates: true },
        }),
        {}
      )
    ).toThrow(/pagination/i);
  });

  it('rejects incomplete per-issue comment pagination', () => {
    expect(() =>
      validateBackup(backup({ issues: [issue({ commentsComplete: false })] }), {})
    ).toThrow(/pagination/i);
  });

  it('rejects incomplete per-issue label pagination', () => {
    expect(() =>
      validateBackup(backup({ issues: [issue({ labelsComplete: false })] }), {})
    ).toThrow(/pagination/i);
  });

  it('rejects a shrink below prevCount when allowShrink is not set', () => {
    expect(() => validateBackup(backup(), { prevCount: 5 })).toThrow(/shrink|prev/i);
  });

  it('permits a shrink below prevCount when allowShrink is set', () => {
    expect(validateBackup(backup(), { prevCount: 5, allowShrink: true }).issues).toHaveLength(1);
  });

  it('permits an issue count equal to prevCount', () => {
    expect(validateBackup(backup(), { prevCount: 1 }).issues).toHaveLength(1);
  });
});

describe('countUngroomed', () => {
  it('counts active issues that lack a groomed label', () => {
    const board = backup({ issues: [issue(), issue({ id: 'iss-2' })] });
    expect(countUngroomed(board)).toBe(2);
  });

  it('excludes completed and canceled issues', () => {
    const board = backup({
      issues: [
        issue({ id: 'a', state: { name: 'Done', type: 'completed' } }),
        issue({ id: 'b', state: { name: 'Canceled', type: 'canceled' } }),
        issue({ id: 'c', state: { name: 'Todo', type: 'unstarted' } }),
      ],
    });
    expect(countUngroomed(board)).toBe(1);
  });

  it('excludes issues already carrying the groomed label', () => {
    const board = backup({
      issues: [issue({ id: 'a', labels: [{ id: 'l1', name: 'groomed' }] }), issue({ id: 'b' })],
    });
    expect(countUngroomed(board)).toBe(1);
  });

  it('treats a null state as active', () => {
    const board = backup({ issues: [issue({ state: null })] });
    expect(countUngroomed(board)).toBe(1);
  });
});
