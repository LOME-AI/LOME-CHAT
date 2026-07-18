import { LINEAR_TEAM_ID } from '@hushbox/shared/linear';
import { describe, expect, it, vi } from 'vitest';

import { main } from './board.js';
import { groomedHash } from './validate.js';

import type { MainDeps } from './board.js';
import type { WriteSource } from './client.js';
import type { Backup, BackupIssue } from './schema.js';

function anIssue(over: Partial<BackupIssue> = {}): BackupIssue {
  return {
    id: 'x',
    identifier: 'HUS-9',
    number: 9,
    title: 't',
    description: null,
    priority: 0,
    estimate: null,
    url: 'u',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    stateId: null,
    projectId: null,
    parentId: null,
    state: { name: 'Todo', type: 'unstarted' },
    project: null,
    parent: null,
    labels: [],
    comments: [],
    commentsComplete: true,
    labelsComplete: true,
    ...over,
  };
}

function aBoard(issues: BackupIssue[]): Backup {
  return {
    fetchedAt: '2026-07-16T00:00:00.000Z',
    pagination: { issues: true, projects: true, labels: true, workflowStates: true },
    issues,
    projects: [],
    labels: [],
    workflowStates: [],
  };
}

function writeClient(over: Partial<WriteSource> = {}): WriteSource {
  return {
    updateIssue: vi.fn(() => Promise.resolve({ success: true })),
    createIssue: vi.fn(() => Promise.resolve({ success: true })),
    createComment: vi.fn(() => Promise.resolve({ success: true })),
    createProject: vi.fn(() => Promise.resolve({ success: true })),
    ...over,
  };
}

function deps(over: Partial<MainDeps> = {}): MainDeps {
  return {
    fetchBoard: () => Promise.resolve(aBoard([anIssue()])),
    writeFile: vi.fn(() => Promise.resolve()),
    writeClient: writeClient(),
    log: vi.fn(),
    ...over,
  };
}

describe('main dispatch', () => {
  it('rejects an unknown command', async () => {
    await expect(main(['frobnicate'], deps())).rejects.toThrow(/unknown command/i);
  });

  it('rejects a missing command', async () => {
    await expect(main([], deps())).rejects.toThrow(/command/i);
  });
});

describe('hash command', () => {
  it('prints the sha256 of title and description', async () => {
    const log = vi.fn();
    await main(['hash', '--title', 'Ti', '--description', 'De'], deps({ log }));
    expect(log).toHaveBeenCalledWith(groomedHash('Ti', 'De'));
  });

  it('does not fetch the board', async () => {
    const fetchBoard = vi.fn(() => Promise.resolve(aBoard([anIssue()])));
    await main(['hash', '--title', 'a', '--description', 'b'], deps({ fetchBoard }));
    expect(fetchBoard).not.toHaveBeenCalled();
  });

  it('rejects a missing title', async () => {
    await expect(main(['hash', '--description', 'b'], deps())).rejects.toThrow(/--title/);
  });

  it('rejects a missing description', async () => {
    await expect(main(['hash', '--title', 'a'], deps())).rejects.toThrow(/--description/);
  });
});

describe('count-ungroomed command', () => {
  it('prints the ungroomed count from the fetched board', async () => {
    const log = vi.fn();
    const board = aBoard([anIssue(), anIssue({ id: 'y', labels: [{ id: 'l', name: 'groomed' }] })]);
    await main(['count-ungroomed'], deps({ fetchBoard: () => Promise.resolve(board), log }));
    expect(log).toHaveBeenCalledWith('1');
  });
});

describe('backup command', () => {
  it('writes the serialized board to the out file', async () => {
    const writeFile = vi.fn<MainDeps['writeFile']>(() => Promise.resolve());
    await main(['backup', '--out', 'out/board.json'], deps({ writeFile }));
    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0]!;
    expect(call[0]).toBe('out/board.json');
    const parsed = JSON.parse(call[1]) as Backup;
    expect(parsed.issues).toHaveLength(1);
  });

  it('rejects a missing out flag', async () => {
    await expect(main(['backup'], deps())).rejects.toThrow(/--out/);
  });

  it('fails on a shrink below prev-count without allow-shrink', async () => {
    await expect(
      main(['backup', '--out', 'out/b.json', '--prev-count', '5'], deps())
    ).rejects.toThrow(/shrink|prev/i);
  });

  it('still writes the file before failing validation', async () => {
    const writeFile = vi.fn(() => Promise.resolve());
    await expect(
      main(['backup', '--out', 'out/b.json', '--prev-count', '5'], deps({ writeFile }))
    ).rejects.toThrow();
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('permits a shrink when allow-shrink is passed', async () => {
    const log = vi.fn();
    await main(
      ['backup', '--out', 'out/b.json', '--prev-count', '5', '--allow-shrink'],
      deps({ log })
    );
    expect(log).toHaveBeenCalled();
  });

  it('passes when the count meets prev-count', async () => {
    const writeFile = vi.fn(() => Promise.resolve());
    await main(['backup', '--out', 'out/b.json', '--prev-count', '1'], deps({ writeFile }));
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-numeric prev-count', async () => {
    await expect(
      main(['backup', '--out', 'out/b.json', '--prev-count', 'lots'], deps())
    ).rejects.toThrow(/prev-count/);
  });
});

describe('update-issue command', () => {
  it('maps flags to an additive-label update and reports success', async () => {
    const updateIssue = vi.fn(() => Promise.resolve({ success: true }));
    const log = vi.fn();
    await main(
      [
        'update-issue',
        '--id',
        'iss-1',
        '--title',
        'New',
        '--description',
        'Body',
        '--estimate',
        '3',
        '--priority',
        'high',
        '--add-label',
        'la',
        '--add-label',
        'lb',
        '--remove-label',
        'lc',
        '--project',
        'pr-1',
        '--state',
        'st-1',
      ],
      deps({ writeClient: writeClient({ updateIssue }), log })
    );
    expect(updateIssue).toHaveBeenCalledWith('iss-1', {
      title: 'New',
      description: 'Body',
      estimate: 3,
      priority: 2,
      projectId: 'pr-1',
      stateId: 'st-1',
      addedLabelIds: ['la', 'lb'],
      removedLabelIds: ['lc'],
    });
  });

  it('never sends the full-replace labelIds field', async () => {
    const updateIssue = vi.fn<WriteSource['updateIssue']>(() => Promise.resolve({ success: true }));
    await main(
      ['update-issue', '--id', 'iss-1', '--add-label', 'la'],
      deps({ writeClient: writeClient({ updateIssue }) })
    );
    const input = updateIssue.mock.calls[0]![1];
    expect(input).not.toHaveProperty('labelIds');
    expect(input).toEqual({ addedLabelIds: ['la'] });
  });

  it('rejects an unknown priority name', async () => {
    await expect(
      main(['update-issue', '--id', 'iss-1', '--priority', 'critical'], deps())
    ).rejects.toThrow(/priority/i);
  });

  it('rejects a non-integer estimate', async () => {
    await expect(
      main(['update-issue', '--id', 'iss-1', '--estimate', 'big'], deps())
    ).rejects.toThrow(/estimate/i);
  });

  it('throws when the write reports success false', async () => {
    const updateIssue = vi.fn(() => Promise.resolve({ success: false }));
    await expect(
      main(
        ['update-issue', '--id', 'iss-1', '--title', 'x'],
        deps({ writeClient: writeClient({ updateIssue }) })
      )
    ).rejects.toThrow(/failed/i);
  });

  it('writes nothing under --dry-run and logs the intended call', async () => {
    const updateIssue = vi.fn(() => Promise.resolve({ success: true }));
    const log = vi.fn();
    await main(
      ['update-issue', '--id', 'iss-1', '--title', 'x', '--dry-run'],
      deps({ writeClient: writeClient({ updateIssue }), log })
    );
    expect(updateIssue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dry-run/i));
  });

  it('rejects a missing id', async () => {
    await expect(main(['update-issue', '--title', 'x'], deps())).rejects.toThrow(/--id/);
  });
});

describe('create-issue command', () => {
  it('supplies the HUS team id and maps labels to labelIds', async () => {
    const createIssue = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      [
        'create-issue',
        '--title',
        'Fresh',
        '--label',
        'la',
        '--label',
        'lb',
        '--priority',
        'urgent',
      ],
      deps({ writeClient: writeClient({ createIssue }) })
    );
    expect(createIssue).toHaveBeenCalledWith({
      teamId: LINEAR_TEAM_ID,
      title: 'Fresh',
      priority: 1,
      labelIds: ['la', 'lb'],
    });
  });

  it('maps every optional field when provided', async () => {
    const createIssue = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      [
        'create-issue',
        '--title',
        'T',
        '--description',
        'D',
        '--estimate',
        '5',
        '--priority',
        'low',
        '--project',
        'pr-1',
        '--state',
        'st-1',
        '--label',
        'la',
      ],
      deps({ writeClient: writeClient({ createIssue }) })
    );
    expect(createIssue).toHaveBeenCalledWith({
      teamId: LINEAR_TEAM_ID,
      title: 'T',
      description: 'D',
      estimate: 5,
      priority: 4,
      projectId: 'pr-1',
      stateId: 'st-1',
      labelIds: ['la'],
    });
  });

  it('rejects a label flag with no value', async () => {
    await expect(main(['update-issue', '--id', 'iss-1', '--add-label'], deps())).rejects.toThrow(
      /add-label/
    );
  });

  it('throws when the write reports success false', async () => {
    const createIssue = vi.fn(() => Promise.resolve({ success: false }));
    await expect(
      main(['create-issue', '--title', 'x'], deps({ writeClient: writeClient({ createIssue }) }))
    ).rejects.toThrow(/failed/i);
  });

  it('writes nothing under --dry-run', async () => {
    const createIssue = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      ['create-issue', '--title', 'x', '--dry-run'],
      deps({ writeClient: writeClient({ createIssue }) })
    );
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('rejects a missing title', async () => {
    await expect(main(['create-issue'], deps())).rejects.toThrow(/--title/);
  });
});

describe('create-comment command', () => {
  it('creates a comment on the given issue', async () => {
    const createComment = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      ['create-comment', '--issue', 'iss-1', '--body', 'hello'],
      deps({ writeClient: writeClient({ createComment }) })
    );
    expect(createComment).toHaveBeenCalledWith({ issueId: 'iss-1', body: 'hello' });
  });

  it('throws when the write reports success false', async () => {
    const createComment = vi.fn(() => Promise.resolve({ success: false }));
    await expect(
      main(
        ['create-comment', '--issue', 'iss-1', '--body', 'x'],
        deps({ writeClient: writeClient({ createComment }) })
      )
    ).rejects.toThrow(/failed/i);
  });

  it('writes nothing under --dry-run', async () => {
    const createComment = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      ['create-comment', '--issue', 'iss-1', '--body', 'x', '--dry-run'],
      deps({ writeClient: writeClient({ createComment }) })
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it('logs the comment body under --dry-run', async () => {
    const log = vi.fn();
    await main(
      ['create-comment', '--issue', 'iss-1', '--body', 'review-note-body', '--dry-run'],
      deps({ log })
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('review-note-body'));
  });

  it('rejects a missing body', async () => {
    await expect(main(['create-comment', '--issue', 'iss-1'], deps())).rejects.toThrow(/--body/);
  });
});

describe('create-project command', () => {
  it('supplies the HUS team id and optional description', async () => {
    const createProject = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      ['create-project', '--name', 'Roadmap', '--description', 'Plan'],
      deps({ writeClient: writeClient({ createProject }) })
    );
    expect(createProject).toHaveBeenCalledWith({
      name: 'Roadmap',
      teamIds: [LINEAR_TEAM_ID],
      description: 'Plan',
    });
  });

  it('throws when the write reports success false', async () => {
    const createProject = vi.fn(() => Promise.resolve({ success: false }));
    await expect(
      main(['create-project', '--name', 'x'], deps({ writeClient: writeClient({ createProject }) }))
    ).rejects.toThrow(/failed/i);
  });

  it('writes nothing under --dry-run', async () => {
    const createProject = vi.fn(() => Promise.resolve({ success: true }));
    await main(
      ['create-project', '--name', 'x', '--dry-run'],
      deps({ writeClient: writeClient({ createProject }) })
    );
    expect(createProject).not.toHaveBeenCalled();
  });

  it('rejects a missing name', async () => {
    await expect(main(['create-project'], deps())).rejects.toThrow(/--name/);
  });
});
