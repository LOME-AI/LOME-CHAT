import { RatelimitedLinearError } from '@linear/sdk';
import { LINEAR_TEAM_KEY } from '@hushbox/shared/linear';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBoard, requireEnv, withBackoff } from './client.js';

import type {
  BoardSource,
  CommentNode,
  ConnectionLike,
  IssueNode,
  IssuePageVariables,
  LabelNode,
  ProjectNode,
  RunFunction,
  StateNode,
  StateRow,
} from './client.js';

/** Build a Relay-style connection over one or more pages, mimicking fetchNext accumulation. */
function conn<T>(pages: T[][]): ConnectionLike<T> {
  let index = 0;
  const make = (): ConnectionLike<T> => ({
    nodes: pages.slice(0, index + 1).flat(),
    pageInfo: { hasNextPage: index < pages.length - 1 },
    fetchNext: () => {
      index += 1;
      return Promise.resolve(make());
    },
  });
  return make();
}

function issueNode(overrides: Partial<IssueNode> = {}): IssueNode {
  return {
    id: 'iss-1',
    identifier: 'HUS-1',
    number: 1,
    title: 'Title',
    description: 'Desc',
    priority: 3,
    estimate: 2,
    url: 'https://linear.app/hus/issue/HUS-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    stateId: undefined,
    projectId: undefined,
    parentId: undefined,
    state: undefined,
    project: undefined,
    parent: undefined,
    labels: () => Promise.resolve(conn<LabelNode>([[]])),
    comments: () => Promise.resolve(conn<CommentNode>([[]])),
    ...overrides,
  };
}

function source(overrides: Partial<BoardSource> = {}): BoardSource {
  return {
    issues: () => Promise.resolve(conn<IssueNode>([[issueNode()]])),
    projects: () => Promise.resolve(conn<ProjectNode>([[]])),
    issueLabels: () => Promise.resolve(conn<LabelNode>([[]])),
    workflowStates: () => Promise.resolve(conn<StateRow>([[]])),
    ...overrides,
  };
}

const passthrough = <T>(function_: () => Promise<T>): Promise<T> => function_();

describe('withBackoff', () => {
  it('returns the result when the call succeeds', async () => {
    await expect(withBackoff(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it('sleeps retryAfter seconds and retries on a rate-limit error', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    const result = await withBackoff(() => {
      calls += 1;
      if (calls === 1) {
        const err = new RatelimitedLinearError();
        err.retryAfter = 3;
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    }, sleep);
    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toBe(2);
  });

  it('defaults to a one-second wait when retryAfter is absent', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    await withBackoff(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new RatelimitedLinearError());
      return Promise.resolve('ok');
    }, sleep);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('waits on the real timer when no sleep override is given', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = withBackoff(() => {
        calls += 1;
        if (calls === 1) {
          const err = new RatelimitedLinearError();
          err.retryAfter = 0;
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows a non-rate-limit error without retrying', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(withBackoff(() => Promise.reject(new Error('boom')), sleep)).rejects.toThrow(
      'boom'
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('requireEnv', () => {
  afterEach(() => {
    delete process.env['TEST_LINEAR_VAR'];
  });

  it('returns the value when the variable is set', () => {
    process.env['TEST_LINEAR_VAR'] = 'secret';
    expect(requireEnv('TEST_LINEAR_VAR')).toBe('secret');
  });

  it('throws a clear error when the variable is unset', () => {
    expect(() => requireEnv('TEST_LINEAR_VAR')).toThrow(/TEST_LINEAR_VAR/);
  });
});

describe('fetchBoard', () => {
  it('serializes an issue with its scalar fields and empty relations', async () => {
    const board = await fetchBoard(source(), passthrough);
    expect(typeof board.fetchedAt).toBe('string');
    expect(board.issues).toHaveLength(1);
    const issue = board.issues[0]!;
    expect(issue).toMatchObject({
      id: 'iss-1',
      title: 'Title',
      description: 'Desc',
      estimate: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      state: null,
      project: null,
      parent: null,
      labels: [],
      comments: [],
      commentsComplete: true,
      labelsComplete: true,
    });
    expect(board.pagination).toEqual({
      issues: true,
      projects: true,
      labels: true,
      workflowStates: true,
    });
  });

  it('resolves state, project, and parent relations when their ids are present', async () => {
    const node = issueNode({
      stateId: 'st-1',
      projectId: 'pr-1',
      parentId: 'iss-0',
      description: null,
      estimate: null,
      state: Promise.resolve({ name: 'In Progress', type: 'started' }),
      project: Promise.resolve({ id: 'pr-1', name: 'Core' }),
      parent: Promise.resolve({ id: 'iss-0', identifier: 'HUS-0' }),
    });
    const board = await fetchBoard(
      source({ issues: () => Promise.resolve(conn([[node]])) }),
      passthrough
    );
    const issue = board.issues[0]!;
    expect(issue.state).toEqual({ name: 'In Progress', type: 'started' });
    expect(issue.project).toEqual({ id: 'pr-1', name: 'Core' });
    expect(issue.parent).toEqual({ id: 'iss-0', identifier: 'HUS-0' });
    expect(issue.description).toBeNull();
    expect(issue.estimate).toBeNull();
  });

  it('treats a relation that resolves to undefined as null', async () => {
    const node = issueNode({
      stateId: 'st-1',
      state: Promise.resolve() as Promise<StateNode | undefined>,
    });
    const board = await fetchBoard(
      source({ issues: () => Promise.resolve(conn([[node]])) }),
      passthrough
    );
    expect(board.issues[0]!.state).toBeNull();
  });

  it('treats a relation getter that yields undefined as null', async () => {
    const node = issueNode({ stateId: 'st-1', state: undefined });
    const board = await fetchBoard(
      source({ issues: () => Promise.resolve(conn([[node]])) }),
      passthrough
    );
    expect(board.issues[0]!.state).toBeNull();
  });

  it('collects comments with author id and paginated labels', async () => {
    const node = issueNode({
      labels: () =>
        Promise.resolve(
          conn<LabelNode>([[{ id: 'l1', name: 'bug' }], [{ id: 'l2', name: 'groomed' }]])
        ),
      comments: () =>
        Promise.resolve(
          conn<CommentNode>([
            [
              {
                body: 'hi',
                url: 'https://linear.app/c/1',
                userId: 'user-9',
                createdAt: new Date('2026-03-03T00:00:00.000Z'),
              },
            ],
          ])
        ),
    });
    const board = await fetchBoard(
      source({ issues: () => Promise.resolve(conn([[node]])) }),
      passthrough
    );
    const issue = board.issues[0]!;
    expect(issue.labels).toEqual([
      { id: 'l1', name: 'bug' },
      { id: 'l2', name: 'groomed' },
    ]);
    expect(issue.comments).toEqual([
      {
        body: 'hi',
        url: 'https://linear.app/c/1',
        authorId: 'user-9',
        createdAt: '2026-03-03T00:00:00.000Z',
      },
    ]);
  });

  it('records a null author id for a comment without a user', async () => {
    const node = issueNode({
      comments: () =>
        Promise.resolve(
          conn<CommentNode>([
            [{ body: 'x', url: 'u', userId: undefined, createdAt: '2026-03-03T00:00:00.000Z' }],
          ])
        ),
    });
    const board = await fetchBoard(
      source({ issues: () => Promise.resolve(conn([[node]])) }),
      passthrough
    );
    expect(board.issues[0]!.comments[0]!.authorId).toBeNull();
  });

  it('paginates the top-level collections and maps them', async () => {
    const board = await fetchBoard(
      source({
        projects: () =>
          Promise.resolve(
            conn<ProjectNode>([[{ id: 'p1', name: 'One' }], [{ id: 'p2', name: 'Two' }]])
          ),
        issueLabels: () => Promise.resolve(conn<LabelNode>([[{ id: 'l1', name: 'bug' }]])),
        workflowStates: () =>
          Promise.resolve(conn<StateRow>([[{ id: 's1', name: 'Backlog', type: 'backlog' }]])),
      }),
      passthrough
    );
    expect(board.projects).toEqual([
      { id: 'p1', name: 'One' },
      { id: 'p2', name: 'Two' },
    ]);
    expect(board.labels).toEqual([{ id: 'l1', name: 'bug' }]);
    expect(board.workflowStates).toEqual([{ id: 's1', name: 'Backlog', type: 'backlog' }]);
  });

  it('scopes the issues fetch to the HUS team via the shared team key', async () => {
    let captured: IssuePageVariables | undefined;
    const scoped = source({
      issues: (variables) => {
        captured = variables;
        return Promise.resolve(conn<IssueNode>([[issueNode()]]));
      },
    });
    await fetchBoard(scoped, passthrough);
    expect(captured?.filter).toEqual({ team: { key: { eq: LINEAR_TEAM_KEY } } });
  });

  it('wraps every source call in the injected runner', async () => {
    let calls = 0;
    const run: RunFunction = (function_) => {
      calls += 1;
      return function_();
    };
    await fetchBoard(source(), run);
    expect(calls).toBeGreaterThan(0);
  });
});
